// Thread context for the displayed message: related messages found through the References and
// In-Reply-To headers. Only messages that can be found this way are included.
import { loadMessage } from "./message-text.ts";
import type { LoadedMessage } from "./message-text.ts";
import { DEFAULT_THREAD_LIMITS, parseMessageIds, selectThread } from "./thread-select.ts";
import type { LoadedThread, ThreadLimits } from "./thread-select.ts";

export type { LoadedThread, ThreadMessage, ThreadLimits } from "./thread-select.ts";

/** Most referenced Message-IDs that are looked up (the newest ones in the chain). */
const MAX_LOOKUPS = 12;

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
    messenger.messages.getFull(messageId, { decodeHeaders: true }).catch(() => ({ headers: undefined })),
  ]);
  const wanted = [
    ...parseMessageIds(headerValues(full.headers, "in-reply-to")),
    ...parseMessageIds(headerValues(full.headers, "references")),
  ];
  const ids = [...new Set(wanted)].slice(-MAX_LOOKUPS);

  const related = await Promise.all(
    ids.map(async (headerMessageId): Promise<LoadedMessage | null> => {
      try {
        const list = await messenger.messages.query({ headerMessageId });
        const hit = list.messages.find((m) => m.id !== messageId);
        return hit ? await loadMessage(hit.id) : null;
      } catch {
        return null;
      }
    }),
  );
  const candidates = [current, ...related.filter((m): m is LoadedMessage => m !== null)];
  return selectThread(messageId, candidates, limits);
}
