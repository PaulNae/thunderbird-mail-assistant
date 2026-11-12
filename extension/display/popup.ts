import { localizeDocument } from "../shared/i18n.ts";
import { setupConsent } from "../shared/consent-ui.ts";
import { errorMessage } from "../shared/errors.ts";
import { BackendError } from "../backend/backend.ts";
import { openJobPort } from "../shared/job-client.ts";
import type { JobPort } from "../shared/job-client.ts";
import { PORT_DISPLAY } from "../shared/job-messages.ts";
import type { JobSnapshot, PortEvent } from "../shared/job-messages.ts";
import { MAX_QUESTION_CHARS, QUESTION_MODEL, SUMMARY_MODEL, buildQuestionPrompt, buildSummaryPrompt } from "../prompts/read.ts";
import type { HistoryEntry, PromptParts } from "../prompts/read.ts";
import { loadThread } from "../mail/thread.ts";
import type { LoadedThread } from "../mail/thread.ts";
import { canAsk, controls, initialState, isSubmitKey, questionTooLong, reduce, threadNotice, uiLang } from "./popup-state.ts";
import type { DisplayEvent } from "./popup-state.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

// Nothing can be started before the user has agreed; the background script enforces this as well.
const consent = setupConsent($("consent"), $("app"), { onDecline: () => window.close() });
void consent.refresh();

const infoEl = $("info");
const noticeEl = $("notice");
const statusEl = $("status");
const summarizeBtn = $<HTMLButtonElement>("summarize");
const cancelBtn = $<HTMLButtonElement>("cancel");
const summarySection = $("summary-section");
const summaryEl = $("summary");
const historySection = $("history-section");
const historyEl = $("history");
const answerSection = $("answer-section");
const answerEl = $("answer");
const questionEl = $<HTMLInputElement>("question");
const askBtn = $<HTMLButtonElement>("ask");
const replyNotesEl = $<HTMLInputElement>("reply-notes");
const replyBtn = $<HTMLButtonElement>("reply-draft");

let state = initialState();
let thread: LoadedThread | null = null;
let displayedId: number | null = null;
let replyStarting = false;
let jobPort: JobPort | null = null;
// The background script owns running jobs, the last summary and the question history (memory only);
// this popup shows the latest snapshot and the streamed text.
let snapshot: JobSnapshot | null = null;
let streamText = "";

const t = (key: string, subs?: string[]): string => messenger.i18n.getMessage(key, subs);

function dispatch(event: DisplayEvent): void {
  state = reduce(state, event);
  render();
}

function render(): void {
  const c = controls(state);
  summarizeBtn.disabled = !c.summarizeEnabled;
  questionEl.disabled = !c.askEnabled;
  askBtn.disabled = !canAsk(state, questionEl.value);
  cancelBtn.hidden = !c.cancelVisible;
  replyNotesEl.disabled = !c.replyEnabled;
  replyBtn.disabled = !c.replyEnabled || replyStarting || displayedId === null;
}

function startReplyDraft(): void {
  if (replyBtn.disabled || displayedId === null) return;
  replyStarting = true;
  statusEl.textContent = "";
  render();
  void (async () => {
    try {
      const res = (await messenger.runtime.sendMessage({ type: "startReplyDraft", messageId: displayedId, notes: replyNotesEl.value })) as
        | { ok?: boolean; popupOpened?: boolean }
        | undefined;
      if (res?.ok !== true) statusEl.textContent = t("displayReplyFailed");
      else if (res.popupOpened === true) window.close();
      else statusEl.textContent = t("displayReplyOpened");
    } catch {
      statusEl.textContent = t("displayReplyFailed");
    } finally {
      replyStarting = false;
      render();
    }
  })();
}

function renderHistory(history: readonly HistoryEntry[]): void {
  historyEl.replaceChildren();
  for (const entry of history) {
    const li = document.createElement("li");
    const q = document.createElement("p");
    q.className = "question";
    q.textContent = entry.question;
    const a = document.createElement("pre");
    a.textContent = entry.answer;
    li.append(q, a);
    historyEl.append(li);
  }
  historySection.hidden = history.length === 0;
}

// Shows a snapshot. While the thread is still loading only the content is shown; the state is
// synced once loading has finished (see syncState).
function showSnapshot(snap: JobSnapshot): void {
  const before = snapshot;
  snapshot = snap;
  const streaming = snap.phase === "streaming";
  streamText = streaming ? snap.text : "";
  summarySection.hidden = !(snap.summary !== "" || (streaming && snap.kind === "summary"));
  summaryEl.textContent = streaming && snap.kind === "summary" ? snap.text : snap.summary;
  answerSection.hidden = !(streaming && snap.kind === "question");
  answerEl.textContent = streaming && snap.kind === "question" ? snap.text : "";
  renderHistory(snap.history);
  if (streaming && snap.question !== undefined && questionEl.value === "") questionEl.value = snap.question;
  if (before?.phase === "streaming" && snap.phase === "done" && snap.kind === "question") questionEl.value = "";
  if (!streaming) {
    if (snap.phase === "error" && snap.error !== undefined) {
      if (snap.error === "consent_required") void consent.refresh();
      statusEl.textContent = snap.error === "empty_result" ? t("composeEmptyResult") : errorMessage(new BackendError(snap.error));
    } else if (snap.phase === "cancelled") {
      statusEl.textContent = errorMessage(new BackendError("cancelled"));
    }
  } else {
    statusEl.textContent = "";
  }
  syncState();
}

