// Background script. Listeners must be registered at top level (MV3).
import { PendingReplyDrafts, isOwnSender, parseRuntimeRequest } from "../shared/messages.ts";
import { findReplyContext } from "../mail/identity.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { ApiBackend } from "../backend/api-backend.ts";
import { SwitchingBackend } from "./switching-backend.ts";
import { readApiKey } from "../shared/api-key.ts";
import { GUIDE_PAGE } from "../shared/guide.ts";
import { ConsentGatedBackend } from "./gated-backend.ts";
import { CONSENT_KEY, isConsentGiven, readConsent } from "../shared/consent.ts";
import type { ChatSession } from "./chat.ts";
import { handleConnection } from "./connection.ts";
import { JobStore } from "./jobs.ts";
import { handleChatConnection } from "./chat.ts";
import type { ChatDeps } from "./chat.ts";
import { ChatTabTracker } from "./chat-tab.ts";
import { loadMessage } from "../mail/message-text.ts";
import { searchHeaders } from "../mail/search.ts";
import { PORT_CHAT } from "../shared/chat-messages.ts";
import { readSettings, settleBackendChoice } from "../shared/settings.ts";
import { toCheckResponse } from "../shared/messages.ts";
import type { CheckResponse, StartReplyDraftResponse, TakePendingResponse } from "../shared/messages.ts";
import { BackendError } from "../backend/backend.ts";

// Only user notes, in memory only. If the background script is unloaded the entry is lost,
// which just means the compose popup starts without prefilled notes.
const pending = new PendingReplyDrafts();

// Owns all running jobs and the last results, so they survive closing a popup. The open native port keeps
// this script alive while a job runs (assumption, not documented); finished results are mirrored to
// storage.session and restored lazily if the script was unloaded in between.
// Every run passes the consent gate: without the user's consent (storage.local, read on each run)
// nothing is sent to the model, whatever a page asks for.
// The backend is fixed once per installation before the settings are first read: 0.6 installations stay
// with Claude Code, new ones start with the API key. A failure leaves the default (API key).
const settled = settleBackendChoice(messenger.storage.local).catch(() => undefined);
const settings = () => settled.then(() => readSettings(messenger.storage.local));
// Picks the backend of the settings for every run; the API key is read on each run and goes only to the API.
const switching = new SwitchingBackend({
  backends: {
    cli: new CliBackend(),
    api: new ApiBackend({ getKey: () => readApiKey(messenger.storage.local) }),
  },
  choice: async () => (await settings()).backend,
  os: async () => (await messenger.runtime.getPlatformInfo()).os,
});
const backend = new ConsentGatedBackend(switching, () => readConsent(messenger.storage.local));
const jobs = new JobStore({ backend, session: messenger.storage.session, settings });

// Mailbox queries of the chat tab. Each tab connection gets its own in-memory session that ends with the port.
const chatDeps: ChatDeps = {
  backend,
  search: searchHeaders,
  load: loadMessage,
  settings,
};
const chatTab = new ChatTabTracker({
  session: messenger.storage.session,
  create: () => messenger.tabs.create({ url: "chat/chat.html" }),
  activate: async (tabId) => {
    const tab = await messenger.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await messenger.windows.update(tab.windowId, { focused: true });
  },
});

// Open chat sessions, so a withdrawn consent can stop their runs.
const chatSessions = new Set<ChatSession>();

messenger.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_CHAT) handleChatConnection(port, chatDeps, messenger.runtime.id, (tabId) => void chatTab.adopt(tabId), chatSessions);
  else handleConnection(jobs, port, messenger.runtime.id);
});

messenger.action.onClicked.addListener(() => {
  void chatTab.open();
});

messenger.messageDisplay.onMessagesDisplayed.addListener((tab, displayed) => {
  if (tab.id !== undefined) void jobs.onMessagesDisplayed(tab.id, displayed.messages.map((m) => m.id));
});

messenger.tabs.onRemoved.addListener((tabId) => {
  void jobs.onTabRemoved(tabId);
  void chatTab.onTabRemoved(tabId);
});

messenger.runtime.onInstalled.addListener((details) => {
  console.log(`Mail Assistant installed (${details.reason})`);
  // A new installation shows the setup guide (API key, notices) before anything else.
  if (details.reason === "install") void messenger.tabs.create({ url: GUIDE_PAGE }).catch(() => undefined);
});

// Withdrawing the consent stops every running run at once (new runs are blocked by the gate anyway).
messenger.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(CONSENT_KEY in changes) || isConsentGiven(changes[CONSENT_KEY]?.newValue)) return;
  jobs.cancelAll();
  for (const s of chatSessions) s.cancel();
});

async function startReplyDraft(messageId: number, notes: string): Promise<StartReplyDraftResponse> {
  try {
    // Reply from the identity the mail was addressed to; without one Thunderbird chooses.
    const { identityId } = await findReplyContext(messageId);
    const tab = await messenger.compose.beginReply(messageId, undefined, identityId ? { identityId } : undefined);
    if (tab.id === undefined) return { ok: false };
    pending.put(tab.id, notes);
    let popupOpened = false;
    try {
      popupOpened = (await messenger.composeAction.openPopup({ windowId: tab.windowId })) === true;
    } catch {
      popupOpened = false;
    }
    return { ok: true, popupOpened };
  } catch {
    return { ok: false };
  }
}

/** Longest wait for the connection test (the host gives each of its two CLI calls 15 s). */
const CHECK_TIMEOUT_MS = 40000;

/** Connection test for the settings page; sends no mail content, so it needs no consent. */
async function checkBackend(): Promise<CheckResponse> {
  const { kind } = await switching.current().catch(() => ({ kind: "api" as const }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BackendError("timeout")), CHECK_TIMEOUT_MS);
  });
  try {
    return toCheckResponse(kind, await Promise.race([backend.check(), timeout]));
  } catch (e) {
    return toCheckResponse(kind, { errorCode: e instanceof BackendError ? e.code : "internal" });
  } finally {
    clearTimeout(timer);
  }
}

messenger.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOwnSender(sender.id, messenger.runtime.id)) return false;
  const request = parseRuntimeRequest(message);
  if (!request) return false;
  if (request.type === "checkBackend") {
    void checkBackend().then(sendResponse);
    return true;
  }
  if (request.type === "takePendingReplyDraft") {
    const res: TakePendingResponse = pending.take(request.tabId);
    sendResponse(res);
    return false;
  }
  void startReplyDraft(request.messageId, request.notes).then(sendResponse);
  return true;
});
