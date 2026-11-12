import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendError } from "../extension/backend/backend.ts";
import type { RunRequest } from "../extension/backend/backend.ts";
import { ChatSession, handleChatConnection } from "../extension/background/chat.ts";
import type { ChatDeps } from "../extension/background/chat.ts";
import { ChatTabTracker } from "../extension/background/chat-tab.ts";
import type { PortLike } from "../extension/background/connection.ts";
import type { SearchParams } from "../extension/prompts/query.ts";
import { QUERY_ANSWER_MODEL, QUERY_PARAMS_MODEL } from "../extension/prompts/query.ts";
import { defaultSettings } from "../extension/shared/settings.ts";
import type { Settings } from "../extension/shared/settings.ts";
import type { LoadedMessage } from "../extension/mail/types.ts";
import type { FoundHeader } from "../extension/mail/search-select.ts";
import {
  MAX_CHAT_TURNS,
  MAX_HEADER_CHARS,
  parseChatEvent,
  parseChatRequest,
} from "../extension/shared/chat-messages.ts";
import type { ChatEvent, ChatSnapshot, ChatTurn } from "../extension/shared/chat-messages.ts";

type Reply = string[] | Error | ((signal: AbortSignal) => AsyncIterable<string>);

/** Replies in order; records the requests. */
class ScriptedBackend {
  requests: RunRequest[] = [];
  private readonly replies: Reply[];
  constructor(replies: Reply[]) {
    this.replies = replies;
  }
  run(req: RunRequest): AsyncIterable<string> {
    this.requests.push(req);
    const reply = this.replies.shift() ?? new Error("no reply scripted");
    if (typeof reply === "function") return reply(req.signal);
    return (async function* () {
      if (reply instanceof Error) throw reply;
      for (const c of reply) yield c;
    })();
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function settle(session: ChatSession): Promise<void> {
  for (let i = 0; i < 50 && session.running; i++) await tick();
  await tick();
}

const NOW = new Date(2026, 10, 12, 12, 0);

function mail(id: number, body = `Body ${id}`): LoadedMessage {
  return { id, from: `Sender ${id}`, subject: `Subject ${id}`, date: new Date(2026, 10, id).toISOString(), body, attachments: [] };
}

interface Setup {
  backend: ScriptedBackend;
  searches: SearchParams[][];
  events: ChatEvent[];
  session: ChatSession;
  last(): ChatTurn;
}

function setup(replies: Reply[], results: FoundHeader[][], opts: Partial<ChatDeps> = {}): Setup {
  const backend = new ScriptedBackend(replies);
  const searches: SearchParams[][] = [];
  const events: ChatEvent[] = [];
  const deps: ChatDeps = {
    backend,
    search: async (queries) => {
      searches.push([...queries]);
      return { headers: results.shift() ?? [], complete: true };
    },
    load: async (id) => mail(id),
    settings: async () => defaultSettings(),
    now: () => NOW,
    ...opts,
  };
  const session = new ChatSession(deps, (e) => events.push(e));
  const last = (): ChatTurn => {
    const snaps = events.filter((e): e is { type: "snapshot"; snapshot: ChatSnapshot } => e.type === "snapshot");
    const turns = snaps[snaps.length - 1]!.snapshot.turns;
    return turns[turns.length - 1]!;
  };
  return { backend, searches, events, session, last };
}

const hits = (...ids: number[]): FoundHeader[] => ids.map((id) => ({ id, date: new Date(2026, 10, id) }));

test("happy path: params, search, answer with sources newest first", async () => {
  const s = setup([['{"from":"Anna",', '"text":"Angebot"}'], ["Der Preis ist 100 € [1]."]], [hits(3, 5)]);
  s.session.ask("  Was hat Anna zum Angebot geschrieben? ");
  await settle(s.session);
  assert.equal(s.backend.requests[0]!.model, QUERY_PARAMS_MODEL);
  assert.match(s.backend.requests[0]!.prompt, /<today>2026-11-12/);
  assert.equal(s.backend.requests[1]!.model, QUERY_ANSWER_MODEL);
  assert.match(s.backend.requests[1]!.prompt, /<mail index="1">\nFrom: Sender 5/);
  assert.deepEqual(s.searches, [[{ from: "Anna", text: "Angebot" }]]);
  const turn = s.last();
  assert.equal(turn.status, "done");
  assert.equal(turn.question, "Was hat Anna zum Angebot geschrieben?");
  assert.equal(turn.answer, "Der Preis ist 100 € [1].");
  assert.deepEqual(turn.sources.map((x) => [x.index, x.messageId]), [[1, 5], [2, 3]]);
  assert.equal(turn.sent, 2);
  assert.equal(turn.found, 2);
  assert.equal(turn.truncated, false);
  assert.deepEqual(turn.search, { queries: [{ from: "Anna", text: "Angebot" }], source: "model", relaxed: false });
  assert.ok(s.events.some((e) => e.type === "delta"));
  // Every snapshot passes the page-side validation.
  for (const e of s.events) assert.ok(parseChatEvent(e), JSON.stringify(e));
});

test("the settings choose the answer model, the time limit and the text budget", async () => {
  const settings: Settings = { ...defaultSettings(), models: { ...defaultSettings().models, query: "opus" }, timeoutSec: 300, maxTextChars: 5000 };
  const long = "z".repeat(4000);
  const s = setup([['{"text":"Angebot"}'], ["ok [1]"]], [hits(1, 2, 3)], { settings: async () => settings, load: async (id) => mail(id, long) });
  s.session.ask("Angebot?");
  await settle(s.session);
  assert.equal(s.backend.requests[0]!.model, QUERY_PARAMS_MODEL, "step 1 keeps its fixed model");
  assert.equal(s.backend.requests[1]!.model, "opus");
  assert.ok(s.backend.requests.every((r) => r.timeoutMs === 300000));
  const turn = s.last();
  assert.equal(turn.truncated, true, "5000 characters do not hold three mails of 4000");
  assert.ok(turn.sent < 3);
});

test("invalid params: one retry, then fallback to the words of the question", async () => {
  const s = setup([["Sure! Here are params"], ['{"folder":"x"}'], ["Antwort [1]"]], [hits(1)]);
  s.session.ask("Was schrieb Bernhard zur Kanzlei?");
  await settle(s.session);
  assert.equal(s.backend.requests.filter((r) => r.model === QUERY_PARAMS_MODEL).length, 2);
  assert.deepEqual(s.searches, [[{ text: "Bernhard" }, { text: "Kanzlei" }]]);
  assert.equal(s.last().search?.source, "fallback");
  assert.equal(s.last().status, "done");
});

test("valid params on the retry are used", async () => {
  const s = setup([["oops"], ['{"text":"Rechnung"}'], ["ok [1]"]], [hits(1)]);
  s.session.ask("Rechnung?");
  await settle(s.session);
  assert.deepEqual(s.searches, [[{ text: "Rechnung" }]]);
  assert.equal(s.last().search?.source, "model");
});

test("no hits: one looser search, then a clear no-results state without asking the model", async () => {
  const s = setup([['{"from":"Anna","text":"Angebot"}']], [[], []]);
  s.session.ask("Was hat Anna zum Angebot geschrieben?");
  await settle(s.session);
  assert.deepEqual(s.searches, [[{ from: "Anna", text: "Angebot" }], [{ from: "Anna" }]]);
  assert.equal(s.backend.requests.length, 1);
  const turn = s.last();
  assert.equal(turn.status, "no_results");
  assert.equal(turn.search?.relaxed, true);
  assert.equal(turn.stage, undefined);
});

test("the looser search can find mails", async () => {
  const s = setup([['{"from":"Anna","after":"2026-11-01"}'], ["x [1]"]], [[], hits(2)]);
  s.session.ask("Anna?");
  await settle(s.session);
  assert.equal(s.last().status, "done");
  assert.equal(s.last().search?.relaxed, true);
});

test("the setting limits the mails sent; truncation and omissions are reported", async () => {
  const s = setup([['{"text":"x"}'], ["a [1]"]], [hits(1, 2, 3, 4, 5)], {
    settings: async (): Promise<Settings> => ({ ...defaultSettings(), maxMessages: 2 }),
    load: async (id) => mail(id, "y".repeat(400)),
    limits: { maxMessageChars: 300, maxTotalChars: 10000 },
  });
  s.session.ask("x?");
  await settle(s.session);
  const turn = s.last();
  assert.deepEqual(turn.sources.map((x) => x.messageId), [5, 4]);
  assert.equal(turn.sent, 2);
  assert.equal(turn.found, 5);
  assert.equal(turn.truncated, true);
  assert.match(s.backend.requests[1]!.prompt, /3 further matching email\(s\) were not included/);
});

test("overlong sender and subject are cut so the snapshot stays valid", async () => {
  const s = setup([['{"text":"x"}'], ["a [1]"]], [hits(1)], {
    load: async (id) => ({ ...mail(id), from: "f".repeat(5000), subject: "s".repeat(5000) }),
  });
  s.session.ask("x?");
  await settle(s.session);
  const turn = s.last();
  assert.equal(turn.status, "done");
  assert.equal(turn.sources[0]!.subject.length, MAX_HEADER_CHARS);
  for (const e of s.events) assert.ok(parseChatEvent(e));
});

test("unreadable mails are skipped; if none can be read the search fails", async () => {
  const s = setup([['{"text":"x"}']], [hits(1, 2)], { load: async () => Promise.reject(new Error("gone")) });
  s.session.ask("x?");
  await settle(s.session);
  assert.equal(s.last().status, "error");
  assert.equal(s.last().error, "search_failed");
});

test("a failing search API is reported as search_failed", async () => {
  const s = setup([['{"text":"x"}']], [], { search: async () => Promise.reject(new Error("api")) });
  s.session.ask("x?");
  await settle(s.session);
  assert.equal(s.last().error, "search_failed");
});

test("backend errors keep their code", async () => {
  const s = setup([new BackendError("not_logged_in")], []);
  s.session.ask("x?");
  await settle(s.session);
  assert.equal(s.last().status, "error");
  assert.equal(s.last().error, "not_logged_in");
});

test("cancel during the search ends as cancelled", async () => {
  let started!: () => void;
  const searching = new Promise<void>((r) => (started = r));
  const s = setup([['{"text":"x"}']], [], {
    search: (_q, _l, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new BackendError("cancelled")));
      }),
  });
  s.session.ask("x?");
  await searching;
  assert.equal(s.last().stage, "search");
  s.session.cancel();
  await settle(s.session);
  assert.equal(s.last().status, "cancelled");
  assert.equal(s.session.running, false);
});

