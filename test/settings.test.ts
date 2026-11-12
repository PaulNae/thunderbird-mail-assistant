import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODELS,
  LEGACY_MAX_MESSAGES_KEY,
  MAX_MESSAGES_BOUNDS,
  MAX_TEXT_BOUNDS,
  SETTINGS_KEY,
  TIMEOUT_BOUNDS,
  defaultSettings,
  settleBackendChoice,
  modelForKind,
  readSettings,
  sanitizeSettings,
  searchLimits,
  threadLimits,
  writeSettings,
} from "../extension/shared/settings.ts";
import { DRAFT_MODEL, REWRITE_MODEL } from "../extension/prompts/compose.ts";
import { QUESTION_MODEL, SUMMARY_MODEL } from "../extension/prompts/read.ts";
import { QUERY_ANSWER_MODEL } from "../extension/prompts/query.ts";
import { MAX_MESSAGE_CHARS } from "../extension/mail/thread-select.ts";
import { QUERY_MAX_MESSAGE_CHARS } from "../extension/mail/search-select.ts";
import { toCheckResponse, parseCheckResponse, parseRuntimeRequest } from "../extension/shared/messages.ts";

class FakeLocal {
  data = new Map<string, unknown>();
  fail = false;
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (this.fail) throw new Error("x");
    const out: Record<string, unknown> = {};
    for (const k of keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys]) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

test("model and limit defaults are the previous constants; the text limit is the former thread budget", () => {
  assert.deepEqual(DEFAULT_MODELS, { rewrite: REWRITE_MODEL, draft: DRAFT_MODEL, summary: SUMMARY_MODEL, question: QUESTION_MODEL, query: QUERY_ANSWER_MODEL });
  assert.deepEqual(DEFAULT_MODELS, { rewrite: "haiku", draft: "sonnet", summary: "haiku", question: "sonnet", query: "sonnet" });
  const d = defaultSettings();
  assert.equal(d.maxMessages, 15);
  assert.equal(d.timeoutSec, 120);
  // One text limit replaces three constants (thread 40 000, own text and original 30 000, hits 50 000).
  assert.equal(d.maxTextChars, 40000);
  assert.equal(MAX_TEXT_BOUNDS.def, 40000);
});

test("anything unusable falls back to the default; numbers are clamped and rounded", () => {
  for (const raw of [undefined, null, 5, "x", [], { models: "x" }, { models: { rewrite: "gpt-4", draft: 3, summary: "Opus", question: "--help" } }]) {
    assert.deepEqual(sanitizeSettings(raw), defaultSettings(), JSON.stringify(raw));
  }
  const s = sanitizeSettings({ models: { rewrite: "opus", query: "haiku", extra: "opus" }, maxMessages: 999, maxTextChars: 1, timeoutSec: "90.4", foo: 1 });
  assert.equal(s.models.rewrite, "opus");
  assert.equal(s.models.query, "haiku");
  assert.equal(s.models.summary, "haiku");
  assert.equal(s.maxMessages, MAX_MESSAGES_BOUNDS.max);
  assert.equal(s.maxTextChars, MAX_TEXT_BOUNDS.min);
  assert.equal(s.timeoutSec, 90);
  assert.ok(!("foo" in s));
  assert.equal(sanitizeSettings({ maxMessages: 0, timeoutSec: 1e9 }).maxMessages, MAX_MESSAGES_BOUNDS.min);
  assert.equal(sanitizeSettings({ timeoutSec: 1e9 }).timeoutSec, TIMEOUT_BOUNDS.max);
  assert.equal(sanitizeSettings({ maxMessages: Number.NaN }).maxMessages, MAX_MESSAGES_BOUNDS.def);
  assert.equal(sanitizeSettings({ maxMessages: "" }).maxMessages, MAX_MESSAGES_BOUNDS.def);
  assert.equal(sanitizeSettings({ maxMessages: Infinity }).maxMessages, MAX_MESSAGES_BOUNDS.def);
});

