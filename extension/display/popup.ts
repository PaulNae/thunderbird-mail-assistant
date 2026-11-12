import { localizeDocument } from "../shared/i18n.ts";
import { errorMessage } from "../shared/errors.ts";
import { BackendError } from "../backend/backend.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { cleanModelOutput } from "../prompts/compose.ts";
import { QUESTION_MODEL, SUMMARY_MODEL, buildQuestionPrompt, buildSummaryPrompt } from "../prompts/read.ts";
import type { HistoryEntry, PromptParts } from "../prompts/read.ts";
import { loadThread } from "../mail/thread.ts";
import type { LoadedThread } from "../mail/thread.ts";
import { appendHistory, canAsk, controls, initialState, isSubmitKey, reduce, threadNotice, uiLang } from "./popup-state.ts";
import type { DisplayEvent } from "./popup-state.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

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

const backend = new CliBackend();
let state = initialState();
let thread: LoadedThread | null = null;
// Lives only in this popup's memory; never stored or logged.
let history: HistoryEntry[] = [];
let controller: AbortController | null = null;

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
}

function renderHistory(): void {
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

// Runs one streamed job into `target`; returns the cleaned text on success, null otherwise.
async function run(parts: PromptParts, model: string, target: HTMLElement): Promise<string | null> {
  const ctl = new AbortController();
  controller = ctl;
  statusEl.textContent = "";
  target.textContent = "";
  let text = "";
  dispatch("start");
  try {
    for await (const chunk of backend.run({ system: parts.system, prompt: parts.prompt, model, signal: ctl.signal })) {
      text += chunk;
      target.textContent = text;
    }
    if (ctl.signal.aborted) throw new BackendError("cancelled");
    text = cleanModelOutput(text);
    if (text.trim() === "") {
      target.textContent = "";
      statusEl.textContent = t("composeEmptyResult");
      dispatch("fail");
      return null;
    }
    target.textContent = text;
    dispatch("done");
    return text;
  } catch (e) {
    target.textContent = "";
    statusEl.textContent = errorMessage(e);
    dispatch(e instanceof BackendError && e.code === "cancelled" ? "cancel" : "fail");
    return null;
  } finally {
    controller = null;
  }
}

function summarize(): void {
  // Synchronous guard before the first await: a second click cannot start a parallel run.
  dispatch("prepare");
  if (state.phase !== "preparing" || !thread) {
    dispatch("prepare_fail");
    return;
  }
  summarySection.hidden = false;
  void run(buildSummaryPrompt(thread, uiLang(messenger.i18n.getUILanguage())), SUMMARY_MODEL, summaryEl).then((ok) => {
    if (ok === null) summarySection.hidden = summaryEl.textContent === "";
  });
}

function ask(): void {
  const question = questionEl.value.trim();
  if (!canAsk(state, question)) return;
  dispatch("prepare");
  if (state.phase !== "preparing" || !thread) {
    dispatch("prepare_fail");
    return;
  }
  answerSection.hidden = false;
  void run(buildQuestionPrompt(thread, history, question), QUESTION_MODEL, answerEl).then((answer) => {
    if (answer !== null) {
      history = appendHistory(history, question, answer, true);
      renderHistory();
      questionEl.value = "";
      answerSection.hidden = true;
      answerEl.textContent = "";
      render();
    } else {
      answerSection.hidden = true;
    }
  });
}

summarizeBtn.addEventListener("click", summarize);
askBtn.addEventListener("click", ask);
cancelBtn.addEventListener("click", () => controller?.abort());
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
    thread = await loadThread(only.id);
    infoEl.textContent = t("displayThreadCount", [String(thread.messages.length)]);
    const notice = threadNotice(thread);
    if (notice) {
      noticeEl.textContent = notice.count === undefined ? t(notice.key) : t(notice.key, [String(notice.count)]);
      noticeEl.hidden = false;
    }
    dispatch("loaded");
  } catch (e) {
    statusEl.textContent = errorMessage(e);
    dispatch("unavailable");
  }
})();