test("cancel during streaming ends as cancelled and the next question works", async () => {
  const stream = (signal: AbortSignal): AsyncIterable<string> =>
    (async function* () {
      yield "partial";
      await new Promise((r) => signal.addEventListener("abort", r));
      throw new BackendError("cancelled");
    })();
  const s = setup([['{"text":"x"}'], stream, ['{"text":"y"}'], ["fine [1]"]], [hits(1), hits(2)]);
  s.session.ask("x?");
  for (let i = 0; i < 20 && !s.events.some((e) => e.type === "delta"); i++) await tick();
  s.session.cancel();
  await settle(s.session);
  assert.equal(s.last().status, "cancelled");
  assert.equal(s.last().answer, "");
  s.session.ask("y?");
  await settle(s.session);
  assert.equal(s.last().status, "done");
});

test("a second question while running is ignored", async () => {
  const s = setup([['{"text":"x"}'], ["a [1]"]], [hits(1)]);
  s.session.ask("first?");
  s.session.ask("second?");
  await settle(s.session);
  const snap = s.session.snapshot();
  assert.deepEqual(snap.turns.map((t) => t.question), ["first?"]);
});

test("follow-up questions carry earlier questions and answers without citations", async () => {
  const s = setup([['{"text":"x"}'], ["Erste Antwort [1]."], ['{"text":"y"}'], ["Zweite [1]"]], [hits(1), hits(2)]);
  s.session.ask("Erste Frage?");
  await settle(s.session);
  s.session.ask("Und danach?");
  await settle(s.session);
  assert.match(s.backend.requests[2]!.prompt, /<earlier_questions>\n- Erste Frage\?/);
  assert.match(s.backend.requests[3]!.prompt, /<earlier_answer>\nErste Antwort\.\n<\/earlier_answer>/);
});

