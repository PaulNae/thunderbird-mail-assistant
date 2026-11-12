import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendError } from "../extension/backend/backend.ts";
import type { RunRequest } from "../extension/backend/backend.ts";
import { JobStore, composeKey, displayKey } from "../extension/background/jobs.ts";
import type { SessionArea } from "../extension/background/jobs.ts";
import { handleConnection } from "../extension/background/connection.ts";
import type { PortLike } from "../extension/background/connection.ts";
import { MAX_TEXT_CHARS } from "../extension/shared/job-messages.ts";
import type { JobSnapshot, PortEvent, StartRequest } from "../extension/shared/job-messages.ts";
import { MAX_HISTORY_ENTRIES } from "../extension/prompts/read.ts";

class FakeSession implements SessionArea {
  data = new Map<string, unknown>();
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
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

/** A backend whose runs are driven by the test. */
class FakeBackend {
  runs: { req: RunRequest; push(t: string): void; end(): void; fail(e: Error): void }[] = [];
  run(req: RunRequest): AsyncIterable<string> {
    const queue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    const poke = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    this.runs.push({
      req,
      push: (t) => {
        queue.push(t);
        poke();
      },
      end: () => {
        done = true;
        poke();
      },
      fail: (e) => {
        error = e;
        poke();
      },
    });
    req.signal.addEventListener("abort", () => {
      error = new BackendError("cancelled");
      poke();
    });
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift() as string;
          if (error) throw error;
          if (done) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      },
    };
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick();
};

function setup(opts: { maxEntries?: number; session?: FakeSession | null } = {}) {
  const backend = new FakeBackend();
  const session = opts.session === null ? null : (opts.session ?? new FakeSession());
  let clock = 0;
  const store = new JobStore({ backend, session, now: () => ++clock, ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }) });
  return { backend, session, store };
}

const summary = (messageId = 1): StartRequest => ({ kind: "summary", system: "SYS", prompt: "SECRET MAIL BODY", model: "haiku", messageId });
const question = (q: string, messageId = 1): StartRequest => ({ kind: "question", system: "SYS", prompt: "SECRET MAIL BODY", messageId, question: q });
const rewrite: StartRequest = { kind: "compose", system: "SYS", prompt: "SECRET MAIL BODY", job: { type: "compose", action: { kind: "shorten" } } };

function collect(): { events: PortEvent[]; sub: (e: PortEvent) => void; last(): JobSnapshot } {
  const events: PortEvent[] = [];
  return {
    events,
    sub: (e) => events.push(e),
    last: () => {
      const snaps = events.filter((e): e is Extract<PortEvent, { type: "snapshot" }> => e.type === "snapshot");
      return snaps[snaps.length - 1]!.snapshot;
    },
  };
}

test("open on an unknown key sends an empty snapshot", async () => {
  const { store } = setup();
  const c = collect();
  await store.open(displayKey(1), c.sub);
  assert.equal(c.last().phase, "idle");
});

test("summary: streaming deltas, then done and kept after the popup closes", async () => {
  const { store, backend } = setup();
  const c = collect();
  const detach = await store.open(displayKey(1), c.sub, 1);
  await store.start(displayKey(1), summary());
  assert.equal(c.last().phase, "streaming");
  assert.equal(backend.runs[0]!.req.prompt, "SECRET MAIL BODY");
  backend.runs[0]!.push("Hel");
  backend.runs[0]!.push("lo");
  await flush();
  assert.deepEqual(c.events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text), ["Hel", "lo"]);
  detach(); // popup closed, the job continues
  backend.runs[0]!.push(" world");
  backend.runs[0]!.end();
  await flush();
  const c2 = collect();
  await store.open(displayKey(1), c2.sub, 1);
  assert.equal(c2.last().phase, "done");
  assert.equal(c2.last().summary, "Hello world");
  assert.equal(c2.last().text, "");
});

test("reopening during a run delivers a snapshot with the text so far, then deltas", async () => {
  const { store, backend } = setup();
  await store.start(displayKey(1), summary());
  backend.runs[0]!.push("abc");
  await flush();
  const c = collect();
  await store.open(displayKey(1), c.sub, 1);
  assert.equal(c.last().phase, "streaming");
  assert.equal(c.last().text, "abc");
  backend.runs[0]!.push("d");
  await flush();
  assert.equal(c.events.at(-1)?.type, "delta");
});

test("a second start while running is ignored", async () => {
  const { store, backend } = setup();
  await store.start(displayKey(1), summary());
  await store.start(displayKey(1), question("q"));
  assert.equal(backend.runs.length, 1);
});

