import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { API_KEY_KEY, normalizeApiKey, readApiKey, removeApiKey, writeApiKey } from "../extension/shared/api-key.ts";

class FakeLocal {
  data = new Map<string, unknown>();
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys]) if (this.data.has(k)) out[k] = this.data.get(k);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

test("only plausible keys are stored, trimmed, under their own storage key", async () => {
  assert.equal(normalizeApiKey("  sk-ant-api03-abcdef  "), "sk-ant-api03-abcdef");
  for (const bad of ["", "short", "sk ant with spaces", "sk-ant-äöü-123456", 42, null, "x".repeat(513)]) assert.equal(normalizeApiKey(bad), null, String(bad));
  const area = new FakeLocal();
  assert.equal(await readApiKey(area), undefined);
  assert.equal(await writeApiKey(area, "nope"), false);
  assert.equal(area.data.size, 0);
  assert.equal(await writeApiKey(area, " sk-ant-api03-abcdef\n"), true);
  assert.deepEqual([...area.data.keys()], [API_KEY_KEY]);
  assert.equal(await readApiKey(area), "sk-ant-api03-abcdef");
  await removeApiKey(area);
  assert.equal(await readApiKey(area), undefined);
  area.data.set(API_KEY_KEY, { not: "a key" });
  assert.equal(await readApiKey(area), undefined);
});

const root = path.resolve(import.meta.dirname, "..", "extension");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });
}

test("the key is never logged, never in storage.sync and only sent to api.anthropic.com", () => {
  for (const f of files(root)) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/messenger\.storage\.sync/.test(src), `${f} uses storage.sync`);
    // No console output in files that handle the key.
    if (/readApiKey|getKey|apiHeaders/.test(src)) assert.ok(!/console\.(log|info|warn|error|debug)\([^)]*(key|Key)/.test(src), `${f} may log the key`);
  }
  const api = readFileSync(path.join(root, "backend", "api-backend.ts"), "utf8");
  const urls = [...api.matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)], ["https://api.anthropic.com"]);
});
