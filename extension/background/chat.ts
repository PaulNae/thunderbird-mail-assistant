// Mailbox queries of the chat tab: question -> search parameters (step 1) -> search (step 2) -> answer
// with citations (step 3). One ChatSession per connected chat tab; it lives as long as the tab's port,
// so the conversation is bound to the tab and gone when the tab closes. Everything stays in memory:
// nothing is mirrored to storage.session or written anywhere. Pure apart from injected dependencies.
import { BackendError } from "../backend/backend.ts";
import type { Backend } from "../backend/backend.ts";
import { cleanModelOutput } from "../prompts/compose.ts";
import { isBlank } from "../compose/editor-text.ts";
import {
  MAX_PARAMS_OUTPUT_CHARS,
  QUERY_ANSWER_MODEL,
  QUERY_PARAMS_MODEL,
  buildAnswerPrompt,
  buildParamsPrompt,
  fallbackQueries,
  parseSearchParams,
  relaxPlan,
} from "../prompts/query.ts";
import type { SearchParams, SearchPlan } from "../prompts/query.ts";
import type { LoadedMessage } from "../mail/types.ts";
import { pickNewest, scanLimit, selectResults } from "../mail/search-select.ts";
import type { FoundHeader, SearchLimits } from "../mail/search-select.ts";
import { isOwnSender } from "../shared/messages.ts";
import { MAX_TEXT_CHARS } from "../shared/job-messages.ts";
import { MAX_CHAT_TURNS, PORT_CHAT, parseChatRequest, sanitizeMaxMessages } from "../shared/chat-messages.ts";
import type { ChatEvent, ChatSnapshot, ChatTurn } from "../shared/chat-messages.ts";
import type { PortLike } from "./connection.ts";

/** Parallel mail loads in step 2. */
const LOAD_CONCURRENCY = 4;

export interface ChatDeps {
  backend: Pick<Backend, "run">;
  /** Runs the searches (OR) until `limit` distinct mails are found. Rejects with BackendError("cancelled") on abort. */
  search(queries: readonly SearchParams[], limit: number, signal: AbortSignal): Promise<{ headers: FoundHeader[]; complete: boolean }>;
  /** Header and text of one mail. Errors never contain mail content. */
  load(messageId: number): Promise<LoadedMessage>;
  /** The setting "most mails per question" (sanitized here). */
  maxMessages(): Promise<unknown>;
  now?: () => Date;
  limits?: SearchLimits;
}

/** Marks failures of the mail search, so they are not reported as backend errors. */
class SearchFailed extends Error {}

export class ChatSession {
  private turns: ChatTurn[] = [];
  private ctl: AbortController | null = null;
  private disposed = false;
  private readonly deps: ChatDeps;
  private readonly emit: (event: ChatEvent) => void;

  constructor(deps: ChatDeps, emit: (event: ChatEvent) => void) {
    this.deps = deps;
    this.emit = emit;
  }

  snapshot(): ChatSnapshot {
    return { turns: this.turns.map((t) => ({ ...t, sources: [...t.sources], ...(t.search ? { search: { ...t.search, queries: [...t.search.queries] } } : {}) })) };
  }

  private publish(): void {
    if (!this.disposed) this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  get running(): boolean {
    return this.ctl !== null;
  }

  /** Starts a run unless one is running (then the current state is sent again). */
  ask(question: string): void {
    if (this.disposed) return;
    const q = question.trim();
    if (this.ctl || q === "") {
      this.publish();
      return;
    }
    const ctl = new AbortController();
    this.ctl = ctl;
    const earlier = this.turns.filter((t) => t.status === "done");
    const turn: ChatTurn = { question: q, status: "running", stage: "params", answer: "", sources: [], found: 0, foundComplete: true, sent: 0, truncated: false };
    this.turns.push(turn);
    while (this.turns.length > MAX_CHAT_TURNS) this.turns.shift();
    this.publish();
    void this.run(turn, earlier, ctl);
  }

  cancel(): void {
    this.ctl?.abort();
  }

  /** Forgets the conversation (a running job is aborted). */
  clear(): void {
    this.ctl?.abort();
    this.ctl = null;
    this.turns = [];
    this.publish();
  }

  /** The tab is gone: abort and forget everything. */
  dispose(): void {
    this.disposed = true;
    this.ctl?.abort();
    this.ctl = null;
    this.turns = [];
  }

  private current(turn: ChatTurn, ctl: AbortController): boolean {
    return !this.disposed && this.ctl === ctl && this.turns.includes(turn);
  }

  private async collect(system: string, prompt: string, model: string, signal: AbortSignal, max: number): Promise<string> {
    let text = "";
    for await (const chunk of this.deps.backend.run({ system, prompt, model, signal })) {
      if (text.length <= max) text += chunk;
    }
    if (signal.aborted) throw new BackendError("cancelled");
    return text;
  }

  /** Step 1: the model output is validated strictly; one retry, then the words of the question. */
  private async plan(question: string, earlier: readonly ChatTurn[], signal: AbortSignal): Promise<SearchPlan> {
    const now = (this.deps.now ?? (() => new Date()))();
    const parts = buildParamsPrompt(question, now, earlier.map((t) => t.question));
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.collect(parts.system, parts.prompt, QUERY_PARAMS_MODEL, signal, MAX_PARAMS_OUTPUT_CHARS);
      const params = parseSearchParams(raw, now);
      if (params) return { queries: [params], source: "model" };
    }
    return { queries: fallbackQueries(question), source: "fallback" };
  }

