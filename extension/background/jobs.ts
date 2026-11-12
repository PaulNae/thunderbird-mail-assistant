// Owner of running and finished jobs, bound to a mail display tab or a compose window.
// Pure logic (backend and storage are injected) so it can be tested in Node. Popups come and go;
// jobs live here. Mail content is only held in memory: the entries (results, history, preview) are
// mirrored to storage.session (memory only, cleared when Thunderbird or the add-on ends), never the prompts.
import { BackendError } from "../backend/backend.ts";
import type { Backend } from "../backend/backend.ts";
import { cleanModelOutput } from "../prompts/compose.ts";
import { limitHistory } from "../prompts/read.ts";
import { isBlank } from "../compose/editor-text.ts";
import { MAX_ENTRIES, MAX_TEXT_CHARS, emptySnapshot, sanitizeSnapshot } from "../shared/job-messages.ts";
import type { JobSnapshot, PortEvent, StartRequest } from "../shared/job-messages.ts";

export type Subscriber = (event: PortEvent) => void;

/** The part of storage.session that is used. */
export interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface JobStoreDeps {
  backend: Pick<Backend, "run">;
  session?: SessionArea | null;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  snapshot: JobSnapshot;
  ctl: AbortController | null;
  updated: number;
}

const MIRROR_PREFIX = "job:";
const MIRROR_VERSION = 1;

export const displayKey = (tabId: number): string => `display:${tabId}`;
export const composeKey = (tabId: number): string => `compose:${tabId}`;

export class JobStore {
  private readonly entries = new Map<string, Entry>();
  // Open popups per key; independent of the entries so a popup can wait for a job that does not exist yet.
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly backend: Pick<Backend, "run">;
  private readonly session: SessionArea | null;
  private readonly maxEntries: number;
  private readonly now: () => number;
  // Serializes operations that load, create or delete entries, so a lazy load cannot revive a cleared entry.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: JobStoreDeps) {
    this.backend = deps.backend;
    this.session = deps.session ?? null;
    this.maxEntries = deps.maxEntries ?? MAX_ENTRIES;
    this.now = deps.now ?? Date.now;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The in-memory entry, or the one restored from the session mirror (a "streaming" mirror has no run: cancelled). */
  private async load(key: string): Promise<Entry | null> {
    const live = this.entries.get(key);
    if (live) return live;
    if (!this.session) return null;
    try {
      const raw = (await this.session.get(MIRROR_PREFIX + key))[MIRROR_PREFIX + key];
      if (typeof raw !== "object" || raw === null || (raw as Record<string, unknown>)["v"] !== MIRROR_VERSION) return null;
      const snap = sanitizeSnapshot((raw as Record<string, unknown>)["snapshot"]);
      if (!snap) return null;
      if (snap.phase === "streaming") {
        snap.phase = "cancelled";
        snap.text = "";
        delete snap.question;
      }
      const entry: Entry = { snapshot: snap, ctl: null, updated: this.now() };
      this.entries.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private async mirror(key: string, entry: Entry): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.set({ [MIRROR_PREFIX + key]: { v: MIRROR_VERSION, updated: entry.updated, snapshot: entry.snapshot } });
    } catch {
      // The mirror is best effort.
    }
  }

