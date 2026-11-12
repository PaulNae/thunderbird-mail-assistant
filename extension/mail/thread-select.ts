// Pure selection and truncation of thread messages (no messenger.*, testable in Node).
import type { LoadedMessage } from "./types.ts";

/** Most messages in a thread context, including the displayed one. */
export const MAX_THREAD_MESSAGES = 6;
/** Most body characters over all messages of a thread context. */
export const MAX_THREAD_CHARS = 40000;
/** Most body characters of one message. */
export const MAX_MESSAGE_CHARS = 20000;
/** An older message is only kept in shortened form if at least this much budget is left. */
export const MIN_PARTIAL_CHARS = 500;

export interface ThreadLimits {
  maxMessages: number;
  maxChars: number;
  maxMessageChars: number;
}

export const DEFAULT_THREAD_LIMITS: ThreadLimits = {
  maxMessages: MAX_THREAD_MESSAGES,
  maxChars: MAX_THREAD_CHARS,
  maxMessageChars: MAX_MESSAGE_CHARS,
};

export interface ThreadMessage extends LoadedMessage {
  /** True for the message the user is looking at. */
  current: boolean;
}

export interface LoadedThread {
  /** Chronological (oldest first). */
  messages: ThreadMessage[];
  truncated: boolean;
  /** Related messages left out entirely. */
  omittedCount: number;
}

function time(m: LoadedMessage): number {
  const t = Date.parse(m.date);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Picks messages within the limits. The displayed message always stays (cut to the limits if
 * needed); older messages are dropped first, the newest related ones are kept, and the last one
 * that fits only partly is shortened. Any cut or omission sets `truncated`.
 */
export function selectThread(
  currentId: number,
  candidates: readonly LoadedMessage[],
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
): LoadedThread {
  const cap = Math.min(limits.maxMessageChars, limits.maxChars);
  let truncated = false;
  const cut = (m: LoadedMessage, max: number): LoadedMessage => {
    if (m.body.length <= max) return m;
    truncated = true;
    return { ...m, body: m.body.slice(0, max) };
  };

  const seen = new Set<number>();
  const unique = candidates.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const current = unique.find((m) => m.id === currentId);
  if (!current) throw new Error("Displayed message missing from thread candidates");

  const keptCurrent = cut(current, cap);
  let remaining = limits.maxChars - keptCurrent.body.length;
  const chosen = new Map<number, LoadedMessage>([[currentId, keptCurrent]]);

  // Newest first, so the oldest are dropped first. Stable for equal/missing dates.
  const others = unique
    .filter((m) => m.id !== currentId)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => time(b.m) - time(a.m) || b.i - a.i)
    .map((x) => x.m);
  let omittedCount = 0;
  for (const m of others) {
    if (chosen.size >= limits.maxMessages) {
      omittedCount++;
      continue;
    }
    const full = cut(m, cap);
    if (full.body.length <= remaining) {
      chosen.set(m.id, full);
      remaining -= full.body.length;
    } else if (remaining >= MIN_PARTIAL_CHARS) {
      chosen.set(m.id, { ...full, body: full.body.slice(0, remaining) });
      truncated = true;
      remaining = 0;
    } else {
      omittedCount++;
    }
  }
  if (omittedCount > 0) truncated = true;

  const messages = unique
    .filter((m) => chosen.has(m.id))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => time(a.m) - time(b.m) || a.i - b.i)
    .map(({ m }) => ({ ...chosen.get(m.id)!, current: m.id === currentId }));
  return { messages, truncated, omittedCount };
}

/** Extracts Message-IDs (without angle brackets) from References / In-Reply-To values. */
export function parseMessageIds(values: readonly string[]): string[] {
  const ids: string[] = [];
  for (const v of values) for (const m of v.matchAll(/<([^<>\s]+)>/g)) ids.push(m[1]!);
  return ids;
}
