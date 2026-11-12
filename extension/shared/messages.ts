// Message formats between the popups and the background script, plus the pending-draft store.
// Pure (no messenger.*) so it can be tested in Node. Only user notes travel here, never mail content.

import { BACKEND_KINDS } from "../backend/backend.ts";
import type { BackendKind } from "../backend/backend.ts";

export const MAX_NOTES_CHARS = 2000;
/** How long a started reply draft waits for its compose popup. */
export const PENDING_TTL_MS = 2 * 60 * 1000;

export type RuntimeRequest =
  | { type: "startReplyDraft"; messageId: number; notes: string }
  | { type: "takePendingReplyDraft"; tabId: number }
  | { type: "checkBackend" };

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
  if (m["type"] === "checkBackend") return { type: "checkBackend" };
  return null;
}

/** States the connection test can report on the settings page: ok or the reason it failed. */
export const CHECK_STATES = [
  "ok",
  "host_not_found",
  "cli_not_found",
  "not_logged_in",
  "cli_unsupported",
  "api_key_missing",
  "api_key_invalid",
  "api_billing",
  "rate_limited",
  "overloaded",
  "network_error",
  "timeout",
  "internal",
] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export type CheckResponse = { state: CheckState; backend: BackendKind; version?: string };

/** Longest CLI version string passed on. */
const MAX_VERSION_CHARS = 40;

const toState = (code: unknown): CheckState =>
  typeof code === "string" && code !== "ok" && (CHECK_STATES as readonly string[]).includes(code) ? (code as CheckState) : "internal";

/** Maps the outcome of Backend.check() (a result or a thrown error code) to a state for the page. */
export function toCheckResponse(backend: BackendKind, outcome: { ok: boolean; detail?: string } | { errorCode: string }): CheckResponse {
  if ("errorCode" in outcome) return { state: toState(outcome.errorCode), backend };
  if (outcome.ok) {
    // Only the CLI reports a version; the API check has none.
    const v = backend === "cli" && typeof outcome.detail === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(outcome.detail) ? outcome.detail.slice(0, MAX_VERSION_CHARS) : undefined;
    return v === undefined ? { state: "ok", backend } : { state: "ok", backend, version: v };
  }
  return { state: toState(outcome.detail), backend };
}

/** Validates the response on the settings page. */
export function parseCheckResponse(raw: unknown): CheckResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["state"] !== "string" || !(CHECK_STATES as readonly string[]).includes(r["state"])) return null;
  if (typeof r["backend"] !== "string" || !(BACKEND_KINDS as readonly string[]).includes(r["backend"])) return null;
  const v = r["version"];
  if (v !== undefined && (typeof v !== "string" || v.length > MAX_VERSION_CHARS)) return null;
  const res: CheckResponse = { state: r["state"] as CheckState, backend: r["backend"] as BackendKind };
  if (v !== undefined) res.version = v;
  return res;
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