test("questions build the history; a failed or cancelled answer is not added", async () => {
  const { store, backend } = setup();
  const key = displayKey(1);
  await store.start(key, question("q1"));
  backend.runs[0]!.push("a1");
  backend.runs[0]!.end();
  await flush();
  await store.start(key, question("q2"));
  backend.runs[1]!.fail(new BackendError("timeout"));
  await flush();
  await store.start(key, question("q3"));
  await flush();
  void store.cancel(key);
  await flush();
  const c = collect();
  await store.open(key, c.sub, 1);
  assert.deepEqual(c.last().history, [{ question: "q1", answer: "a1" }]);
  assert.equal(c.last().phase, "cancelled");
});

test("errors carry the code, summary survives a failed second run", async () => {
  const { store, backend } = setup();
  const key = displayKey(1);
  await store.start(key, summary());
  backend.runs[0]!.push("S1");
  backend.runs[0]!.end();
  await flush();
  await store.start(key, summary());
  backend.runs[1]!.fail(new BackendError("rate_limited"));
  await flush();
  const c = collect();
  await store.open(key, c.sub, 1);
  assert.equal(c.last().phase, "error");
  assert.equal(c.last().error, "rate_limited");
  assert.equal(c.last().summary, "S1");
});

test("an empty result is an error", async () => {
  const { store, backend } = setup();
  await store.start(composeKey(2), rewrite);
  backend.runs[0]!.push("   ");
  backend.runs[0]!.end();
  await flush();
  const c = collect();
  await store.open(composeKey(2), c.sub);
  assert.equal(c.last().error, "empty_result");
});

test("compose: preview and job are kept; discard and applied delete the entry", async () => {
  const { store, backend, session } = setup();
  const key = composeKey(5);
  await store.start(key, rewrite);
  backend.runs[0]!.push("New text");
  backend.runs[0]!.end();
  await flush();
  const c = collect();
  await store.open(key, c.sub);
  assert.equal(c.last().phase, "done");
  assert.equal(c.last().text, "New text");
  assert.deepEqual(c.last().job, rewrite.job);
  assert.ok(session!.data.has("job:" + key));
  await store.clear(key);
  assert.equal(session!.data.size, 0);
  const c2 = collect();
  await store.open(key, c2.sub);
  assert.equal(c2.last().phase, "idle");
  assert.equal(c2.last().text, "");
});

test("another message in the same tab aborts the run and deletes everything; the same message keeps it", async () => {
  const { store, backend, session } = setup();
  const key = displayKey(7);
  await store.start(key, summary(10));
  await store.onMessagesDisplayed(7, [10]);
  assert.equal(backend.runs[0]!.req.signal.aborted, false);
  await store.onMessagesDisplayed(7, [11]);
  assert.equal(backend.runs[0]!.req.signal.aborted, true);
  assert.equal(session!.data.size, 0);
  await flush();
  const c = collect();
  await store.open(key, c.sub, 11);
  assert.equal(c.last().phase, "idle");
});

test("several displayed messages delete the entry; other tabs are untouched", async () => {
  const { store, backend } = setup();
  backend.runs.length = 0;
  await store.start(displayKey(1), summary(10));
  backend.runs[0]!.end();
  backend.runs[0]!.push("x");
  await flush();
  await store.start(displayKey(2), summary(20));
  backend.runs[1]!.push("y");
  backend.runs[1]!.end();
  await flush();
  await store.onMessagesDisplayed(1, [10, 12]);
  const a = collect();
  const b = collect();
  await store.open(displayKey(1), a.sub, 10);
  await store.open(displayKey(2), b.sub, 20);
  assert.equal(a.last().phase, "idle");
  assert.equal(b.last().summary, "y");
});

test("closing the tab cancels the run and deletes display and compose entries", async () => {
  const { store, backend, session } = setup();
  await store.start(displayKey(3), summary(1));
  await store.start(composeKey(3), rewrite);
  await store.onTabRemoved(3);
  assert.ok(backend.runs.every((r) => r.req.signal.aborted));
  assert.equal(session!.data.size, 0);
  await flush();
  const c = collect();
  await store.open(displayKey(3), c.sub, 1);
  assert.equal(c.last().phase, "idle");
});

test("a cleared run that still delivers data does not revive the entry", async () => {
  const { store, backend, session } = setup();
  await store.start(displayKey(3), summary(1));
  await store.onTabRemoved(3);
  backend.runs[0]!.push("late");
  backend.runs[0]!.end();
  await flush();
  assert.equal(session!.data.size, 0);
});

test("opening for another message drops the stale entry", async () => {
  const { store, backend } = setup();
  await store.start(displayKey(1), summary(1));
  backend.runs[0]!.push("old");
  backend.runs[0]!.end();
  await flush();
  const c = collect();
  await store.open(displayKey(1), c.sub, 2);
  assert.equal(c.last().phase, "idle");
  assert.equal(c.last().summary, "");
});

