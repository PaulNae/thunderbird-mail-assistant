// Consent to sending mail content to the model. Only the fact of consent and the version of the
// text the user agreed to are stored (storage.local); no date, no mail content.
// Pure (no messenger.*) so it can be tested in Node.

/** storage.local key of the consent record. */
export const CONSENT_KEY = "consent";
/**
 * Version of the consent text (`consent*` keys in _locales). Raise it whenever the text changes in
 * substance (other data, other recipient): earlier consent then no longer counts and is asked again.
 */
export const CONSENT_VERSION = 1;

export interface ConsentRecord {
  version: number;
}

/** True only for a record of the current version. */
export function isConsentGiven(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return (raw as Record<string, unknown>)["version"] === CONSENT_VERSION;
}

export function consentRecord(): ConsentRecord {
  return { version: CONSENT_VERSION };
}

/** The part of a storage area that is used for the consent and the settings. */
export interface LocalArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Reads the consent; a failing storage counts as no consent. */
export async function readConsent(area: Pick<LocalArea, "get">): Promise<boolean> {
  try {
    return isConsentGiven((await area.get(CONSENT_KEY))[CONSENT_KEY]);
  } catch {
    return false;
  }
}

export function grantConsent(area: Pick<LocalArea, "set">): Promise<void> {
  return area.set({ [CONSENT_KEY]: consentRecord() });
}

export function revokeConsent(area: Pick<LocalArea, "remove">): Promise<void> {
  return area.remove(CONSENT_KEY);
}
