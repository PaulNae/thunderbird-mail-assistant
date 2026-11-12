// Picks the backend chosen in the settings for each run and each connection test, so a switch in the
// settings applies to the next action without a restart. The CLI backend exists only on macOS; elsewhere
// it fails with "cli_unsupported" before anything is sent. Pure apart from the injected functions.
import { BackendError } from "../backend/backend.ts";
import type { Backend, BackendKind, RunRequest } from "../backend/backend.ts";

export interface SwitchingDeps {
  backends: Record<BackendKind, Backend>;
  /** The backend chosen in the settings. */
  choice(): Promise<BackendKind>;
  /** Operating system as runtime.getPlatformInfo() reports it ("mac", "win", "linux", …). */
  os(): Promise<string>;
}

/** Whether the CLI backend (native host for Claude Code) is available on this system. */
export const cliSupported = (os: string): boolean => os === "mac";

export class SwitchingBackend implements Backend {
  private readonly deps: SwitchingDeps;

  constructor(deps: SwitchingDeps) {
    this.deps = deps;
  }

  /** The chosen backend kind and whether it can run here. */
  async current(): Promise<{ kind: BackendKind; supported: boolean }> {
    const kind = await this.deps.choice();
    if (kind !== "cli") return { kind, supported: true };
    const os = await this.deps.os().catch(() => "");
    return { kind, supported: cliSupported(os) };
  }

  async *run(req: RunRequest): AsyncGenerator<string, void, undefined> {
    const { kind, supported } = await this.current();
    if (!supported) throw new BackendError("cli_unsupported");
    if (req.signal.aborted) throw new BackendError("cancelled");
    yield* this.deps.backends[kind].run(req);
  }

  async check(): Promise<{ ok: boolean; detail?: string }> {
    const { kind, supported } = await this.current();
    if (!supported) return { ok: false, detail: "cli_unsupported" };
    return this.deps.backends[kind].check();
  }
}