test("the session mirror holds results but never prompts", async () => {
  const { store, backend, session } = setup();
  await store.start(displayKey(1), question("what?"));
  backend.runs[0]!.push("answer");
  backend.runs[0]!.end();
  await flush();
  const dump = JSON.stringify([...session!.data.entries()]);
  assert.ok(dump.includes("answer"));
  assert.ok(!dump.includes("SECRET MAIL BODY"));
  assert.ok(!dump.includes("SYS"));
});

test("a new store (background restarted) restores done entries from the mirror", async () => {
  const { store, backend, session } = setup();
  await store.start(displayKey(1), summary(1));
  backend.runs[0]!.push("kept");
  backend.runs[0]!.end();
  await flush();
  const again = setup({ session: session! });
  const c = collect();
  await again.store.open(displayKey(1), c.sub, 1);
  assert.equal(c.last().summary, "kept");
  assert.equal(c.last().phase, "done");
  // and a display change is still recognized without the entry being in memory
  const third = setup({ session: session! });
  await third.store.onMessagesDisplayed(1, [99]);
  assert.equal(session!.data.size, 0);
});

test("a mirrored 'streaming' entry without a live run is shown as cancelled", async () => {
  const { store, session } = setup();
  await store.start(composeKey(4), rewrite); // mirrored as streaming, then the "background" restarts
  assert.equal((session!.data.get("job:" + composeKey(4)) as { snapshot: JobSnapshot }).snapshot.phase, "streaming");
  const again = setup({ session: session! });
  const c = collect();
  await again.store.open(composeKey(4), c.sub);
  assert.equal(c.last().phase, "cancelled");
  assert.equal(c.last().text, "");
  await again.store.start(composeKey(4), rewrite); // not blocked by the dead run
  assert.equal(again.backend.runs.length, 1);
});

test("a malformed mirror is ignored", async () => {
  const { store, session } = setup();
  await session!.set({ ["job:" + displayKey(1)]: { v: 1, snapshot: { phase: "bogus" } } });
  const c = collect();
  await store.open(displayKey(1), c.sub, 1);
  assert.equal(c.last().phase, "idle");
});

test("text is capped per entry", async () => {
  const { store, backend } = setup();
  await store.start(composeKey(1), rewrite);
  backend.runs[0]!.push("x".repeat(MAX_TEXT_CHARS - 5));
  backend.runs[0]!.push("y".repeat(100));
  backend.runs[0]!.end();
  await flush();
  const c = collect();
  await store.open(composeKey(1), c.sub);
  assert.equal(c.last().text.length, MAX_TEXT_CHARS - 5 + 5);
});

test("history is capped", async () => {
  const { store, backend } = setup();
  const key = displayKey(1);
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i++) {
    await store.start(key, question(`q${i}`));
    backend.runs[i]!.push(`a${i}`);
    backend.runs[i]!.end();
    await flush();
  }
  const c = collect();
  await store.open(key, c.sub, 1);
  assert.equal(c.last().history.length, MAX_HISTORY_ENTRIES);
  assert.equal(c.last().history.at(-1)?.question, `q${MAX_HISTORY_ENTRIES + 2}`);
});

test("the number of entries is capped, oldest first, including mirror and running jobs", async () => {
  const { store, backend, session } = setup({ maxEntries: 3 });
  for (let tab = 1; tab <= 4; tab++) {
    await store.start(displayKey(tab), summary(tab));
    backend.runs[tab - 1]!.push("r");
    if (tab < 4) backend.runs[tab - 1]!.end();
    await flush();
  }
  assert.deepEqual([...session!.data.keys()].sort(), ["job:display:2", "job:display:3", "job:display:4"]);
});

test("evicting an entry with a running job aborts it", async () => {
  const { store, backend } = setup({ maxEntries: 2 });
  await store.start(displayKey(1), summary(1));
  await store.start(displayKey(2), summary(2));
  await store.start(displayKey(3), summary(3));
  assert.equal(backend.runs[0]!.req.signal.aborted, true);
  assert.equal(backend.runs[1]!.req.signal.aborted, false);
});

test("works without storage.session", async () => {
  const { store, backend } = setup({ session: null });
  await store.start(displayKey(1), summary(1));
  backend.runs[0]!.push("m");
  backend.runs[0]!.end();
  await flush();
  const c = collect();
  await store.open(displayKey(1), c.sub, 1);
  assert.equal(c.last().summary, "m");
});

