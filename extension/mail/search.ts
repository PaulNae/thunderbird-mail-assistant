// Searching the mailbox through messages.query, page by page with an early stop at the scan limit.
// The API is injectable so the paging logic can be tested in Node.
import { BackendError } from "../backend/backend.ts";
import { toQueryFields } from "../prompts/query.ts";
import type { QueryFields, SearchParams } from "../prompts/query.ts";
import type { FoundHeader } from "./search-select.ts";

/** Page size; the docs warn not to rely on it, so the loop works with any page size. */
const PAGE_SIZE = 100;
/** Folders whose mails are never searched: deleted mail and spam widen the room for prompt injection. */
const SKIPPED_FOLDER_USES = ["trash", "junk"];

export interface SearchHeader {
  id: number;
  date?: Date | undefined;
  /** TB 106+. */
  external?: boolean | undefined;
  junk?: boolean | undefined;
  /** Present with accountsRead; specialUse is TB 121+. */
  folder?: { specialUse?: string[] | undefined } | undefined;
}

export interface SearchApi {
  query(info: QueryFields & { messagesPerPage: number; returnMessageListId: true }): Promise<string>;
  continueList(listId: string): Promise<{ id: string | null; messages: SearchHeader[] }>;
  abortList(listId: string): Promise<void>;
}

const messengerApi = (): SearchApi => ({
  query: (info) => messenger.messages.query(info),
  continueList: (id) => messenger.messages.continueList(id),
  abortList: (id) => messenger.messages.abortList(id),
});

export interface SearchOutcome {
  headers: FoundHeader[];
  /** False if the scan limit stopped a search before its end, so more mails may match. */
  complete: boolean;
}

/** Resolves with the promise, or rejects with "cancelled" as soon as the signal aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BackendError("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new BackendError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function isSearchable(m: SearchHeader): boolean {
  if (m.external === true || m.junk === true) return false;
  return !(m.folder?.specialUse ?? []).some((u) => SKIPPED_FOLDER_USES.includes(u));
}

/**
 * Runs the searches one after the other and merges their hits (OR) until `limit` distinct mails are found.
 * Lists that are not read to the end are finalized with abortList. Rejects with BackendError("cancelled")
 * when the signal aborts; other errors come from the API and never contain mail content.
 */
export async function searchHeaders(
  queries: readonly SearchParams[],
  limit: number,
  signal: AbortSignal,
  api: SearchApi = messengerApi(),
): Promise<SearchOutcome> {
  const found = new Map<number, FoundHeader>();
  let complete = true;
  for (const params of queries) {
    if (found.size >= limit) {
      complete = false;
      break;
    }
    let listId: string | null = null;
    let finished = false;
    try {
      // returnMessageListId (TB 120+) hands out the id before any page, so a cancel can abort the list early.
      const pending = api.query({ ...toQueryFields(params), messagesPerPage: PAGE_SIZE, returnMessageListId: true });
      try {
        listId = await abortable(pending, signal);
      } catch (e) {
        // Cancelled before the id arrived: finalize the list as soon as it exists.
        if (signal.aborted) void pending.then((id) => api.abortList(id)).catch(() => undefined);
        throw e;
      }
      for (;;) {
        const page = await abortable(api.continueList(listId), signal);
        let stoppedAt = -1;
        page.messages.some((m, i) => {
          if (!isSearchable(m) || found.has(m.id)) return false;
          found.set(m.id, { id: m.id, date: m.date });
          if (found.size < limit) return false;
          stoppedAt = i;
          return true;
        });
        if (!page.id) finished = true;
        if (stoppedAt >= 0 && (!finished || stoppedAt < page.messages.length - 1)) complete = false;
        if (finished || stoppedAt >= 0) break;
      }
    } finally {
      if (listId && !finished) await api.abortList(listId).catch(() => undefined);
    }
  }
  return { headers: [...found.values()], complete };
}
