// Backend 2: calls Anthropic's Messages API directly with the user's API key (fetch, streaming, no tools).
// The key goes only to api.anthropic.com and never into logs, errors or messages. Request format, headers,
// streaming events and model ids follow the official API documentation (checked 2026-11-12).
import { BackendError } from "./backend.ts";
import type { Backend, BackendErrorCode, RunRequest } from "./backend.ts";

export const API_ORIGIN = "https://api.anthropic.com";
export const MESSAGES_URL = `${API_ORIGIN}/v1/messages`;
/** Cheapest authenticated call for the connection test: lists one model, generates nothing. */
export const MODELS_URL = `${API_ORIGIN}/v1/models?limit=1`;
export const API_VERSION = "2026-10-21";

/** Model names of the settings mapped to API model ids. */
export const API_MODEL_IDS: Readonly<Record<string, string>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};
/** Used when a run names no model (the CLI then uses Claude Code's own default). */
export const DEFAULT_API_MODEL = "sonnet";
/** Mail texts are short; this leaves room for long drafts and answers. */
export const MAX_OUTPUT_TOKENS = 16000;

/** Same bounds and default as the native host. */
export const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 600000;
/** Time limit of the connection test. */
export const CHECK_TIMEOUT_MS = 15000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiBackendDeps {
  /** Reads the stored key; undefined or "" if there is none. */
  getKey(): Promise<string | undefined>;
  fetch?: FetchFn;
}

/** Headers of every request. The browser-access header is required for calls from extension pages. */
export function apiHeaders(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": API_VERSION,
    authorization: `Bearer ${key}`,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Request body of a run: one user turn, no tools, streaming. */
export function messagesBody(req: Pick<RunRequest, "system" | "prompt" | "model">): Record<string, unknown> {
  const model = API_MODEL_IDS[req.model ?? DEFAULT_API_MODEL];
  if (model === undefined) throw new BackendError("internal");
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
    // Mail tasks need little reasoning; low effort keeps the wait before the first words short.
    output_config: { effort: "low" },
  };
}

/** Maps an HTTP status and the API's error type to a backend error code. */
export function codeForApiError(status: number | undefined, errorType?: string, errorMessage?: string): BackendErrorCode {
  if (errorType === "authentication_error" || status === 401) return "api_key_invalid";
  if (errorType === "permission_error" || status === 403) return "api_key_invalid";
  if (errorType === "billing_error" || status === 402) return "api_billing";
  // Older API responses report an empty credit balance as a 400 with this wording; used only to pick the code.
  if (status === 400 && typeof errorMessage === "string" && /credit balance/i.test(errorMessage)) return "api_billing";
  if (errorType === "rate_limit_error" || status === 429) return "rate_limited";
  if (errorType === "overloaded_error" || status === 529) return "overloaded";
  // Temporary server errors on Anthropic's side.
  if (errorType === "api_error" || (status !== undefined && status >= 500)) return "overloaded";
  return "internal";
}

const timeoutOf = (ms: number | undefined): number =>
  typeof ms === "number" && Number.isFinite(ms) && ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS ? ms : DEFAULT_TIMEOUT_MS;

/** Reads `{error: {type, message}}` from an error response; nothing of it is shown or logged. */
async function errorOf(res: Response): Promise<BackendErrorCode> {
  let type: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { type?: unknown; message?: unknown } };
    if (typeof body.error?.type === "string") type = body.error.type;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // no JSON body
  }
  return codeForApiError(res.status, type, message);
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental parser for server-sent events; chunks may split lines or carry several events. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const nl = this.buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(this.buffer.startsWith("\r\n", nl) ? nl + 2 : nl + 1);
      if (line === "") {
        if (this.data.length > 0 || this.event !== "") out.push({ event: this.event || "message", data: this.data.join("\n") });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
    }
    return out;
  }
}

type StreamStep = { text: string } | { done: true } | { error: BackendErrorCode } | null;

