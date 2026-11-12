import { localizeDocument } from "../shared/i18n.ts";
import { errorMessage } from "../shared/errors.ts";
import { BackendError } from "../backend/backend.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { DRAFT_MODEL, MAX_COMPOSE_CHARS, REWRITE_MODEL, buildComposePrompt, buildInstructionDraftPrompt, buildReplyDraftPrompt, cleanModelOutput } from "../prompts/compose.ts";
import { isBlank } from "./editor-text.ts";
import { applyText, captureSelection } from "./editor-bridge.ts";
import { controls, describeScope, initialState, reduce, resolveAction, resolveInstructionJob, scopeEvent, startEvent } from "./popup-state.ts";
import type { PopupEvent, PopupJob } from "./popup-state.ts";
import { loadOriginal } from "./original-message.ts";
import type { OriginalMessage } from "./original-message.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const scopeEl = $("scope");
const statusEl = $("status");
const actionsEl = $("actions");
const previewSection = $("preview-section");
const previewEl = $("preview");
const instructionEl = $<HTMLInputElement>("instruction");
const instructionLabelEl = $("instruction-label");
const runCustomBtn = $<HTMLButtonElement>("run-custom");
const replySection = $("reply-section");
const replyNotesEl = $<HTMLInputElement>("reply-notes");
const runReplyBtn = $<HTMLButtonElement>("run-reply");
const cancelBtn = $<HTMLButtonElement>("cancel");
const applyBtn = $<HTMLButtonElement>("apply");
const discardBtn = $<HTMLButtonElement>("discard");
const regenerateBtn = $<HTMLButtonElement>("regenerate");
const actionButtons = [...actionsEl.querySelectorAll<HTMLButtonElement>("button[data-action]")];

const backend = new CliBackend();
let state = initialState();
let tabId: number | null = null;
let isPlainText = false;
let lastJob: PopupJob | null = null;
let relatedMessageId: number | null = null;
let controller: AbortController | null = null;
let result = "";

const t = (key: string, subs?: string[]): string => messenger.i18n.getMessage(key, subs);

function dispatch(event: PopupEvent): void {
  state = reduce(state, event);
  render();
}