function fakePort(name: string, senderId: string | undefined) {
  const handlers: { msg: ((m: unknown) => void)[]; disc: (() => void)[] } = { msg: [], disc: [] };
  const sent: unknown[] = [];
  let disconnected = false;
  const port: PortLike = {
    name,
    ...(senderId === undefined ? {} : { sender: { id: senderId } }),
    postMessage: (m) => void sent.push(m),
    disconnect: () => {
      disconnected = true;
    },
    onMessage: { addListener: (cb) => void handlers.msg.push(cb) },
    onDisconnect: { addListener: (cb) => void handlers.disc.push(cb) },
  };
  return { port, sent, send: (m: unknown) => handlers.msg.forEach((h) => h(m)), close: () => handlers.disc.forEach((h) => h()), isDisconnected: () => disconnected };
}

test("connection: foreign senders and unknown ports are disconnected", () => {
  const { store } = setup();
  const a = fakePort("display", "other@addon");
  handleConnection(store, a.port, "me@addon");
  assert.equal(a.isDisconnected(), true);
  const b = fakePort("bogus", "me@addon");
  handleConnection(store, b.port, "me@addon");
  assert.equal(b.isDisconnected(), true);
});

test("connection: open, start, stream, cancel; invalid messages are ignored; closing keeps the job", async () => {
  const { store, backend } = setup();
  const p = fakePort("display", "me@addon");
  handleConnection(store, p.port, "me@addon");
  p.send({ type: "start", kind: "summary", system: "s", prompt: "p", messageId: 1 }); // before open: ignored
  p.send({ type: "open", tabId: "x" }); // invalid
  p.send({ type: "open", tabId: 1, messageId: 1 });
  await flush();
  assert.equal(backend.runs.length, 0);
  assert.equal((p.sent[0] as PortEvent).type, "snapshot");
  p.send({ type: "start", kind: "summary", system: "s", prompt: "", messageId: 1 }); // empty prompt: invalid
  p.send({ type: "start", kind: "summary", system: "s", prompt: "p", messageId: 1 });
  await flush();
  assert.equal(backend.runs.length, 1);
  backend.runs[0]!.push("t");
  await flush();
  assert.ok(p.sent.some((m) => (m as PortEvent).type === "delta"));
  p.close();
  backend.runs[0]!.push("u");
  await flush();
  assert.equal(backend.runs[0]!.req.signal.aborted, false);
  const q = fakePort("display", "me@addon");
  handleConnection(store, q.port, "me@addon");
  q.send({ type: "open", tabId: 1, messageId: 1 });
  await flush();
  q.send({ type: "cancel" });
  await flush();
  assert.equal(backend.runs[0]!.req.signal.aborted, true);
});

test("connection: compose discard and applied delete; display cannot send them", async () => {
  const { store, session, backend } = setup();
  const p = fakePort("compose", "me@addon");
  handleConnection(store, p.port, "me@addon");
  p.send({ type: "open", tabId: 9 });
  p.send({ type: "start", system: "s", prompt: "p", job: { type: "reply", notes: "n" } });
  await flush();
  backend.runs[0]!.push("draft");
  backend.runs[0]!.end();
  await flush();
  assert.ok(session!.data.has("job:compose:9"));
  p.send({ type: "applied" });
  await flush();
  assert.equal(session!.data.size, 0);
  const d = fakePort("display", "me@addon");
  handleConnection(store, d.port, "me@addon");
  d.send({ type: "open", tabId: 9, messageId: 1 });
  d.send({ type: "start", kind: "summary", system: "s", prompt: "p", messageId: 1 });
  await flush();
  d.send({ type: "discard" });
  await flush();
  assert.ok(session!.data.has("job:display:9"));
});

test("start for another message while a job runs drops the old job and starts the new one", async () => {
  const { store, backend } = setup();
  const key = displayKey(7);
  await store.start(key, summary(1));
  await store.start(key, summary(2));
  await flush();
  assert.equal(backend.runs.length, 2);
  assert.equal(backend.runs[0]!.req.signal.aborted, true);
  const c = collect();
  await store.open(key, c.sub, 2);
  assert.equal(c.last().phase, "streaming");
  assert.equal(c.last().messageId, 2);
});

test("start while the same job runs is ignored but resends the snapshot", async () => {
  const { store, backend } = setup();
  const key = displayKey(8);
  const c = collect();
  await store.open(key, c.sub, 1);
  await store.start(key, summary(1));
  const before = c.events.length;
  await store.start(key, question("q", 1));
  assert.equal(backend.runs.length, 1);
  assert.ok(c.events.length > before);
  assert.equal(c.last().phase, "streaming");
});

test("a cancel queued behind a pending start still aborts the run", async () => {
  const { store, backend } = setup();
  const key = composeKey(9);
  const started = store.start(key, rewrite);
  const cancelled = store.cancel(key);
  await started;
  await cancelled;
  await flush();
  assert.equal(backend.runs[0]!.req.signal.aborted, true);
});
