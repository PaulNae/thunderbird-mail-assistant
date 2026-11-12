// The user's API key for the API backend: stored only in storage.local under its own key, never in
// storage.sync, logs, error messages or messages between pages. Pure (no messenger.*) so it can be tested.
import type { LocalArea } from "./consent.ts";

export const API_KEY_KEY = "apiKey";
const MAX_KEY_CHARS = 512;

/** Trims the input; returns null unless it is plausible as a key (printable ASCII without spaces). */
export function normalizeApiKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const key = input.trim();
  return key.length >= 8 && key.length <= MAX_KEY_CHARS && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

/** The stored key, or undefined (also when storage fails or the stored value is unusable). */
export async function readApiKey(area: Pick<LocalArea, "get">): Promise<string | undefined> {
  try {
    return normalizeApiKey((await area.get(API_KEY_KEY))[API_KEY_KEY]) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Stores a valid key; returns false (and stores nothing) for an invalid one. */
export async function writeApiKey(area: Pick<LocalArea, "set">, input: unknown): Promise<boolean> {
  const key = normalizeApiKey(input);
  if (key === null) return false;
  await area.set({ [API_KEY_KEY]: key });
  return true;
}

export function removeApiKey(area: Pick<LocalArea, "remove">): Promise<void> {
  return area.remove(API_KEY_KEY);
}
