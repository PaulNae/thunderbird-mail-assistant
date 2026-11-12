import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendError } from "../extension/backend/backend.ts";
import type { Backend, RunRequest } from "../extension/backend/backend.ts";
import { ConsentGatedBackend } from "../extension/background/gated-backend.ts";
import { JobStore } from "../extension/background/jobs.ts";
import { ChatSession } from "../extension/background/chat.ts";
import { CONSENT_KEY, CONSENT_VERSION, grantConsent, isConsentGiven, readConsent, revokeConsent } from "../extension/shared/consent.ts";
import type { LocalArea } from "../extension/shared/consent.ts";
import type { JobSnapshot, PortEvent } from "../extension/shared/job-messages.ts";
import type { ChatEvent } from "../extension/shared/chat-messages.ts";

class FakeLocal implements LocalArea {
  data = new Map<string, unknown>();
  failGet = false;
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (this.failGet) throw new Error("storage broken");
    const out: Record<string, unknown> = {};
    const list = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

/** Records runs and answers each with one chunk. */
class RecordingBackend implements Backend {
  runs: RunRequest[] = [];
  checks = 0;
  async *run(req: RunRequest): AsyncGenerator<string, void, undefined> {
    this.runs.push(req);
    yield "ok";
  }
  async check(): Promise<{ ok: boolean; detail?: string }> {
    this.checks++;
    return { ok: true, detail: "1.0.0" };
  }
}

const signal = (): AbortSignal => new AbortController().signal;

async function drain(it: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const c of it) s += c;
  return s;
}

test("only a record of the current version counts as consent", () => {
  assert.equal(isConsentGiven({ version: CONSENT_VERSION }), true);
  for (const v of [undefined, null, true, "yes", 1, [], {}, { version: CONSENT_VERSION - 1 }, { version: String(CONSENT_VERSION) }, { version: CONSENT_VERSION + 1 }]) {
    assert.equal(isConsentGiven(v), false, JSON.stringify(v));
  }
});

test("grant stores only the fact and the version; revoke removes it; a broken storage means no consent", async () => {
  const area = new FakeLocal();
  assert.equal(await readConsent(area), false);
  await grantConsent(area);
  assert.deepEqual([...area.data.entries()], [[CONSENT_KEY, { version: CONSENT_VERSION }]]);
  assert.equal(await readConsent(area), true);
  await revokeConsent(area);
  assert.equal(await readConsent(area), false);
  await grantConsent(area);
  area.failGet = true;
  assert.equal(await readConsent(area), false);
});

test("the gate blocks every run without consent and lets it through with consent", async () => {
  const area = new FakeLocal();
  const inner = new RecordingBackend();
  const gated = new ConsentGatedBackend(inner, () => readConsent(area));
  await assert.rejects(drain(gated.run({ system: "s", prompt: "mail text", signal: signal() })), (e: unknown) => e instanceof BackendError && e.code === "consent_required");
  assert.equal(inner.runs.length, 0, "nothing reached the backend");
  await grantConsent(area);
  assert.equal(await drain(gated.run({ system: "s", prompt: "p", signal: signal() })), "ok");
  assert.equal(inner.runs.length, 1);
  await revokeConsent(area);
  await assert.rejects(drain(gated.run({ system: "s", prompt: "p", signal: signal() })));
  assert.equal(inner.runs.length, 1);
});

test("a throwing consent check blocks; the connection test needs no consent", async () => {
  const inner = new RecordingBackend();
  const gated = new ConsentGatedBackend(inner, () => Promise.reject(new Error("x")));
  await assert.rejects(drain(gated.run({ system: "s", prompt: "p", signal: signal() })), (e: unknown) => e instanceof BackendError && e.code === "consent_required");
  assert.deepEqual(await gated.check(), { ok: true, detail: "1.0.0" });
  assert.equal(inner.checks, 1);
  assert.equal(inner.runs.length, 0);
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("a popup job without consent ends with consent_required and sends nothing", async () => {
  const inner = new RecordingBackend();
  const store = new JobStore({ backend: new ConsentGatedBackend(inner, async () => false) });
  const events: PortEvent[] = [];
  await store.open("display:1", (e) => events.push(e), 5);
  await store.start("display:1", { kind: "summary", system: "s", prompt: "mail text", messageId: 5 });
  for (let i = 0; i < 20; i++) await tick();
  const last = events.filter((e): e is { type: "snapshot"; snapshot: JobSnapshot } => e.type === "snapshot").at(-1);
  assert.equal(last?.snapshot.phase, "error");
  assert.equal(last?.snapshot.error, "consent_required");
  assert.equal(inner.runs.length, 0);
});

test("a mailbox question without consent ends with consent_required before any mail is searched or loaded", async () => {
  const inner = new RecordingBackend();
  let searched = 0;
  let loaded = 0;
  const events: ChatEvent[] = [];
  const session = new ChatSession(
    {
      backend: new ConsentGatedBackend(inner, async () => false),
      search: async () => {
        searched++;
        return { headers: [{ id: 1 }], complete: true };
      },
      load: async (id) => {
        loaded++;
        return { id, from: "a", subject: "b", date: "", body: "c", attachments: [] };
      },
      maxMessages: async () => undefined,
    },
    (e) => events.push(e),
  );
  session.ask("Was hat Berger geschrieben?");
  for (let i = 0; i < 50 && session.running; i++) await tick();
  const turn = session.snapshot().turns[0];
  assert.equal(turn?.status, "error");
  assert.equal(turn?.error, "consent_required");
  assert.equal(searched, 0);
  assert.equal(loaded, 0);
  assert.equal(inner.runs.length, 0);
});
