// Message formats between the chat tab and the background script (runtime.connect port "chat"),
// and the one chat setting. Pure (no messenger.*) so it can be tested in Node.
import { BACKEND_ERROR_CODES } from "../backend/backend.ts";
import type { BackendErrorCode } from "../backend/backend.ts";
import { MAX_QUESTION_CHARS } from "../prompts/read.ts";
import { MAX_FIELD_CHARS, SEARCH_FIELDS } from "../prompts/query.ts";
import type { SearchField, SearchParams } from "../prompts/query.ts";
import { MAX_TEXT_CHARS } from "./job-messages.ts";
import { MAX_MESSAGES_BOUNDS } from "./settings.ts";

export const PORT_CHAT = "chat";

/** Most turns shown in the chat; the oldest are dropped first. */
export const MAX_CHAT_TURNS = 20;
/** Most queries in one search plan (fallback words or loosened search). */
const MAX_QUERIES = 4;
/** Longest sender or subject in the source list; longer values are cut by the background script. */
export const MAX_HEADER_CHARS = 300;

export type ChatError = BackendErrorCode | "empty_result" | "search_failed";
export type TurnStatus = "running" | "done" | "no_results" | "error" | "cancelled";
export type TurnStage = "params" | "search" | "load" | "answer";

export interface ChatSource {
  /** 1-based number used by the citations. */
  index: number;
  messageId: number;
  from: string;
  subject: string;
  /** ISO string or "". */
  date: string;
}

export interface ChatSearchInfo {
  queries: SearchParams[];
  /** "fallback": step 1 gave no valid output, the words of the question were searched. */
  source: "model" | "fallback";
  /** A first search found nothing and a looser one was run. */
  relaxed: boolean;
}

export interface ChatTurn {
  question: string;
  status: TurnStatus;
  stage?: TurnStage;
  /** Streamed text while running, the answer when done. */
  answer: string;
  error?: ChatError;
  search?: ChatSearchInfo;
  sources: ChatSource[];
  /** Distinct matching mails seen by the search (at most the scan limit). */
  found: number;
  /** False if the search stopped at the scan limit. */
  foundComplete: boolean;
  /** Mails sent to the model. */
  sent: number;
  truncated: boolean;
}

export interface ChatSnapshot {
  turns: ChatTurn[];
}

export type ChatRequest = { type: "ask"; question: string } | { type: "cancel" } | { type: "clear" };
export type ChatEvent = { type: "snapshot"; snapshot: ChatSnapshot } | { type: "delta"; text: string };

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseChatRequest(message: unknown): ChatRequest | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  switch (m["type"]) {
    case "ask": {
      const q = m["question"];
      if (!isStr(q, MAX_QUESTION_CHARS) || q.trim() === "") return null;
      return { type: "ask", question: q.trim() };
    }
    case "cancel":
    case "clear":
      return { type: m["type"] };
    default:
      return null;
  }
}

const STATUSES: readonly string[] = ["running", "done", "no_results", "error", "cancelled"];
const STAGES: readonly string[] = ["params", "search", "load", "answer"];
const ERRORS: readonly string[] = [...BACKEND_ERROR_CODES, "empty_result", "search_failed"];

function parseParams(v: unknown): SearchParams | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: SearchParams = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!(SEARCH_FIELDS as readonly string[]).includes(k) || !isStr(x, MAX_FIELD_CHARS)) return null;
    out[k as SearchField] = x;
  }
  return out;
}

function parseSearch(v: unknown): ChatSearchInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if ((s["source"] !== "model" && s["source"] !== "fallback") || typeof s["relaxed"] !== "boolean") return null;
  if (!Array.isArray(s["queries"]) || s["queries"].length > MAX_QUERIES) return null;
  const queries: SearchParams[] = [];
  for (const q of s["queries"] as unknown[]) {
    const p = parseParams(q);
    if (!p) return null;
    queries.push(p);
  }
  return { queries, source: s["source"], relaxed: s["relaxed"] };
}

function parseSource(v: unknown): ChatSource | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (!isCount(s["index"]) || !isCount(s["messageId"])) return null;
  if (!isStr(s["from"], MAX_HEADER_CHARS) || !isStr(s["subject"], MAX_HEADER_CHARS) || !isStr(s["date"], 64)) return null;
  return { index: s["index"], messageId: s["messageId"], from: s["from"], subject: s["subject"], date: s["date"] };
}

function parseTurn(v: unknown): ChatTurn | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  if (!isStr(t["question"], MAX_QUESTION_CHARS) || !isStr(t["answer"], MAX_TEXT_CHARS)) return null;
  if (typeof t["status"] !== "string" || !STATUSES.includes(t["status"])) return null;
  if (!isCount(t["found"]) || !isCount(t["sent"]) || typeof t["foundComplete"] !== "boolean" || typeof t["truncated"] !== "boolean") return null;
  if (!Array.isArray(t["sources"]) || t["sources"].length > MAX_MESSAGES_BOUNDS.max) return null;
  const sources: ChatSource[] = [];
  for (const s of t["sources"] as unknown[]) {
    const src = parseSource(s);
    if (!src) return null;
    sources.push(src);
  }
  const turn: ChatTurn = {
    question: t["question"],
    status: t["status"] as TurnStatus,
    answer: t["answer"],
    sources,
    found: t["found"],
    foundComplete: t["foundComplete"],
    sent: t["sent"],
    truncated: t["truncated"],
  };
  if (t["stage"] !== undefined) {
    if (typeof t["stage"] !== "string" || !STAGES.includes(t["stage"])) return null;
    turn.stage = t["stage"] as TurnStage;
  }
  if (t["error"] !== undefined) {
    if (typeof t["error"] !== "string" || !ERRORS.includes(t["error"])) return null;
    turn.error = t["error"] as ChatError;
  }
  if (t["search"] !== undefined) {
    const search = parseSearch(t["search"]);
    if (!search) return null;
    turn.search = search;
  }
  return turn;
}

/** Validates a message from the background script; null if it does not fit. */
export function parseChatEvent(message: unknown): ChatEvent | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m["type"] === "delta") return typeof m["text"] === "string" ? { type: "delta", text: m["text"] } : null;
  if (m["type"] !== "snapshot") return null;
  const s = m["snapshot"];
  if (typeof s !== "object" || s === null) return null;
  const raw = (s as Record<string, unknown>)["turns"];
  if (!Array.isArray(raw) || raw.length > MAX_CHAT_TURNS) return null;
  const turns: ChatTurn[] = [];
  for (const t of raw as unknown[]) {
    const turn = parseTurn(t);
    if (!turn) return null;
    turns.push(turn);
  }
  return { type: "snapshot", snapshot: { turns } };
}
