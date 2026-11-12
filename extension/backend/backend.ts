export type BackendErrorCode =
  | "cli_not_found"
  | "not_logged_in"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "internal"
  | "host_not_found";

const KNOWN_CODES: readonly string[] = [
  "cli_not_found",
  "not_logged_in",
  "rate_limited",
  "timeout",
  "cancelled",
  "internal",
  "host_not_found",
];

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
  signal: AbortSignal;
}

export interface Backend {
  // Streams text chunks; throws BackendError with a machine-readable code.
  run(req: RunRequest): AsyncIterable<string>;
  check(): Promise<{ ok: boolean; detail?: string }>;
}