  private async unmirror(key: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.remove(MIRROR_PREFIX + key);
    } catch {
      // best effort
    }
  }

  private emit(key: string, event: PortEvent): void {
    for (const s of this.subs.get(key) ?? []) {
      try {
        s(event);
      } catch {
        // A broken subscriber (closed popup) must not stop the job.
      }
    }
  }

  private publish(key: string, entry: Entry): void {
    entry.updated = this.now();
    this.emit(key, { type: "snapshot", snapshot: entry.snapshot });
    void this.mirror(key, entry);
  }

  /**
   * Registers a popup and sends it the snapshot. For the mail display, a snapshot that belongs to
   * another message is dropped first. Returns the function that unregisters the popup.
   */
  open(key: string, sub: Subscriber, messageId?: number): Promise<() => void> {
    return this.serial(async () => {
      let entry = await this.load(key);
      if (entry && messageId !== undefined && entry.snapshot.messageId !== undefined && entry.snapshot.messageId !== messageId) {
        await this.drop(key);
        entry = null;
      }
      let set = this.subs.get(key);
      if (!set) this.subs.set(key, (set = new Set()));
      set.add(sub);
      sub({ type: "snapshot", snapshot: entry ? entry.snapshot : emptySnapshot() });
      return () => {
        const current = this.subs.get(key);
        current?.delete(sub);
        if (current?.size === 0) this.subs.delete(key);
      };
    });
  }

  /** Starts a job unless one already runs for the key. */
  start(key: string, req: StartRequest): Promise<void> {
    return this.serial(async () => {
      let entry = await this.load(key);
      if (entry?.ctl) return;
      if (entry && req.messageId !== undefined && entry.snapshot.messageId !== undefined && entry.snapshot.messageId !== req.messageId) {
        await this.drop(key);
        entry = null;
      }
      if (!entry) {
        await this.makeRoom(key);
        entry = { snapshot: emptySnapshot(), ctl: null, updated: this.now() };
        this.entries.set(key, entry);
      }
      const ctl = new AbortController();
      entry.ctl = ctl;
      const snap = entry.snapshot;
      entry.snapshot = {
        ...snap,
        phase: "streaming",
        kind: req.kind,
        text: "",
        ...(req.messageId === undefined ? {} : { messageId: req.messageId }),
        ...(req.question === undefined ? {} : { question: req.question }),
        ...(req.job === undefined ? {} : { job: req.job }),
      };
      delete entry.snapshot.error;
      if (req.question === undefined) delete entry.snapshot.question;
      this.publish(key, entry);
      void this.execute(key, entry, req, ctl);
    });
  }

  private async execute(key: string, entry: Entry, req: StartRequest, ctl: AbortController): Promise<void> {
    let text = "";
    let failure: BackendError | null = null;
    try {
      for await (const chunk of this.backend.run({ system: req.system, prompt: req.prompt, ...(req.model === undefined ? {} : { model: req.model }), signal: ctl.signal })) {
        if (this.entries.get(key) !== entry) return;
        const room = MAX_TEXT_CHARS - text.length;
        if (room <= 0) continue;
        const part = chunk.length > room ? chunk.slice(0, room) : chunk;
        text += part;
        entry.snapshot.text = text;
        this.emit(key, { type: "delta", text: part });
      }
      if (ctl.signal.aborted) failure = new BackendError("cancelled");
    } catch (e) {
      failure = e instanceof BackendError ? e : new BackendError("internal");
    }
    // The entry was cleared (other mail, closed tab) while running: nothing to report.
    if (this.entries.get(key) !== entry) return;
    entry.ctl = null;
    this.finish(key, entry, req, text, failure);
  }

  private finish(key: string, entry: Entry, req: StartRequest, raw: string, failure: BackendError | null): void {
    const snap = entry.snapshot;
    const next: JobSnapshot = { ...snap, text: "" };
    delete next.question;
    if (failure) {
      if (failure.code === "cancelled") next.phase = "cancelled";
      else {
        next.phase = "error";
        next.error = failure.code;
      }
    } else {
      const cleaned = cleanModelOutput(raw);
      if (isBlank(cleaned)) {
        next.phase = "error";
        next.error = "empty_result";
      } else {
        next.phase = "done";
        if (req.kind === "summary") next.summary = cleaned;
        else if (req.kind === "question") next.history = limitHistory([...snap.history, { question: req.question ?? "", answer: cleaned }]);
        else next.text = cleaned;
      }
    }
    entry.snapshot = next;
    this.publish(key, entry);
  }

  /** Aborts a running job (synchronous). */
  cancel(key: string): void {
    this.entries.get(key)?.ctl?.abort();
  }

  /** Aborts and forgets an entry, in memory and in the mirror. */
  private async drop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    entry?.ctl?.abort();
    await this.unmirror(key);
    if (entry) entry.ctl = null;
    this.emit(key, { type: "snapshot", snapshot: emptySnapshot() });
  }

  clear(key: string): Promise<void> {
    return this.serial(() => this.drop(key));
  }

  /** Mail display: another or several messages are shown now. */
  onMessagesDisplayed(tabId: number, messageIds: readonly number[]): Promise<void> {
    const key = displayKey(tabId);
    return this.serial(async () => {
      const entry = await this.load(key);
      if (!entry) return;
      const id = entry.snapshot.messageId;
      if (id !== undefined && messageIds.length === 1 && messageIds[0] === id) return;
      await this.drop(key);
    });
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.serial(async () => {
      await this.drop(displayKey(tabId));
      await this.drop(composeKey(tabId));
    });
  }

  /** Drops the oldest entries (memory and mirror) so that one more fits. */
  private async makeRoom(newKey: string): Promise<void> {
    const known = new Map<string, number>();
    if (this.session) {
      try {
        for (const [k, v] of Object.entries(await this.session.get(null))) {
          if (!k.startsWith(MIRROR_PREFIX)) continue;
          const u = (v as { updated?: unknown } | null)?.updated;
          known.set(k.slice(MIRROR_PREFIX.length), typeof u === "number" ? u : 0);
        }
      } catch {
        // memory entries only
      }
    }
    for (const [k, e] of this.entries) known.set(k, e.updated);
    known.delete(newKey);
    const oldestFirst = [...known.entries()].sort((a, b) => a[1] - b[1]);
    while (oldestFirst.length >= this.maxEntries) {
      const [k] = oldestFirst.shift() as [string, number];
      await this.drop(k);
    }
  }
}
