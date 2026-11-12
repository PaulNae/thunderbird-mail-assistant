// Enforces the consent in the background script: every run (the only way mail content leaves the
// add-on) asks for the consent first and fails with "consent_required" without it. The UI shows the
// consent dialog, but this gate is what actually blocks. Pure apart from the injected check.
import { BackendError } from "../backend/backend.ts";
import type { Backend, RunRequest } from "../backend/backend.ts";

export class ConsentGatedBackend implements Backend {
  private readonly inner: Backend;
  private readonly allowed: () => Promise<boolean>;

  constructor(inner: Backend, allowed: () => Promise<boolean>) {
    this.inner = inner;
    this.allowed = allowed;
  }

  async *run(req: RunRequest): AsyncGenerator<string, void, undefined> {
    const ok = await this.allowed().catch(() => false);
    if (!ok) throw new BackendError("consent_required");
    if (req.signal.aborted) throw new BackendError("cancelled");
    yield* this.inner.run(req);
  }

  /** The connection test sends no mail content and is allowed without consent. */
  check(): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.check();
  }
}
