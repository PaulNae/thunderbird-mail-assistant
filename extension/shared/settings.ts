// User settings (storage.local, key "settings"): models per task and limits. Never mail content.
// Values are validated whenever they are read; anything unusable falls back to its default.
// Pure (no messenger.*) so it can be tested in Node.
import { DRAFT_MODEL, REWRITE_MODEL } from "../prompts/compose.ts";
import { QUESTION_MODEL, SUMMARY_MODEL } from "../prompts/read.ts";
import { QUERY_ANSWER_MODEL } from "../prompts/query.ts";
import { MAX_MESSAGE_CHARS } from "../mail/thread-select.ts";
import type { ThreadLimits } from "../mail/thread-select.ts";
import { DEFAULT_THREAD_LIMITS } from "../mail/thread-select.ts";
import { QUERY_MAX_MESSAGE_CHARS } from "../mail/search-select.ts";
import type { SearchLimits } from "../mail/search-select.ts";
import type { LocalArea } from "./consent.ts";

export const SETTINGS_KEY = "settings";
/** Key of the 0.5 setting "most mails per mailbox question" (chat tab); read as a fallback, removed on save. */
export const LEGACY_MAX_MESSAGES_KEY = "queryMaxMessages";

export const MODEL_CHOICES = ["haiku", "sonnet", "opus"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

/** Task kinds with their own model setting. */
export const MODEL_TASKS = ["rewrite", "draft", "summary", "question", "query"] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

export interface Bounds {
  min: number;
  max: number;
  def: number;
}

/** Most mails sent to the model per mailbox question. */
export const MAX_MESSAGES_BOUNDS: Bounds = { min: 1, max: 50, def: 15 };
/**
 * Most characters of mail text per request (thread, search hits, own text, original mail). One value
 * replaces the earlier separate constants; its default is the former thread budget (40 000), so the own
 * text and the original mail may now be longer (was 30 000) and the search hits shorter (was 50 000).
 */
export const MAX_TEXT_BOUNDS: Bounds = { min: 5000, max: 100000, def: 40000 };
/** Time limit of one model run in seconds (within the host's bounds of 10 s to 600 s). */
export const TIMEOUT_BOUNDS: Bounds = { min: 30, max: 600, def: 120 };

export interface Settings {
  models: Record<ModelTask, ModelChoice>;
  maxMessages: number;
  maxTextChars: number;
  timeoutSec: number;
}

export const DEFAULT_MODELS: Record<ModelTask, ModelChoice> = {
  rewrite: REWRITE_MODEL,
  draft: DRAFT_MODEL,
  summary: SUMMARY_MODEL,
  question: QUESTION_MODEL,
  query: QUERY_ANSWER_MODEL,
};

export function defaultSettings(): Settings {
  return {
    models: { ...DEFAULT_MODELS },
    maxMessages: MAX_MESSAGES_BOUNDS.def,
    maxTextChars: MAX_TEXT_BOUNDS.def,
    timeoutSec: TIMEOUT_BOUNDS.def,
  };
}

const isModel = (v: unknown): v is ModelChoice => typeof v === "string" && (MODEL_CHOICES as readonly string[]).includes(v);

/** A whole number within the bounds; numeric strings are accepted (form input); anything else gives the default. */
export function clampInt(v: unknown, b: Bounds): number {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof x !== "number" || !Number.isFinite(x)) return b.def;
  return Math.min(b.max, Math.max(b.min, Math.round(x)));
}

/** Builds valid settings from untrusted stored data. `legacyMaxMessages` is the 0.5 chat setting. */
export function sanitizeSettings(raw: unknown, legacyMaxMessages?: unknown): Settings {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const m = typeof r["models"] === "object" && r["models"] !== null ? (r["models"] as Record<string, unknown>) : {};
  const models = { ...DEFAULT_MODELS };
  for (const task of MODEL_TASKS) {
    const v = m[task];
    if (isModel(v)) models[task] = v;
  }
  return {
    models,
    maxMessages: clampInt(r["maxMessages"] ?? legacyMaxMessages, MAX_MESSAGES_BOUNDS),
    maxTextChars: clampInt(r["maxTextChars"], MAX_TEXT_BOUNDS),
    timeoutSec: clampInt(r["timeoutSec"], TIMEOUT_BOUNDS),
  };
}

/** Reads and validates the settings; a failing storage gives the defaults. */
export async function readSettings(area: Pick<LocalArea, "get">): Promise<Settings> {
  try {
    const got = await area.get([SETTINGS_KEY, LEGACY_MAX_MESSAGES_KEY]);
    return sanitizeSettings(got[SETTINGS_KEY], got[LEGACY_MAX_MESSAGES_KEY]);
  } catch {
    return defaultSettings();
  }
}

/** Stores validated settings and drops the 0.5 key. Returns what was stored. */
export async function writeSettings(area: Pick<LocalArea, "set" | "remove">, settings: unknown): Promise<Settings> {
  const clean = sanitizeSettings(settings);
  await area.set({ [SETTINGS_KEY]: clean });
  await area.remove(LEGACY_MAX_MESSAGES_KEY);
  return clean;
}

/** Moves the 0.5 key into the settings object (only if there is no settings object yet). */
export async function migrateLegacySettings(area: LocalArea): Promise<boolean> {
  const got = await area.get([SETTINGS_KEY, LEGACY_MAX_MESSAGES_KEY]);
  if (!(LEGACY_MAX_MESSAGES_KEY in got)) return false;
  if (got[SETTINGS_KEY] === undefined) await writeSettings(area, sanitizeSettings(undefined, got[LEGACY_MAX_MESSAGES_KEY]));
  else await area.remove(LEGACY_MAX_MESSAGES_KEY);
  return true;
}

/** The model of a popup job kind. */
export function modelForKind(s: Settings, kind: "summary" | "question" | "compose" | "reply" | "instruction_draft"): ModelChoice {
  switch (kind) {
    case "compose":
      return s.models.rewrite;
    case "reply":
    case "instruction_draft":
      return s.models.draft;
    case "summary":
      return s.models.summary;
    case "question":
      return s.models.question;
  }
}

export const timeoutMs = (s: Settings): number => s.timeoutSec * 1000;

/** Thread context of the mail display within the text limit. */
export function threadLimits(s: Settings): ThreadLimits {
  return { ...DEFAULT_THREAD_LIMITS, maxChars: s.maxTextChars, maxMessageChars: Math.min(MAX_MESSAGE_CHARS, s.maxTextChars) };
}

/** Search hits of a mailbox question within the text limit. */
export function searchLimits(s: Settings): SearchLimits {
  return { maxTotalChars: s.maxTextChars, maxMessageChars: Math.min(QUERY_MAX_MESSAGE_CHARS, s.maxTextChars) };
}
