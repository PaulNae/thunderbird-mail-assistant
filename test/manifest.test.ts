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
  assert.equal(gecko["id"], "mail-assistant@paulnae.github.io");
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

test("every file referenced by the manifest exists in dist", () => {
  const refs: string[] = [];
  const icons = (v: unknown): void => {
    if (typeof v === "string") refs.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(icons);
  };
  icons(manifest["icons"]);
  for (const key of ["compose_action", "message_display_action"]) {
    const action = manifest[key] as { default_popup: string; default_icon: unknown };
    assert.ok(action, `${key} missing`);
    refs.push(action.default_popup);
    icons(action.default_icon);
  }
  const action = manifest["action"] as { default_popup?: string; default_icon: unknown } | undefined;
  assert.ok(action, "action missing");
  // The action opens the chat tab via onClicked, which does not fire if the action has a popup.
  assert.equal(action.default_popup, undefined);
  icons(action.default_icon);
  refs.push("chat/chat.html", "chat/chat.js");
  for (const r of refs) assert.ok(existsSync(path.join(dist, r)), `${r} missing`);
});

test("data-i18n keys exist in both locales and locales have identical keys", () => {
  const de = readJson("_locales/de/messages.json");
  const en = readJson("_locales/en/messages.json");
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const page of ["compose/popup.html", "display/popup.html", "chat/chat.html"]) {
    const html = readFileSync(path.join(dist, page), "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1] as string);
    assert.ok(keys.length > 0, `${page} has no data-i18n`);
    for (const key of keys) {
      assert.ok(key in de, `de misses ${key}`);
      assert.ok(key in en, `en misses ${key}`);
    }
    const script = /<script[^>]*src="([^"]+)"/.exec(html)?.[1];
    assert.ok(script && existsSync(path.join(dist, path.dirname(page), script)), `${page} script missing`);
  }
});

test("nativeMessaging permission is requested", () => {
  assert.ok((manifest["permissions"] as string[]).includes("nativeMessaging"));
});

test("scripting and compose permissions are requested", () => {
  const permissions = manifest["permissions"] as string[];
  assert.ok(permissions.includes("scripting"));
  assert.ok(permissions.includes("compose"));
  assert.ok(permissions.includes("messagesRead"));
  assert.ok(permissions.includes("accountsRead"));
});
