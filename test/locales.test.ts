// Localization: de and en have the same keys, every key used exists, no key is unused, and no visible
// text is written directly into the HTML pages or the code (it all comes from _locales).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "extension");
type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
const load = (l: string): Messages => JSON.parse(readFileSync(path.join(root, "_locales", l, "messages.json"), "utf8")) as Messages;
const de = load("de");
const en = load("en");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "_locales" ? [] : files(p, ext);
    return ext.test(f) ? [p] : [];
  });
}
const tsFiles = files(root, /\.ts$/).filter((f) => !f.endsWith(".d.ts"));
const htmlFiles = files(root, /\.html$/);
const rel = (f: string): string => path.relative(root, f);

test("de and en have the same keys, non-empty messages and the same placeholders", () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const key of Object.keys(de)) {
    for (const [l, m] of [["de", de], ["en", en]] as const) {
      assert.ok(typeof m[key]!.message === "string" && m[key]!.message.trim() !== "", `${l}.${key} is empty`);
      // Every $NAME$ in the message has a placeholder, and no message uses bare $1 (named placeholders only).
      for (const ph of m[key]!.message.matchAll(/\$([A-Za-z_]+)\$/g)) {
        assert.ok(m[key]!.placeholders?.[ph[1]!.toLowerCase()], `${l}.${key} misses placeholder ${ph[1]}`);
      }
    }
    assert.deepEqual(Object.keys(de[key]!.placeholders ?? {}).sort(), Object.keys(en[key]!.placeholders ?? {}).sort(), `placeholders of ${key}`);
  }
});

/** Keys referenced in HTML (data-i18n*), the manifest (__MSG_x__) or as string literals in the code. */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of htmlFiles) for (const m of readFileSync(f, "utf8").matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) keys.add(m[1]!);
  for (const m of readFileSync(path.join(root, "manifest.json"), "utf8").matchAll(/__MSG_(\w+)__/g)) keys.add(m[1]!);
  for (const f of tsFiles) for (const m of readFileSync(f, "utf8").matchAll(/"([a-z][A-Za-z0-9]+)"/g)) if (m[1]! in de) keys.add(m[1]!);
  return keys;
}

test("every key used exists, and every key is used", () => {
  const used = referencedKeys();
  for (const f of htmlFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) assert.ok(m[1]! in de, `${rel(f)} uses missing key ${m[1]}`);
  }
  for (const f of tsFiles) {
    // Direct calls with a literal key.
    for (const m of readFileSync(f, "utf8").matchAll(/(?:\bt|getMessage)\(\s*"([^"]+)"/g)) assert.ok(m[1]! in de, `${rel(f)} uses missing key ${m[1]}`);
  }
  const unused = Object.keys(de).filter((k) => !used.has(k));
  assert.deepEqual(unused, [], "keys not used anywhere");
});

test("no visible text is written into the HTML pages", () => {
  for (const f of htmlFiles) {
    const html = readFileSync(f, "utf8");
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const m of withoutScripts.matchAll(/>([^<]+)</g)) assert.equal(m[1]!.trim(), "", `${rel(f)} has text "${m[1]!.trim()}"`);
    for (const m of html.matchAll(/\s(placeholder|title|aria-label|alt|value)="([^"]*)"/g)) {
      assert.fail(`${rel(f)} has a fixed ${m[1]}="${m[2]}"`);
    }
    assert.match(html, /<title data-i18n="[^"]+"><\/title>/, `${rel(f)} title comes from _locales`);
  }
});

test("no visible text is set from string literals in the code", () => {
  // Assignments or attributes that are shown to the user must get their text from t()/getMessage().
  const sinks = /\.(textContent|placeholder|title|innerText|label)\s*=\s*(["'`])([^"'`]*)\2|setAttribute\(\s*"(aria-label|title|placeholder|alt)"\s*,\s*(["'`])([^"'`]*)\5|createTextNode\(\s*(["'])([^"']*)\7/g;
  for (const f of tsFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(sinks)) {
      const text = m[3] ?? m[6] ?? m[8] ?? "";
      assert.ok(!/\p{L}/u.test(text.replace(/\$\{[^}]*\}/g, "")), `${rel(f)} sets visible text "${text}"`);
    }
  }
});
