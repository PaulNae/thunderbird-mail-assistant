// Thread context for the displayed message: related messages found through the References and
// In-Reply-To headers. Only messages that can be found this way are included.
import { findAccountId } from "./identity.ts";
import { loadMessage } from "./message-text.ts";
import type { LoadedMessage } from "./message-text.ts";
import { DEFAULT_THREAD_LIMITS, parseMessageIds, selectThread } from "./thread-select.ts";
import type { LoadedThread, ThreadLimits } from "./thread-select.ts";

export type { LoadedThread, ThreadMessage, ThreadLimits } from "./thread-select.ts";

/** Most referenced Message-IDs that are looked up (the newest ones in the chain). */
const MAX_LOOKUPS = 12;
/** Total time for finding related messages; what is not found by then is left out. */
export const THREAD_LOOKUP_TIMEOUT_MS = 5000;

function headerValues(headers: Record<string, string[]> | undefined, name: string): string[] {
  if (!headers) return [];
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, values]) => values);
}

/** Errors thrown here never contain mail content; failures of related messages are skipped. */
export async function loadThread(
  messageId: number,
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
): Promise<LoadedThread> {
  const [current, full] = await Promise.all([
    loadMessage(messageId),
    messenger.messages.getFull(messageId).catch(() => ({ headers: undefined })),
  ]);
  const wanted = [
    ...parseMessageIds(headerValues(full.headers, "in-reply-to")),
    ...parseMessageIds(headerValues(full.headers, "references")),
  ];
  const ids = [...new Set(wanted)].slice(-MAX_LOOKUPS);

  // Limited to the account of the displayed message (folder.accountId, needs accountsRead; query
  // accountId needs TB 121+). Without a known account (e.g. a message opened from a file) all
  // accounts are searched.
  const accountId = await findAccountId(messageId);
  const lookup = async (headerMessageId: string): Promise<LoadedMessage | null> => {
    let listId: string | null = null;
    try {
      const list = await messenger.messages.query(accountId ? { headerMessageId, accountId } : { headerMessageId });
      listId = list.id;
      const hit = list.messages.find((m) => m.id !== messageId);
      return hit ? await loadMessage(hit.id) : null;
    } catch {
      return null;
    } finally {
      // Also runs when the deadline has passed already; a late result is simply ignored.
      if (listId) await messenger.messages.abortList(listId).catch(() => undefined);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), THREAD_LOOKUP_TIMEOUT_MS);
  });
  const related = await Promise.all(ids.map((id) => Promise.race([lookup(id), deadline]))).finally(() =>
    clearTimeout(timer),
  );
  const candidates = [current, ...related.filter((m): m is LoadedMessage => m !== null)];
  return selectThread(messageId, candidates, limits);
}
