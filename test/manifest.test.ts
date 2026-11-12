import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "..", "dist");
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dist, rel), "utf8"));

const manifest = readJson("manifest.json");

test("manifest is MV3 with a pinned minimum Thunderbird version", () => {
  assert.equal(manifest["manifest_version"], 3);
  const gecko = (manifest["browser_specific_settings"] as { gecko: Record<string, string> }).gecko;
  assert.ok(gecko["id"]);
  assert.ok(gecko["strict_min_version"]);
});

test("every __MSG_x__ key exists in all locales", () => {
  const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1] as string);
  assert.ok(keys.length > 0);
  for (const locale of ["de", "en"]) {
    const messages = readJson(`_locales/${locale}/messages.json`);
    for (const key of keys) assert.ok(key in messages, `${locale} misses ${key}`);
  }
});

test("background.scripts point to existing files", () => {
  const scripts = (manifest["background"] as { scripts: string[] }).scripts;
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.ok(existsSync(path.join(dist, s)), `${s} missing`);
});
