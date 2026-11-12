// Keeps at most one chat tab: the action button focuses the existing tab instead of opening a second one.
// Only the tab id is remembered (in memory and in storage.session, so it survives an unloaded background
// script); it is not mail content. Pure apart from the injected functions, so it is testable in Node.
import type { SessionArea } from "./jobs.ts";

const KEY = "chatTabId";

export interface ChatTabDeps {
  session?: SessionArea | null;
  create(): Promise<{ id?: number | undefined }>;
  /** Activates the tab and focuses its window; rejects if the tab does not exist. */
  activate(tabId: number): Promise<void>;
}

export class ChatTabTracker {
  private tabId: number | null = null;
  private loaded = false;
  // A second click while the tab is being opened waits for the first instead of opening another tab.
  private pending: Promise<void> | null = null;
  private readonly deps: ChatTabDeps;

  constructor(deps: ChatTabDeps) {
    this.deps = deps;
  }

  private async known(): Promise<number | null> {
    if (this.loaded || !this.deps.session) return this.tabId;
    this.loaded = true;
    try {
      const v = (await this.deps.session.get(KEY))[KEY];
      if (this.tabId === null && typeof v === "number" && Number.isSafeInteger(v)) this.tabId = v;
    } catch {
      // unknown: a new tab is opened
    }
    return this.tabId;
  }

  private async remember(id: number | null): Promise<void> {
    this.tabId = id;
    this.loaded = true;
    if (!this.deps.session) return;
    try {
      if (id === null) await this.deps.session.remove(KEY);
      else await this.deps.session.set({ [KEY]: id });
    } catch {
      // best effort
    }
  }

  open(): Promise<void> {
    if (this.pending) return this.pending;
    const p = (async () => {
      const id = await this.known();
      if (id !== null) {
        try {
          await this.deps.activate(id);
          return;
        } catch {
          await this.remember(null);
        }
      }
      const tab = await this.deps.create();
      await this.remember(tab.id ?? null);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.pending = null;
      });
    this.pending = p;
    return p;
  }

  /** A chat page reported its tab (e.g. restored at startup); the action button then focuses it. */
  async adopt(tabId: number): Promise<void> {
    await this.remember(tabId);
  }

  async onTabRemoved(tabId: number): Promise<void> {
    if ((await this.known()) === tabId) await this.remember(null);
  }
}