test("the 0.5 chat setting is read as a fallback and removed on save", async () => {
  const area = new FakeLocal();
  area.data.set(LEGACY_MAX_MESSAGES_KEY, 7);
  assert.equal((await readSettings(area)).maxMessages, 7);
  const stored = await writeSettings(area, { maxMessages: "9" });
  assert.equal(stored.maxMessages, 9);
  assert.equal(area.data.has(LEGACY_MAX_MESSAGES_KEY), false);
  assert.deepEqual(area.data.get(SETTINGS_KEY), stored);
  assert.equal((await readSettings(area)).maxMessages, 9);
  area.fail = true;
  assert.deepEqual(await readSettings(area), defaultSettings());
});

test("the 0.5 key is moved into the settings object when the backend is settled", async () => {
  const area = new FakeLocal();
  area.data.set(LEGACY_MAX_MESSAGES_KEY, 33);
  assert.equal(await settleBackendChoice(area), "cli");
  assert.equal((area.data.get(SETTINGS_KEY) as { maxMessages: number }).maxMessages, 33);
  assert.equal(area.data.has(LEGACY_MAX_MESSAGES_KEY), false);
});

test("a new installation starts with the API key, an existing one stays with Claude Code", async () => {
  assert.equal(defaultSettings().backend, "api");
  const fresh = new FakeLocal();
  assert.equal(await settleBackendChoice(fresh), "api");
  assert.equal((fresh.data.get(SETTINGS_KEY) as { backend: string }).backend, "api");
  // Later consent or settings do not change the stored choice.
  fresh.data.set("consent", { version: 2 });
  assert.equal(await settleBackendChoice(fresh), "api");

  // 0.6 with stored settings (no backend yet).
  const withSettings = new FakeLocal();
  withSettings.data.set(SETTINGS_KEY, { models: { rewrite: "opus" }, maxMessages: 20 });
  assert.equal(await settleBackendChoice(withSettings), "cli");
  const kept = withSettings.data.get(SETTINGS_KEY) as { backend: string; maxMessages: number; models: { rewrite: string } };
  assert.equal(kept.backend, "cli");
  assert.equal(kept.maxMessages, 20);
  assert.equal(kept.models.rewrite, "opus");
  assert.equal((await readSettings(withSettings)).backend, "cli");

  // 0.6 with only a consent record (settings never changed).
  const withConsent = new FakeLocal();
  withConsent.data.set("consent", { version: 1 });
  assert.equal(await settleBackendChoice(withConsent), "cli");

  // A stored choice wins.
  const chosen = new FakeLocal();
  chosen.data.set(SETTINGS_KEY, { backend: "api" });
  chosen.data.set("consent", { version: 1 });
  assert.equal(await settleBackendChoice(chosen), "api");
});

test("the backend setting is validated and saved with the other settings", async () => {
  assert.equal(sanitizeSettings({ backend: "cli" }).backend, "cli");
  for (const v of ["CLI", "", 1, null, "openai"]) assert.equal(sanitizeSettings({ backend: v }).backend, "api");
  const area = new FakeLocal();
  assert.equal((await writeSettings(area, { backend: "cli" })).backend, "cli");
  assert.equal((await readSettings(area)).backend, "cli");
});

test("job kinds map to their model setting", () => {
  const s = sanitizeSettings({ models: { rewrite: "opus", draft: "haiku", summary: "sonnet", question: "haiku" } });
  assert.equal(modelForKind(s, "compose"), "opus");
  assert.equal(modelForKind(s, "reply"), "haiku");
  assert.equal(modelForKind(s, "instruction_draft"), "haiku");
  assert.equal(modelForKind(s, "summary"), "sonnet");
  assert.equal(modelForKind(s, "question"), "haiku");
});

test("the text limit drives the thread and search budgets", () => {
  const big = sanitizeSettings({ maxTextChars: 100000 });
  assert.equal(threadLimits(big).maxChars, 100000);
  assert.equal(threadLimits(big).maxMessageChars, MAX_MESSAGE_CHARS);
  assert.equal(searchLimits(big).maxTotalChars, 100000);
  assert.equal(searchLimits(big).maxMessageChars, QUERY_MAX_MESSAGE_CHARS);
  const small = sanitizeSettings({ maxTextChars: 5000 });
  assert.equal(threadLimits(small).maxMessageChars, 5000);
  assert.equal(searchLimits(small).maxMessageChars, Math.min(5000, QUERY_MAX_MESSAGE_CHARS));
});

