// Message formats between the popups and the background script, plus the pending-draft store.
// Pure (no messenger.*) so it can be tested in Node. Only user notes travel here, never mail content.

export const MAX_NOTES_CHARS = 2000;
/** How long a started reply draft waits for its compose popup. */
export const PENDING_TTL_MS = 2 * 60 * 1000;

export type RuntimeRequest =
  | { type: "startReplyDraft"; messageId: number; notes: string }
  | { type: "takePendingReplyDraft"; tabId: number };

export type StartReplyDraftResponse = { ok: true; popupOpened: boolean } | { ok: false };
export type TakePendingResponse = { notes: string } | null;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Validates an incoming message; returns null for anything unknown or malformed. */
export function parseRuntimeRequest(message: unknown): RuntimeRequest | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m["type"] === "startReplyDraft") {
    const notes = m["notes"] === undefined ? "" : m["notes"];
    if (!isId(m["messageId"]) || typeof notes !== "string") return null;
    return { type: "startReplyDraft", messageId: m["messageId"], notes: notes.slice(0, MAX_NOTES_CHARS) };
  }
  if (m["type"] === "takePendingReplyDraft") {
    return isId(m["tabId"]) ? { type: "takePendingReplyDraft", tabId: m["tabId"] } : null;
  }
  return null;
}

/** Whether a message comes from this extension itself. */
export function isOwnSender(senderId: string | undefined, ownId: string): boolean {
  return senderId !== undefined && senderId === ownId;
}

/** In-memory store of pending reply drafts by compose tab id, with expiry. */
export class PendingReplyDrafts {
  private readonly entries = new Map<number, { notes: string; expires: number }>();

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = PENDING_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  put(tabId: number, notes: string): void {
    this.prune();
    this.entries.set(tabId, { notes, expires: this.now() + this.ttlMs });
  }

  /** Returns and removes the entry; null if none or expired. */
  take(tabId: number): { notes: string } | null {
    this.prune();
    const e = this.entries.get(tabId);
    if (!e) return null;
    this.entries.delete(tabId);
    return { notes: e.notes };
  }

  private prune(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expires <= t) this.entries.delete(id);
  }
}
