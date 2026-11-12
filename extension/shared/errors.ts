import { BackendError } from "../backend/backend.ts";
import type { BackendErrorCode } from "../backend/backend.ts";

export const ERROR_KEYS: Record<BackendErrorCode, string> = {
  host_not_found: "errorHostNotFound",
  cli_not_found: "errorCliNotFound",
  not_logged_in: "errorNotLoggedIn",
  cli_unsupported: "errorCliUnsupported",
  api_key_missing: "errorApiKeyMissing",
  api_key_invalid: "errorApiKeyInvalid",
  api_billing: "errorApiBilling",
  rate_limited: "errorRateLimited",
  overloaded: "errorOverloaded",
  network_error: "errorNetwork",
  timeout: "errorTimeout",
  cancelled: "errorCancelled",
  internal: "errorInternal",
  consent_required: "errorConsentRequired",
};

/** Sections of the setup guide (ids of its <section> elements). */
export type GuideSection = "api" | "cli" | "notices";

/** Errors that the setup guide explains, with the section to open. */
export const GUIDE_SECTIONS: Partial<Record<BackendErrorCode, GuideSection>> = {
  host_not_found: "cli",
  cli_not_found: "cli",
  not_logged_in: "cli",
  cli_unsupported: "cli",
  api_key_missing: "api",
  api_key_invalid: "api",
  api_billing: "api",
};

const codeOf = (e: unknown): BackendErrorCode => (e instanceof BackendError ? e.code : "internal");

/** Localized, user-facing text for any thrown value; never includes mail content or the API key. */
export function errorMessage(e: unknown): string {
  return messenger.i18n.getMessage(ERROR_KEYS[codeOf(e)]);
}

/** The guide section that explains an error, if any. */
export function guideSectionFor(e: unknown): GuideSection | null {
  return GUIDE_SECTIONS[codeOf(e)] ?? null;
}
