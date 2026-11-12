// Background script. Listeners must be registered at top level (MV3).
import { PendingReplyDrafts, isOwnSender, parseRuntimeRequest } from "../shared/messages.ts";
import { findReplyContext } from "../mail/identity.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { handleConnection } from "./connection.ts";
import { JobStore } from "./jobs.ts";
import type { StartReplyDraftResponse, TakePendingResponse } from "../shared/messages.ts";

// Only user notes, in memory only. If the background script is unloaded the entry is lost,
// which just means the compose popup starts without prefilled notes.
const pending = new PendingReplyDrafts();

// Owns all running jobs and the last results, so they survive closing a popup. The open native port keeps
// this script alive while a job runs (assumption, not documented); finished results are mirrored to
// storage.session and restored lazily if the script was unloaded in between.
const jobs = new JobStore({ backend: new CliBackend(), session: messenger.storage.session });

messenger.runtime.onConnect.addListener((port) => handleConnection(jobs, port, messenger.runtime.id));

messenger.messageDisplay.onMessagesDisplayed.addListener((tab, displayed) => {
  if (tab.id !== undefined) void jobs.onMessagesDisplayed(tab.id, displayed.messages.map((m) => m.id));
});

messenger.tabs.onRemoved.addListener((tabId) => {
  void jobs.onTabRemoved(tabId);
});

messenger.runtime.onInstalled.addListener((details) => {
  console.log(`Mail Assistant installed (${details.reason})`);
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

messenger.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOwnSender(sender.id, messenger.runtime.id)) return false;
  const request = parseRuntimeRequest(message);
  if (!request) return false;
  if (request.type === "takePendingReplyDraft") {
    const res: TakePendingResponse = pending.take(request.tabId);
    sendResponse(res);
    return false;
  }
  void startReplyDraft(request.messageId, request.notes).then(sendResponse);
  return true;
});