  private async search(plan: SearchPlan, limit: number, signal: AbortSignal): Promise<{ headers: FoundHeader[]; complete: boolean }> {
    if (plan.queries.length === 0) return { headers: [], complete: true };
    try {
      return await this.deps.search(plan.queries, limit, signal);
    } catch (e) {
      if (signal.aborted || (e instanceof BackendError && e.code === "cancelled")) throw new BackendError("cancelled");
      throw new SearchFailed();
    }
  }

  /** Loads the chosen mails; a mail that cannot be read is skipped. Keeps the given order. */
  private async loadAll(headers: readonly FoundHeader[], signal: AbortSignal): Promise<LoadedMessage[]> {
    const out: (LoadedMessage | null)[] = new Array<LoadedMessage | null>(headers.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < headers.length) {
        if (signal.aborted) return;
        const i = next++;
        try {
          out[i] = await this.deps.load(headers[i]!.id);
        } catch {
          out[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, headers.length) }, worker));
    if (signal.aborted) throw new BackendError("cancelled");
    return out.filter((m): m is LoadedMessage => m !== null);
  }

  private async run(turn: ChatTurn, earlier: readonly ChatTurn[], ctl: AbortController): Promise<void> {
    const { signal } = ctl;
    const update = (patch: Partial<ChatTurn>): boolean => {
      if (!this.current(turn, ctl)) return false;
      Object.assign(turn, patch);
      this.publish();
      return true;
    };
    // Ends the run: the turn gets its final state and the next question may start.
    const finish = (patch: Partial<ChatTurn>): void => {
      if (!this.current(turn, ctl)) return;
      this.ctl = null;
      delete turn.stage;
      Object.assign(turn, patch);
      this.publish();
    };
    try {
      const plan = await this.plan(turn.question, earlier, signal);
      if (!update({ stage: "search", search: { queries: plan.queries, source: plan.source, relaxed: false } })) return;

      const max = sanitizeMaxMessages(await this.deps.maxMessages().catch(() => undefined));
      const limit = scanLimit(max);
      let result = await this.search(plan, limit, signal);
      if (result.headers.length === 0) {
        const looser = relaxPlan(plan);
        if (looser) {
          if (!update({ search: { queries: looser.queries, source: plan.source, relaxed: true } })) return;
          result = await this.search(looser, limit, signal);
        }
      }
      if (result.headers.length === 0) {
        finish({ status: "no_results" });
        return;
      }

      const chosen = pickNewest(result.headers, max);
      if (!update({ stage: "load", found: result.headers.length, foundComplete: result.complete })) return;
      const loaded = await this.loadAll(chosen, signal);
      if (loaded.length === 0) throw new SearchFailed();
      const selected = selectResults(loaded, this.deps.limits);
      const sources = selected.messages.map((m, i) => ({ index: i + 1, messageId: m.id, from: m.from, subject: m.subject, date: m.date }));
      // Found but not sent: beyond the setting, unreadable, or over the text budget.
      const omitted = Math.max(0, result.headers.length - selected.messages.length);
      if (!update({ stage: "answer", sources, sent: sources.length, truncated: selected.truncated })) return;

      const history = earlier.map((t) => ({ question: t.question, answer: t.answer }));
      const parts = buildAnswerPrompt(turn.question, { messages: selected.messages, omittedCount: omitted, truncated: selected.truncated }, history);
      let text = "";
      for await (const chunk of this.deps.backend.run({ system: parts.system, prompt: parts.prompt, model: QUERY_ANSWER_MODEL, signal })) {
        if (!this.current(turn, ctl)) return;
        const room = MAX_TEXT_CHARS - text.length;
        if (room <= 0) continue;
        const part = chunk.length > room ? chunk.slice(0, room) : chunk;
        text += part;
        turn.answer = text;
        this.emit({ type: "delta", text: part });
      }
      if (signal.aborted) throw new BackendError("cancelled");
      const cleaned = cleanModelOutput(text);
      if (isBlank(cleaned)) finish({ status: "error", error: "empty_result", answer: "" });
      else finish({ status: "done", answer: cleaned });
    } catch (e) {
      if (signal.aborted || (e instanceof BackendError && e.code === "cancelled")) finish({ status: "cancelled", answer: "" });
      else if (e instanceof SearchFailed) finish({ status: "error", error: "search_failed", answer: "" });
      else finish({ status: "error", error: e instanceof BackendError ? e.code : "internal", answer: "" });
    }
  }
}

/** Connects a chat tab's port to its own session; the session ends with the port. */
export function handleChatConnection(port: PortLike, deps: ChatDeps, ownId: string): void {
  if (port.name !== PORT_CHAT || !isOwnSender(port.sender?.id, ownId)) {
    port.disconnect();
    return;
  }
  let closed = false;
  const session = new ChatSession(deps, (event) => {
    if (closed) return;
    try {
      port.postMessage(event);
    } catch {
      // The tab is gone; onDisconnect cleans up.
    }
  });
  port.onMessage.addListener((raw) => {
    const req = parseChatRequest(raw);
    if (!req) return;
    if (req.type === "ask") session.ask(req.question);
    else if (req.type === "cancel") session.cancel();
    else session.clear();
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    session.dispose();
  });
  try {
    port.postMessage({ type: "snapshot", snapshot: session.snapshot() } satisfies ChatEvent);
  } catch {
    // ignore
  }
}