/** Interprets one stream event: text deltas, the end, or an error. Everything else (thinking, ping) is skipped. */
export function interpretEvent(ev: SseEvent): StreamStep {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(ev.data) as Record<string, unknown>;
  } catch {
    return ev.event === "error" ? { error: "internal" } : null;
  }
  const type = typeof data["type"] === "string" ? data["type"] : ev.event;
  if (type === "content_block_delta") {
    const delta = data["delta"] as Record<string, unknown> | undefined;
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"] !== "") return { text: delta["text"] };
    return null;
  }
  if (type === "message_stop") return { done: true };
  // An answer cut off at the output limit must not look complete.
  if (type === "message_delta" && (data["delta"] as Record<string, unknown> | undefined)?.["stop_reason"] === "max_tokens") return { error: "output_truncated" };
  if (type === "error") {
    const err = data["error"] as Record<string, unknown> | undefined;
    return { error: codeForApiError(undefined, typeof err?.["type"] === "string" ? err["type"] : undefined) };
  }
  return null;
}

export class ApiBackend implements Backend {
  private readonly getKey: () => Promise<string | undefined>;
  private readonly fetchFn: FetchFn;

  constructor(deps: ApiBackendDeps) {
    this.getKey = deps.getKey;
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  private async key(): Promise<string> {
    let key: string | undefined;
    try {
      key = await this.getKey();
    } catch {
      key = undefined;
    }
    if (typeof key !== "string" || key === "") throw new BackendError("api_key_missing");
    return key;
  }

  async *run(req: RunRequest): AsyncGenerator<string, void, undefined> {
    if (req.signal.aborted) throw new BackendError("cancelled");
    const key = await this.key();
    const body = JSON.stringify(messagesBody(req));
    if (req.signal.aborted) throw new BackendError("cancelled");

    const controller = new AbortController();
    let stopped: BackendErrorCode | null = null;
    const stop = (code: BackendErrorCode): void => {
      if (stopped) return;
      stopped = code;
      controller.abort();
    };
    const onAbort = (): void => stop("cancelled");
    req.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutOf(req.timeoutMs));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    try {
      let res: Response;
      try {
        res = await this.fetchFn(MESSAGES_URL, { method: "POST", headers: apiHeaders(key), body, signal: controller.signal, credentials: "omit" });
      } catch {
        throw new BackendError(stopped ?? "network_error");
      }
      if (!res.ok) throw new BackendError(stopped ?? (await errorOf(res)));
      if (!res.body) throw new BackendError("internal");
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw new BackendError(stopped ?? "network_error");
        }
        if (stopped) throw new BackendError(stopped);
        if (chunk.done) {
          // The stream ended without message_stop: the response is incomplete.
          throw new BackendError("network_error");
        }
        for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          const step = interpretEvent(ev);
          if (!step) continue;
          if ("error" in step) throw new BackendError(step.error);
          if ("done" in step) {
            finished = true;
            return;
          }
          yield step.text;
          if (stopped) throw new BackendError(stopped);
        }
      }
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      // Stops the download when the consumer quit early or an error ended the run.
      if (!finished) controller.abort();
      reader?.cancel().catch(() => undefined);
    }
  }

  /** Validates the key with a request that generates nothing. Sends no mail content. */
  async check(): Promise<{ ok: boolean; detail?: string }> {
    let key: string;
    try {
      key = await this.key();
    } catch (e) {
      return { ok: false, detail: (e as BackendError).code };
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHECK_TIMEOUT_MS);
    try {
      const headers = apiHeaders(key);
      delete headers["content-type"];
      const res = await this.fetchFn(MODELS_URL, { method: "GET", headers, signal: controller.signal, credentials: "omit" });
      if (res.ok) return { ok: true };
      return { ok: false, detail: await errorOf(res) };
    } catch {
      return { ok: false, detail: timedOut ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
