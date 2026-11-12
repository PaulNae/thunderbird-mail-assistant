import { BackendError, toBackendErrorCode } from "./backend.ts";
import type { Backend, RunRequest } from "./backend.ts";

export const HOST_NAME = "mail_assistant";

// Subset of runtime.Port that is used here.
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  error?: { message?: string } | null;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: (port: NativePort) => void): void };
}

export type ConnectFn = () => NativePort | Promise<NativePort>;

// `await` handles both a Port and a Promise<Port>.
const defaultConnect: ConnectFn = () => messenger.runtime.connectNative(HOST_NAME) as unknown as NativePort | Promise<NativePort>;

type Sink = {
  message(msg: Record<string, unknown>): void;
  fail(err: BackendError): void;
};

export class CliBackend implements Backend {
  private port: Promise<NativePort> | null = null;
  private readonly sinks = new Map<string, Sink>();
  private checkSinks: Sink[] = [];
  private gotMessage = false;

  private readonly connect: ConnectFn;

  constructor(connect: ConnectFn = defaultConnect) {
    this.connect = connect;
  }

  private getPort(): Promise<NativePort> {
    if (this.port) return this.port;
    this.gotMessage = false;
    const p = (async () => {
      let port: NativePort;
      try {
        port = await this.connect();
      } catch {
        throw new BackendError("host_not_found");
      }
      port.onMessage.addListener((m) => {
        this.gotMessage = true;
        this.route(m);
      });
      port.onDisconnect.addListener((disc) => this.handleDisconnect(p, disc));
      return port;
    })();
    this.port = p;
    p.catch(() => {
      if (this.port === p) this.port = null;
    });
    return p;
  }

  private handleDisconnect(p: Promise<NativePort>, port: NativePort): void {
    if (this.port !== p) return;
    this.port = null;
    const lastError = (typeof messenger !== "undefined" ? messenger.runtime.lastError : undefined) ?? null;
    const hasError = Boolean(port.error ?? lastError);
    const code = hasError || !this.gotMessage ? "host_not_found" : "internal";
    const sinks = [...this.sinks.values(), ...this.checkSinks];
    this.sinks.clear();
    this.checkSinks = [];
    for (const s of sinks) s.fail(new BackendError(code));
  }

  private route(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg["type"] === "check") {
      const sinks = this.checkSinks;
      this.checkSinks = [];
      for (const s of sinks) s.message(msg);
      return;
    }
    if (typeof msg["id"] !== "string") return;
    this.sinks.get(msg["id"])?.message(msg);
  }

  async *run(req: RunRequest): AsyncGenerator<string, void, undefined> {
    if (req.signal.aborted) throw new BackendError("cancelled");
    const id = crypto.randomUUID();
    const queue: string[] = [];
    let finished = false;
    let failure: BackendError | null = null;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    this.sinks.set(id, {
      message: (m) => {
        if (m["type"] === "delta" && typeof m["text"] === "string") queue.push(m["text"]);
        else if (m["type"] === "done") finished = true;
        else if (m["type"] === "error") failure = new BackendError(toBackendErrorCode(m["code"]));
        else return;
        notify();
      },
      fail: (e) => {
        failure = e;
        notify();
      },
    });

    let port: NativePort;
    try {
      port = await this.getPort();
    } catch (e) {
      this.sinks.delete(id);
      throw e;
    }
    if (req.signal.aborted) {
      this.sinks.delete(id);
      throw new BackendError("cancelled");
    }
    const onAbort = (): void => {
      if (finished || failure) return;
      failure = new BackendError("cancelled");
      try {
        port.postMessage({ id, type: "cancel" });
      } catch {
        // port already gone
      }
      notify();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        port.postMessage({ id, type: "run", system: req.system, prompt: req.prompt, model: req.model, ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }) });
      } catch {
        throw new BackendError("host_not_found");
      }
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string;
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      this.sinks.delete(id);
      if (!finished && !failure) {
        // Consumer stopped iterating early: tell the host to stop the run.
        try {
          port.postMessage({ id, type: "cancel" });
        } catch {
          // port already gone
        }
      }
    }
  }

  async check(): Promise<{ ok: boolean; detail?: string }> {
    const port = await this.getPort();
    return new Promise((resolve, reject) => {
      const sink: Sink = {
        message: (m) => {
          const ok = m["ok"] === true;
          const detail = ok ? m["version"] : (m["code"] ?? m["message"]);
          resolve(typeof detail === "string" ? { ok, detail } : { ok });
        },
        fail: reject,
      };
      this.checkSinks.push(sink);
      try {
        port.postMessage({ type: "check" });
      } catch {
        this.checkSinks = this.checkSinks.filter((s) => s !== sink);
        reject(new BackendError("host_not_found"));
      }
    });
  }
}