function render(): void {
  const c = controls(state);
  for (const b of actionButtons) b.disabled = !c.actionsEnabled;
  instructionEl.disabled = !c.instructionEnabled;
  instructionEl.placeholder = t(c.instructionCreatesDraft ? "composeDraftPlaceholder" : "composeInstructionPlaceholder");
  instructionLabelEl.hidden = !c.instructionCreatesDraft;
  runCustomBtn.disabled = !c.instructionEnabled || instructionEl.value.trim() === "";
  replyNotesEl.disabled = !c.replyEnabled;
  runReplyBtn.disabled = !c.replyEnabled;
  previewSection.hidden = !c.previewVisible;
  cancelBtn.hidden = !c.cancelVisible;
  for (const b of [applyBtn, discardBtn, regenerateBtn]) b.hidden = !c.previewButtonsVisible;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// Captures the current range and updates the scope label and state; returns the text to process.
// A reply draft may also replace an empty own text, so "usable" differs per job type.
async function refreshScope(): Promise<{ text: string; usable: boolean; replyUsable: boolean } | null> {
  if (tabId === null) {
    dispatch("scope_unusable");
    return null;
  }
  const capture = await captureSelection(tabId, isPlainText);
  const info = describeScope(capture);
  scopeEl.textContent =
    info.count === undefined ? t(info.key) : t(info.key, [String(info.count)]);
  dispatch(scopeEvent(info));
  return "text" in capture ? { text: capture.text, ...info } : null;
}

async function start(job: PopupJob): Promise<void> {
  // Synchronously leave idle/error so a second click cannot start a parallel run.
  dispatch("prepare");
  if (state.phase !== "preparing") return;
  lastJob = job;
  setStatus("");
  let scope: Awaited<ReturnType<typeof refreshScope>>;
  let original: OriginalMessage | null = null;
  try {
    scope = await refreshScope();
    if (job.type === "instruction_draft" && scope && !isBlank(scope.text)) {
      // The own text is no longer empty: the draft would overwrite it, so do not run.
      setStatus(t("composeStale"));
      dispatch("prepare_fail");
      return;
    }
    if (scope && job.type !== "compose" && scope.replyUsable && (job.type === "reply" || relatedMessageId !== null)) {
      if (relatedMessageId === null) {
        dispatch("prepare_fail");
        return;
      }
      try {
        original = await loadOriginal(relatedMessageId);
      } catch {
        setStatus(t("composeOriginalFailed"));
        dispatch("prepare_fail");
        return;
      }
    }
  } catch (e) {
    setStatus(errorMessage(e));
    dispatch("prepare_fail");
    return;
  }
  if (!scope || !(job.type === "compose" ? scope.usable : scope.replyUsable)) {
    if (scope && job.type === "compose") setStatus(t("composeStale"));
    dispatch("prepare_fail");
    return;
  }
  const text = scope.text;
  if (job.type === "compose" && text.length > MAX_COMPOSE_CHARS) {
    setStatus(t("composeTooLong", [String(MAX_COMPOSE_CHARS)]));
    dispatch("prepare_fail");
    return;
  }
  const ctl = new AbortController();
  controller = ctl;
  result = "";
  previewEl.textContent = "";
  dispatch(startEvent(job));
  try {
    const { system, prompt } =
      job.type === "reply" && original
        ? buildReplyDraftPrompt(original, job.notes)
        : job.type === "compose"
          ? buildComposePrompt(job.action, text)
          : job.type === "instruction_draft"
            ? buildInstructionDraftPrompt(job.instruction, original ?? undefined)
            : (() => {
                throw new Error("Original message missing");
              })();
    const model = job.type === "compose" ? REWRITE_MODEL : DRAFT_MODEL;
    for await (const chunk of backend.run({ system, prompt, model, signal: ctl.signal })) {
      result += chunk;
      previewEl.textContent = result;
    }
    if (ctl.signal.aborted) throw new BackendError("cancelled");
    result = cleanModelOutput(result);
    if (isBlank(result)) {
      previewEl.textContent = "";
      result = "";
      setStatus(t("composeEmptyResult"));
      dispatch("fail");
      return;
    }
    previewEl.textContent = result;
    dispatch("done");
    applyBtn.focus();
  } catch (e) {
    previewEl.textContent = "";
    if (e instanceof BackendError && e.code === "cancelled") {
      setStatus(errorMessage(e));
      dispatch("cancel");
    } else {
      setStatus(errorMessage(e));
      dispatch("fail");
    }
  } finally {
    controller = null;
  }
}

function startChoice(choice: string): void {
  const action = resolveAction(choice, instructionEl.value);
  if (action) void start({ type: "compose", action });
}

function startInstruction(): void {
  const job = resolveInstructionJob(state, instructionEl.value);
  if (job) void start(job);
}

function startReply(): void {
  if (!runReplyBtn.disabled) void start({ type: "reply", notes: replyNotesEl.value });
}
runReplyBtn.addEventListener("click", startReply);
replyNotesEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    startReply();
  }
});

for (const b of actionButtons) {
  b.addEventListener("click", () => startChoice(b.dataset["action"] ?? ""));
}
runCustomBtn.addEventListener("click", () => startInstruction());
instructionEl.addEventListener("input", render);
instructionEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    if (!runCustomBtn.disabled) startInstruction();
  }
});
cancelBtn.addEventListener("click", () => controller?.abort());

discardBtn.addEventListener("click", () => {
  previewEl.textContent = "";
  result = "";
  setStatus("");
  dispatch("discard");
});
regenerateBtn.addEventListener("click", () => {
  if (!lastJob) return;
  dispatch("discard");
  void start(lastJob);
});
applyBtn.addEventListener("click", () => {
  void (async () => {
    if (tabId === null) return;
    try {
      const res = await applyText(tabId, result);
      if ("ok" in res) {
        window.close();
        return;
      }
      previewEl.textContent = "";
      setStatus(t("composeStale"));
      dispatch("discard");
      await refreshScope();
    } catch (e) {
      setStatus(errorMessage(e));
    }
  })();
});

void (async () => {
  render();
  try {
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    if (id === undefined) throw new Error("No compose tab");
    tabId = id;
    const details = await messenger.compose.getComposeDetails(id);
    isPlainText = details.isPlainText === true;
    if (details.type === "reply" && details.relatedMessageId !== undefined) {
      relatedMessageId = details.relatedMessageId;
      replySection.hidden = false;
    }
    await refreshScope();
  } catch (e) {
    setStatus(errorMessage(e));
  }
})();
