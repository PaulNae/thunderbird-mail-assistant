// Pure selection and truncation of search hits for a mailbox query (no messenger.*, testable in Node).
import { TRUNCATION_MARKER } from "../prompts/compose.ts";
import type { LoadedMessage } from "./types.ts";

/** Most body characters of one mail sent to the model. */
export const QUERY_MAX_MESSAGE_CHARS = 5000;
/** Most body characters of all mails of one answer together. */
export const QUERY_MAX_TOTAL_CHARS = 50000;
/** A mail is only included in shortened form if at least this much budget is left. */
export const QUERY_MIN_PARTIAL_CHARS = 500;
/**
 * Most headers looked at per question; the newest of them are used. The order of messages.query is not
 * documented, so many cheap headers are scanned and only the chosen mails are loaded.
 */
export const QUERY_MAX_SCAN = 1000;

const MARK = "\n" + TRUNCATION_MARKER;

export interface FoundHeader {
  id: number;
  date?: Date | undefined;
}

export interface SearchLimits {
  maxMessageChars: number;
  maxTotalChars: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxMessageChars: QUERY_MAX_MESSAGE_CHARS,
  maxTotalChars: QUERY_MAX_TOTAL_CHARS,
};

/** Headers scanned for a question; independent of the setting, at least as many as can be sent. */
export function scanLimit(maxMessages: number): number {
  return Math.max(QUERY_MAX_SCAN, maxMessages);
}

function time(d: Date | undefined): number {
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The `max` newest distinct headers, newest first; mails without a valid date come last. */
export function pickNewest<T extends FoundHeader>(headers: readonly T[], max: number): T[] {
  const seen = new Set<number>();
  return headers
    .filter((h) => !seen.has(h.id) && seen.add(h.id))
    .map((h, i) => ({ h, i }))
    .sort((a, b) => time(b.h.date) - time(a.h.date) || a.i - b.i)
    .slice(0, Math.max(0, max))
    .map(({ h }) => h);
}

export interface SelectedResults {
  /** In the given order (newest first); numbered 1..n in the prompt. */
  messages: LoadedMessage[];
  truncated: boolean;
  /** Mails left out because the text budget was used up. */
  omittedCount: number;
}

/**
 * Cuts every body to the per-mail limit and keeps mails in order while the total budget lasts.
 * The first mail that does not fit is shortened if enough budget is left; all later ones are left out.
 */
export function selectResults(loaded: readonly LoadedMessage[], limits: SearchLimits = DEFAULT_SEARCH_LIMITS): SelectedResults {
  const cap = Math.min(limits.maxMessageChars, limits.maxTotalChars);
  let truncated = false;
  let remaining = limits.maxTotalChars;
  const messages: LoadedMessage[] = [];
  let omittedCount = 0;
  for (const m of loaded) {
    if (remaining <= 0) {
      omittedCount++;
      continue;
    }
    let body = m.body;
    if (body.length > cap) {
      body = body.slice(0, Math.max(0, cap - MARK.length)) + MARK;
      truncated = true;
    }
    if (body.length <= remaining) {
      messages.push(body === m.body ? m : { ...m, body });
      remaining -= body.length;
    } else if (remaining >= QUERY_MIN_PARTIAL_CHARS) {
      messages.push({ ...m, body: body.slice(0, remaining - MARK.length) + MARK });
      truncated = true;
      remaining = 0;
    } else {
      omittedCount++;
      remaining = 0;
    }
  }
  if (omittedCount > 0) truncated = true;
  return { messages, truncated, omittedCount };
}