function syncState(): void {
  if (!snapshot || state.phase === "loading" || state.phase === "unavailable" || state.phase === "preparing") return;
  switch (snapshot.phase) {
    case "streaming":
      dispatch("resume");
      break;
    case "done":
      dispatch("done");
      break;
    case "error":
      dispatch("fail");
      break;
    case "cancelled":
    case "idle":
      dispatch("cancel");
      break;
  }
}

function startJob(kind: "summary" | "question", parts: PromptParts, model: string, question?: string): void {
  if (displayedId === null || !jobPort) {
    dispatch("prepare_fail");
    return;
  }
  statusEl.textContent = "";
  const ok = jobPort.post({ type: "start", kind, system: parts.system, prompt: parts.prompt, model, messageId: displayedId, ...(question === undefined ? {} : { question }) });
  if (!ok) {
    statusEl.textContent = t("errorInternal");
    dispatch("prepare_fail");
    return;
  }
  // The background confirms with a snapshot; show the streaming state right away.
  streamText = "";
  (kind === "summary" ? summarySection : answerSection).hidden = false;
  dispatch("start");
}

function summarize(): void {
  // Synchronous guard before the first await: a second click cannot start a parallel run.
  dispatch("prepare");
  if (state.phase !== "preparing" || !thread) {
    dispatch("prepare_fail");
    return;
  }
  startJob("summary", buildSummaryPrompt(thread, uiLang(messenger.i18n.getUILanguage())), SUMMARY_MODEL);
}

function ask(): void {
  const question = questionEl.value.trim();
  if (!canAsk(state, question)) return;
  if (questionTooLong(question)) {
    statusEl.textContent = t("displayQuestionTooLong", [String(MAX_QUESTION_CHARS)]);
    return;
  }
  statusEl.textContent = "";
  dispatch("prepare");
  if (state.phase !== "preparing" || !thread) {
    dispatch("prepare_fail");
    return;
  }
  startJob("question", buildQuestionPrompt(thread, snapshot?.history ?? [], question), QUESTION_MODEL, question);
}

function onEvent(event: PortEvent): void {
  if (event.type === "snapshot") {
    showSnapshot(event.snapshot);
    return;
  }
  if (snapshot?.phase !== "streaming" && state.phase !== "streaming") return;
  streamText += event.text;
  (snapshot?.kind === "question" ? answerEl : summaryEl).textContent = streamText;
}

summarizeBtn.addEventListener("click", summarize);
askBtn.addEventListener("click", ask);
replyBtn.addEventListener("click", startReplyDraft);
replyNotesEl.addEventListener("keydown", (ev) => {
  if (isSubmitKey(ev)) {
    ev.preventDefault();
    startReplyDraft();
  }
});
cancelBtn.addEventListener("click", () => jobPort?.post({ type: "cancel" }));
questionEl.addEventListener("input", render);
questionEl.addEventListener("keydown", (ev) => {
  if (isSubmitKey(ev)) {
    ev.preventDefault();
    ask();
  }
});

void (async () => {
  render();
  try {
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    if (id === undefined) throw new Error("No tab");
    // MV3 returns a MessageList ({ id, messages }), not an array.
    const shown = await messenger.messageDisplay.getDisplayedMessages(id);
    const only = shown.messages.length === 1 ? shown.messages[0] : undefined;
    if (!only) {
      infoEl.textContent = t("displaySelectOne");
      dispatch("unavailable");
      return;
    }
    // Set first: the reply draft works even if loading the thread fails.
    displayedId = only.id;
    try {
      jobPort = await openJobPort(PORT_DISPLAY, onEvent, () => {
        jobPort = null;
      });
      jobPort.post({ type: "open", tabId: id, messageId: only.id });
    } catch {
      jobPort = null;
    }
    try {
      thread = await loadThread(only.id);
    } catch (e) {
      statusEl.textContent = errorMessage(e);
      dispatch("loaded_no_thread");
      syncState();
      return;
    }
    infoEl.textContent = t("displayThreadCount", [String(thread.messages.length)]);
    const notice = threadNotice(thread);
    if (notice) {
      noticeEl.textContent = notice.count === undefined ? t(notice.key) : t(notice.key, [String(notice.count)]);
      noticeEl.hidden = false;
    }
    dispatch("loaded");
    syncState();
  } catch (e) {
    statusEl.textContent = errorMessage(e);
    dispatch("unavailable");
  }
})();