test("history is bounded and clear forgets everything", async () => {
  const replies: Reply[] = [];
  const results: FoundHeader[][] = [];
  for (let i = 0; i < MAX_CHAT_TURNS + 2; i++) {
    replies.push(['{"text":"x"}'], ["a [1]"]);
    results.push(hits(1));
  }
  const s = setup(replies, results);
  for (let i = 0; i < MAX_CHAT_TURNS + 2; i++) {
    s.session.ask(`q${i}?`);
    await settle(s.session);
  }
  assert.equal(s.session.snapshot().turns.length, MAX_CHAT_TURNS);
  assert.equal(s.session.snapshot().turns[0]!.question, "q2?");
  s.session.clear();
  assert.deepEqual(s.session.snapshot().turns, []);
});

test("dispose aborts the run and drops the conversation", async () => {
  let aborted = false;
  const s = setup(
    [
      (signal) =>
        // eslint-disable-next-line require-yield
        (async function* () {
          await new Promise((r) => signal.addEventListener("abort", r));
          aborted = true;
          throw new BackendError("cancelled");
        })(),
    ],
    [],
  );
  s.session.ask("x?");
  await tick();
  const before = s.events.length;
  s.session.dispose();
  await tick();
  await tick();
  assert.equal(aborted, true);
  assert.equal(s.events.length, before);
  assert.deepEqual(s.session.snapshot().turns, []);
});