const hostModule = "../host/host.mjs";
const { MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS, runTimeout } = (await import(hostModule)) as {
  MIN_RUN_TIMEOUT_MS: number;
  MAX_RUN_TIMEOUT_MS: number;
  runTimeout(v: unknown, fallback: number): number;
};

test("the host accepts only a timeout within its bounds", () => {
  assert.equal(runTimeout(45000, 120000), 45000);
  assert.equal(runTimeout(MIN_RUN_TIMEOUT_MS - 1, 120000), 120000);
  assert.equal(runTimeout(MAX_RUN_TIMEOUT_MS + 1, 120000), 120000);
  for (const v of [undefined, "60000", 1.5, NaN, null]) assert.equal(runTimeout(v, 120000), 120000);
  // Every setting the page allows is within the host's bounds.
  assert.ok(TIMEOUT_BOUNDS.min * 1000 >= MIN_RUN_TIMEOUT_MS && TIMEOUT_BOUNDS.max * 1000 <= MAX_RUN_TIMEOUT_MS);
});

test("connection test results map to clear states", () => {
  assert.deepEqual(toCheckResponse("cli", { ok: true, detail: "2.1.3" }), { state: "ok", backend: "cli", version: "2.1.3" });
  assert.deepEqual(toCheckResponse("cli", { ok: true, detail: "<b>x</b>" }), { state: "ok", backend: "cli" });
  assert.deepEqual(toCheckResponse("api", { ok: true, detail: "2.1.3" }), { state: "ok", backend: "api" });
  assert.deepEqual(toCheckResponse("cli", { ok: false, detail: "not_logged_in" }), { state: "not_logged_in", backend: "cli" });
  assert.deepEqual(toCheckResponse("cli", { ok: false, detail: "cli_not_found" }), { state: "cli_not_found", backend: "cli" });
  assert.deepEqual(toCheckResponse("cli", { ok: false, detail: "cli_unsupported" }), { state: "cli_unsupported", backend: "cli" });
  for (const code of ["api_key_missing", "api_key_invalid", "api_billing", "rate_limited", "overloaded", "network_error"]) {
    assert.deepEqual(toCheckResponse("api", { ok: false, detail: code }), { state: code, backend: "api" });
  }
  assert.deepEqual(toCheckResponse("cli", { ok: false, detail: "ok" }), { state: "internal", backend: "cli" });
  assert.deepEqual(toCheckResponse("cli", { ok: false, detail: "Could not determine" }), { state: "internal", backend: "cli" });
  assert.deepEqual(toCheckResponse("cli", { errorCode: "host_not_found" }), { state: "host_not_found", backend: "cli" });
  assert.deepEqual(toCheckResponse("api", { errorCode: "timeout" }), { state: "timeout", backend: "api" });
  assert.deepEqual(toCheckResponse("api", { errorCode: "weird" }), { state: "internal", backend: "api" });
  assert.deepEqual(parseCheckResponse({ state: "ok", backend: "cli", version: "1.0" }), { state: "ok", backend: "cli", version: "1.0" });
  assert.deepEqual(parseCheckResponse({ state: "api_key_invalid", backend: "api" }), { state: "api_key_invalid", backend: "api" });
  assert.equal(parseCheckResponse({ state: "ok" }), null);
  assert.equal(parseCheckResponse({ state: "ok", backend: "gpt" }), null);
  assert.equal(parseCheckResponse({ state: "evil", backend: "api" }), null);
  assert.equal(parseCheckResponse({ state: "ok", backend: "cli", version: "x".repeat(41) }), null);
  assert.deepEqual(parseRuntimeRequest({ type: "checkBackend", extra: 1 }), { type: "checkBackend" });
});
