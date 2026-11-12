// Message formats between the popups and the background job store (runtime.connect ports).
// Pure (no messenger.*) so it can be tested in Node. Incoming messages are validated like in messages.ts.
import { BACKEND_ERROR_CODES } from "../backend/backend.ts";
import type { BackendErrorCode } from "../backend/backend.ts";
import type { ComposeAction } from "../prompts/compose.ts";
import { MAX_HISTORY_ENTRIES, MAX_QUESTION_CHARS } from "../prompts/read.ts";
import type { HistoryEntry } from "../prompts/read.ts";
import type { PopupJob } from "../compose/popup-state.ts";
import { MAX_NOTES_CHARS } from "./messages.ts";

export const PORT_DISPLAY = "display";
export const PORT_COMPOSE = "compose";
export type PortName = typeof PORT_DISPLAY | typeof PORT_COMPOSE;

/** Longest text kept per entry (streamed text, summary, one answer, preview). */
export const MAX_TEXT_CHARS = 60000;
/** Most entries (mails and compose windows) held at once; the oldest are dropped first. */
export const MAX_ENTRIES = 20;
/** Sanity limits for what a popup may send; the real prompt limits are enforced when the prompt is built. */
export const MAX_SYSTEM_CHARS = 100000;
export const MAX_PROMPT_CHARS = 1000000;
const MAX_INSTRUCTION_CHARS = 4000;

export type JobKind = "summary" | "question" | "compose" | "reply" | "instruction_draft";
export type JobPhase = "idle" | "streaming" | "done" | "error" | "cancelled";
export type JobError = BackendErrorCode | "empty_result";

/** What a popup sees of an entry. Never contains prompts. */
export interface JobSnapshot {
  phase: JobPhase;
  kind?: JobKind;
  /** Streamed text of the running job; for compose also the finished preview. */
  text: string;
  error?: JobError;
  /** Mail display only: the message the entry belongs to. */
  messageId?: number;
  /** Mail display only: the last successful summary. */
  summary: string;
  /** Mail display only: finished questions and answers. */
  history: HistoryEntry[];
  /** Mail display only: the question of the running job. */
  question?: string;
  /** Compose only: the job, so "regenerate" survives closing the popup. */
  job?: PopupJob;
}

export function emptySnapshot(): JobSnapshot {
  return { phase: "idle", text: "", summary: "", history: [] };
}

export interface StartRequest {
  kind: JobKind;
  system: string;
  prompt: string;
  messageId?: number;
  question?: string;
  job?: PopupJob;
}

export type PortRequest =
  | { type: "open"; tabId: number; messageId?: number }
  | { type: "start"; start: StartRequest }
  | { type: "cancel" }
  | { type: "discard" }
  | { type: "applied" };

export type PortEvent = { type: "snapshot"; snapshot: JobSnapshot } | { type: "delta"; text: string };

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function parseComposeAction(v: unknown): ComposeAction | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  switch (a["kind"]) {
    case "rephrase":
    case "shorten":
      return { kind: a["kind"] };
    case "tone":
      return a["tone"] === "friendly" || a["tone"] === "formal" || a["tone"] === "concise" ? { kind: "tone", tone: a["tone"] } : null;
    case "translate":
      return a["lang"] === "de" || a["lang"] === "en" ? { kind: "translate", lang: a["lang"] } : null;
    case "custom":
      return isStr(a["instruction"], MAX_INSTRUCTION_CHARS) ? { kind: "custom", instruction: a["instruction"] } : null;
    default:
      return null;
  }
}

export function parseJob(v: unknown): PopupJob | null {
  if (typeof v !== "object" || v === null) return null;
  const j = v as Record<string, unknown>;
  if (j["type"] === "compose") {
    const action = parseComposeAction(j["action"]);
    return action ? { type: "compose", action } : null;
  }
  if (j["type"] === "reply") return isStr(j["notes"], MAX_NOTES_CHARS) ? { type: "reply", notes: j["notes"] } : null;
  if (j["type"] === "instruction_draft") {
    return isStr(j["instruction"], MAX_INSTRUCTION_CHARS) ? { type: "instruction_draft", instruction: j["instruction"] } : null;
  }
  return null;
}

