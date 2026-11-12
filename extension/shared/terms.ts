// The date on which Anthropic's terms were last checked for the subscription option (Claude Code).
// Change it only after checking the terms again; the notice in the settings and the guide shows it,
// and the README states the same date (test/terms.test.ts keeps them in step).
export const TERMS_CHECKED_ON = "2026-11-12";
export const TERMS_URL = "https://code.claude.com/docs/en/legal-and-compliance";
/** Where API keys are created. */
export const CONSOLE_KEYS_URL = "https://platform.claude.com/settings/keys";
export const REPOSITORY_URL = "https://github.com/PaulNae/thunderbird-mail-assistant";
/** Where bugs and feature requests are reported. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/** The check date in the user's language, e.g. "12.11.2026" (de) or "Nov 12, 2026" (en). */
export function formatTermsDate(locale: string): string {
  const date = new Date(`${TERMS_CHECKED_ON}T00:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  } catch {
    return TERMS_CHECKED_ON;
  }
}
