export type BackendErrorCode =
  | "cli_not_found"
  | "not_logged_in"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "internal"
  | "host_not_found"
  | "consent_required"
  // CLI backend on a system other than macOS.
  | "cli_unsupported"
  // API backend.
  | "api_key_missing"
  | "api_key_invalid"
  | "api_billing"
  | "overloaded"
  | "network_error";

/** All codes; lists of accepted error values elsewhere are derived from this. */
export const BACKEND_ERROR_CODES: readonly BackendErrorCode[] = [
  "cli_not_found",
  "not_logged_in",
  "rate_limited",
  "timeout",
  "cancelled",
  "internal",
  "host_not_found",
  "consent_required",
  "cli_unsupported",
  "api_key_missing",
  "api_key_invalid",
  "api_billing",
  "overloaded",
  "network_error",
];
const KNOWN_CODES: readonly string[] = BACKEND_ERROR_CODES;

export function toBackendErrorCode(code: unknown): BackendErrorCode {
  return typeof code === "string" && KNOWN_CODES.includes(code) ? (code as BackendErrorCode) : "internal";
}

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BackendError";
    this.code = code;
  }
}

export interface RunRequest {
  system: string;
  prompt: string;
  model?: string;
  /** Time limit for the run; the host uses its default if absent or out of range. */
  timeoutMs?: number;
  signal: AbortSignal;
}

/** The two ways of reaching the model; chosen in the settings. */
export const BACKEND_KINDS = ["api", "cli"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export interface Backend {
  // Streams text chunks; throws BackendError with a machine-readable code.
  run(req: RunRequest): AsyncIterable<string>;
  check(): Promise<{ ok: boolean; detail?: string }>;
}