function parseStart(port: PortName, m: Record<string, unknown>): StartRequest | null {
  const { system, prompt } = m;
  if (!isStr(system, MAX_SYSTEM_CHARS) || !isStr(prompt, MAX_PROMPT_CHARS) || prompt === "") return null;
  // A "model" field is ignored: the background script picks the model from the settings.
  const base = { system, prompt };
  if (port === PORT_DISPLAY) {
    if (!isId(m["messageId"])) return null;
    if (m["kind"] === "summary") return { kind: "summary", ...base, messageId: m["messageId"] };
    if (m["kind"] === "question") {
      const q = m["question"];
      if (!isStr(q, MAX_QUESTION_CHARS) || q.trim() === "") return null;
      return { kind: "question", ...base, messageId: m["messageId"], question: q.trim() };
    }
    return null;
  }
  const job = parseJob(m["job"]);
  return job ? { kind: job.type, ...base, job } : null;
}

/** Validates a message from a popup; null for anything unknown or malformed. */
export function parsePortRequest(port: PortName, message: unknown): PortRequest | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  switch (m["type"]) {
    case "open":
      if (!isId(m["tabId"])) return null;
      if (m["messageId"] === undefined || port === PORT_COMPOSE) return { type: "open", tabId: m["tabId"] };
      return isId(m["messageId"]) ? { type: "open", tabId: m["tabId"], messageId: m["messageId"] } : null;
    case "start": {
      const start = parseStart(port, m);
      return start ? { type: "start", start } : null;
    }
    case "cancel":
      return { type: "cancel" };
    case "discard":
    case "applied":
      return port === PORT_COMPOSE ? { type: m["type"] } : null;
    default:
      return null;
  }
}

export function portName(name: unknown): PortName | null {
  return name === PORT_DISPLAY || name === PORT_COMPOSE ? name : null;
}

const PHASES: readonly string[] = ["idle", "streaming", "done", "error", "cancelled"];
const KINDS: readonly string[] = ["summary", "question", "compose", "reply", "instruction_draft"];
const ERRORS: readonly string[] = [...BACKEND_ERROR_CODES, "empty_result"];

/** Rebuilds a snapshot from untrusted data (the session mirror); null if it does not fit. */
export function sanitizeSnapshot(raw: unknown): JobSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["phase"] !== "string" || !PHASES.includes(r["phase"])) return null;
  if (!isStr(r["text"], MAX_TEXT_CHARS) || !isStr(r["summary"], MAX_TEXT_CHARS) || !Array.isArray(r["history"])) return null;
  const history: HistoryEntry[] = [];
  for (const h of r["history"].slice(-MAX_HISTORY_ENTRIES) as unknown[]) {
    if (typeof h !== "object" || h === null) return null;
    const e = h as Record<string, unknown>;
    if (!isStr(e["question"], MAX_QUESTION_CHARS) || !isStr(e["answer"], MAX_TEXT_CHARS)) return null;
    history.push({ question: e["question"], answer: e["answer"] });
  }
  const snap: JobSnapshot = { phase: r["phase"] as JobPhase, text: r["text"], summary: r["summary"], history };
  if (r["kind"] !== undefined) {
    if (typeof r["kind"] !== "string" || !KINDS.includes(r["kind"])) return null;
    snap.kind = r["kind"] as JobKind;
  }
  if (r["error"] !== undefined) {
    if (typeof r["error"] !== "string" || !ERRORS.includes(r["error"])) return null;
    snap.error = r["error"] as JobError;
  }
  if (r["messageId"] !== undefined) {
    if (!isId(r["messageId"])) return null;
    snap.messageId = r["messageId"];
  }
  if (r["question"] !== undefined) {
    if (!isStr(r["question"], MAX_QUESTION_CHARS)) return null;
    snap.question = r["question"];
  }
  if (r["job"] !== undefined) {
    const job = parseJob(r["job"]);
    if (!job) return null;
    snap.job = job;
  }
  return snap;
}

/** Validates a message from the background script; null if it does not fit. */
export function parsePortEvent(message: unknown): PortEvent | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m["type"] === "delta") return typeof m["text"] === "string" ? { type: "delta", text: m["text"] } : null;
  if (m["type"] === "snapshot") {
    const snapshot = sanitizeSnapshot(m["snapshot"]);
    return snapshot ? { type: "snapshot", snapshot } : null;
  }
  return null;
}
