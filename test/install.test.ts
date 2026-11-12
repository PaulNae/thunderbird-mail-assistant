import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error plain JS module without type declarations
import * as installer from "../host/install-macos.mjs";

const script = path.resolve(import.meta.dirname, "..", "host", "install-macos.mjs");
const extManifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "..", "extension", "manifest.json"), "utf8"),
);

test("shQuote escapes single quotes and keeps spaces", () => {
  assert.equal(installer.shQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(installer.shQuote("/plain"), "'/plain'");
});

test("buildLauncher and buildManifest produce expected text", () => {
  const text = installer.buildLauncher({ claudePath: "/x/cl'aude", nodePath: "/n d/node", hostScript: "/h/host.mjs" });
  assert.equal(
    text,
    `#!/bin/sh\nexport MAIL_ASSISTANT_CLAUDE='/x/cl'\\''aude'\nexec '/n d/node' '/h/host.mjs' "$@"\n`,
  );
  const m = installer.buildManifest({ launcherPath: "/l.sh", extensionId: "a@b" });
  assert.deepEqual(m, {
    name: "mail_assistant",
    description: m.description,
    path: "/l.sh",
    type: "stdio",
    allowed_extensions: ["a@b"],
  });
  assert.match(m.name, /^\w+(\.\w+)*$/);
});

test("installer writes manifest and executable launcher, uninstall removes them", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "install-test-"));
  try {
    const installDir = path.join(tmp, "install dir");
    const launcher = path.join(installDir, "launcher.sh");
    const dir = path.join(tmp, "nmh");
    const base = ["--manifest-dir", dir, "--install-dir", installDir];
    execFileSync(process.execPath, [script, ...base, "--claude", process.execPath], { stdio: "pipe" });

    const manifest = JSON.parse(readFileSync(path.join(dir, "mail_assistant.json"), "utf8"));
    assert.equal(manifest.name, "mail_assistant");
    assert.equal(manifest.type, "stdio");
    assert.ok(path.isAbsolute(manifest.path));
    assert.equal(manifest.path, launcher);
    assert.deepEqual(manifest.allowed_extensions, [extManifest.browser_specific_settings.gecko.id]);
    accessSync(launcher, constants.X_OK);
    const text = readFileSync(launcher, "utf8");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.ok(text.includes(installer.shQuote(path.join(installDir, "host.mjs"))));
    assert.equal(
      readFileSync(path.join(installDir, "host.mjs"), "utf8"),
      readFileSync(path.resolve(import.meta.dirname, "..", "host", "host.mjs"), "utf8"),
    );

    execFileSync(process.execPath, [script, ...base, "--uninstall"], { stdio: "pipe" });
    assert.equal(existsSync(path.join(dir, "mail_assistant.json")), false);
    assert.equal(existsSync(launcher), false);
    assert.equal(existsSync(path.join(installDir, "host.mjs")), false);
    assert.equal(existsSync(installDir), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("installer fails for a non-executable --claude path", () => {
  assert.throws(() =>
    execFileSync(process.execPath, [script, "--manifest-dir", os.tmpdir(), "--print", "--claude", "/nonexistent/claude"], { stdio: "pipe" }),
  );
});
