import { BackendError } from "../backend/backend.ts";
import type { BackendErrorCode } from "../backend/backend.ts";

export const ERROR_KEYS: Record<BackendErrorCode, string> = {
  host_not_found: "errorHostNotFound",
  cli_not_found: "errorCliNotFound",
  not_logged_in: "errorNotLoggedIn",
  rate_limited: "errorRateLimited",
  timeout: "errorTimeout",
  cancelled: "errorCancelled",
  internal: "errorInternal",
};

/** Localized, user-facing text for any thrown value; never includes mail content. */
export function errorMessage(e: unknown): string {
  const code: BackendErrorCode = e instanceof BackendError ? e.code : "internal";
  return messenger.i18n.getMessage(ERROR_KEYS[code]);
}