class FakePort implements PortLike {
  sent: unknown[] = [];
  disconnected = false;
  private msg: ((m: unknown) => void)[] = [];
  private disc: (() => void)[] = [];
  name: string;
  sender: { id?: string; tab?: { id?: number } };
  constructor(name: string, sender: { id?: string; tab?: { id?: number } }) {
    this.name = name;
    this.sender = sender;
  }
  postMessage(m: unknown): void {
    this.sent.push(m);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  onMessage = { addListener: (cb: (m: unknown) => void) => void this.msg.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => void this.disc.push(cb) };
  receive(m: unknown): void {
    for (const cb of this.msg) cb(m);
  }
  close(): void {
    for (const cb of this.disc) cb();
  }
}

test("chat connection: foreign senders are refused; own tab gets an empty snapshot and can ask", async () => {
  const deps = setup([['{"text":"x"}'], ["ok [1]"]], [hits(1)]);
  const foreign = new FakePort("chat", { id: "evil@x" });
  handleChatConnection(foreign, { backend: deps.backend, search: async () => ({ headers: [], complete: true }), load: async (id) => mail(id), settings: async () => defaultSettings() }, "me@x");
  assert.equal(foreign.disconnected, true);

  const port = new FakePort("chat", { id: "me@x", tab: { id: 7 } });
  const reported: number[] = [];
  handleChatConnection(port, { backend: deps.backend, search: async () => ({ headers: hits(1), complete: true }), load: async (id) => mail(id), settings: async () => defaultSettings() }, "me@x", (id) => reported.push(id));
  assert.deepEqual(reported, [7]);
  assert.deepEqual(port.sent[0], { type: "snapshot", snapshot: { turns: [] } });
  port.receive({ type: "ask", question: 42 });
  port.receive({ type: "ask", question: "x?" });
  for (let i = 0; i < 20; i++) await tick();
  const last = port.sent[port.sent.length - 1] as { snapshot: ChatSnapshot };
  assert.equal(last.snapshot.turns[0]!.status, "done");
  const count = port.sent.length;
  port.close();
  port.receive({ type: "ask", question: "again?" });
  await tick();
  assert.equal(port.sent.length, count);
});

test("chat requests and events are validated", () => {
  assert.deepEqual(parseChatRequest({ type: "ask", question: "  hi " }), { type: "ask", question: "hi" });
  assert.equal(parseChatRequest({ type: "ask", question: "   " }), null);
  assert.equal(parseChatRequest({ type: "ask", question: "x".repeat(5000) }), null);
  assert.deepEqual(parseChatRequest({ type: "cancel" }), { type: "cancel" });
  assert.deepEqual(parseChatRequest({ type: "clear" }), { type: "clear" });
  assert.equal(parseChatRequest({ type: "start" }), null);
  assert.equal(parseChatEvent({ type: "snapshot", snapshot: { turns: [{ question: "q" }] } }), null);
  assert.equal(parseChatEvent({ type: "delta", text: 1 }), null);
  const turn = { question: "q", status: "done", answer: "a", sources: [{ index: 1, messageId: 3, from: "f", subject: "s", date: "" }], found: 1, foundComplete: true, sent: 1, truncated: false, search: { queries: [{ text: "x", folder: "y" }], source: "model", relaxed: false } };
  assert.equal(parseChatEvent({ type: "snapshot", snapshot: { turns: [turn] } }), null, "unknown search field");
});


class FakeSessionArea {
  data = new Map<string, unknown>();
  async get(k: string | string[] | null): Promise<Record<string, unknown>> {
    const keys = k === null ? [...this.data.keys()] : Array.isArray(k) ? k : [k];
    return Object.fromEntries(keys.filter((x) => this.data.has(x)).map((x) => [x, this.data.get(x)]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
  }
  async remove(k: string | string[]): Promise<void> {
    for (const x of Array.isArray(k) ? k : [k]) this.data.delete(x);
  }
}

test("chat tab: reused while open, recreated after close or failure, one tab for a double click", async () => {
  const session = new FakeSessionArea();
  let nextId = 10;
  const created: number[] = [];
  const activated: number[] = [];
  const open = new Set<number>();
  const deps = {
    session,
    create: async () => {
      await tick();
      const id = nextId++;
      created.push(id);
      open.add(id);
      return { id };
    },
    activate: async (id: number) => {
      if (!open.has(id)) throw new Error("no tab");
      activated.push(id);
    },
  };
  const tracker = new ChatTabTracker(deps);
  await Promise.all([tracker.open(), tracker.open()]);
  assert.deepEqual(created, [10]);
  await tracker.open();
  assert.deepEqual(activated, [10]);

  // A restarted background script finds the tab through storage.session.
  const again = new ChatTabTracker(deps);
  await again.open();
  assert.deepEqual(created, [10]);
  assert.deepEqual(activated, [10, 10]);

  open.delete(10);
  await again.onTabRemoved(10);
  await again.open();
  assert.deepEqual(created, [10, 11]);

  // A stale id (tab gone without an event) leads to a new tab.
  open.delete(11);
  await again.open();
  assert.deepEqual(created, [10, 11, 12]);

  // A restored chat tab reports itself and is focused instead of opening another one.
  open.add(42);
  await again.adopt(42);
  await again.open();
  assert.deepEqual(created, [10, 11, 12]);
  assert.equal(activated[activated.length - 1], 42);
});
