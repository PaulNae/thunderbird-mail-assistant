import { localizeDocument } from "../shared/i18n.ts";
import { setupConsent } from "../shared/consent-ui.ts";
import { errorMessage } from "../shared/errors.ts";
import { showError } from "../shared/guide.ts";
import { BackendError } from "../backend/backend.ts";
import { openJobPort } from "../shared/job-client.ts";
import type { JobPort } from "../shared/job-client.ts";
import { PORT_COMPOSE } from "../shared/job-messages.ts";
import type { JobSnapshot, PortEvent } from "../shared/job-messages.ts";
import { buildComposePrompt, buildInstructionDraftPrompt, buildReplyDraftPrompt } from "../prompts/compose.ts";
import { readSettings } from "../shared/settings.ts";
import type { CaptureResult } from "./editor-text.ts";
import type { TakePendingResponse } from "../shared/messages.ts";
import { applyText, captureSelection, peekSelection } from "./editor-bridge.ts";
import { controls, describeScope, initialState, reduce, resolveAction, planJob, replyHasNoBasis, resolveInstructionJob, scopeEvent, startEvent } from "./popup-state.ts";
import type { PopupEvent, PopupJob } from "./popup-state.ts";
import { loadOriginal } from "../mail/message-text.ts";
import type { OriginalMessage } from "../mail/message-text.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

// Nothing can be started before the user has agreed; the background script enforces this as well.
const consent = setupConsent($("consent"), $("app"), { onDecline: () => window.close(), afterGuide: () => window.close() });
void consent.refresh();

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

let state = initialState();
let tabId: number | null = null;
let isPlainText = false;
let lastJob: PopupJob | null = null;
let relatedMessageId: number | null = null;
let result = "";
let jobPort: JobPort | null = null;
// The background script owns the running job and the preview (memory only); this popup shows the
// latest snapshot. The captured range lives in the editor script and survives closing the popup.
let snapshot: JobSnapshot | null = null;
let initialized = false;
let firstSnapshot: ((s: JobSnapshot) => void) | null = null;

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

function showScope(capture: CaptureResult): { text: string; usable: boolean; replyUsable: boolean } | null {
  const info = describeScope(capture);
  scopeEl.textContent = info.count === undefined ? t(info.key) : t(info.key, [String(info.count)]);
  dispatch(scopeEvent(info));
  return "text" in capture ? { text: capture.text, ...info } : null;
}

// Captures the current range (replacing the stored capture) and updates the scope label and state;
// returns the text to process. A reply draft may also replace an empty own text, so "usable" differs per job type.
async function refreshScope(): Promise<{ text: string; usable: boolean; replyUsable: boolean } | null> {
  if (tabId === null) {
    dispatch("scope_unusable");
    return null;
  }
  return showScope(await captureSelection(tabId, isPlainText));
}

function showSnapshot(snap: JobSnapshot): void {
  snapshot = snap;
  if (snap.job) lastJob = snap.job;
  if (snap.phase === "streaming") {
    previewEl.textContent = snap.text;
    result = "";
  } else if (snap.phase === "done") {
    result = snap.text;
    previewEl.textContent = result;
  } else {
    result = "";
    previewEl.textContent = "";
  }
  if (!initialized) {
    firstSnapshot?.(snap);
    return;
  }
  reportOutcome(snap);
  syncState();
}

function reportOutcome(snap: JobSnapshot): void {
  if (snap.phase === "error" && snap.error !== undefined) {
    if (snap.error === "consent_required") void consent.refresh();
    if (snap.error === "empty_result") setStatus(t("composeEmptyResult"));
    else showError(statusEl, new BackendError(snap.error), () => window.close());
  } else if (snap.phase === "cancelled") {
    setStatus(errorMessage(new BackendError("cancelled")));
  }
}

function syncState(): void {
  if (!snapshot) return;
  switch (snapshot.phase) {
    case "streaming":
      dispatch("resume");
      break;
    case "done":
      dispatch("show_preview");
      applyBtn.focus();
      break;
    case "error":
      dispatch("fail");
      break;
    case "cancelled":
    case "idle":
      dispatch(state.phase === "preview" ? "discard" : "cancel");
      break;
  }
}

function onEvent(event: PortEvent): void {
  if (event.type === "snapshot") {
    showSnapshot(event.snapshot);
    return;
  }
  if (!initialized || state.phase !== "streaming") return;
  previewEl.textContent = (previewEl.textContent ?? "") + event.text;
}

async function start(job: PopupJob): Promise<void> {
  // Synchronously leave idle/error so a second click cannot start a parallel run.
  dispatch("prepare");
  if (state.phase !== "preparing") return;
  lastJob = job;
  setStatus("");
  let scope: Awaited<ReturnType<typeof refreshScope>>;
  try {
    scope = await refreshScope();
  } catch (e) {
    setStatus(errorMessage(e));
    dispatch("prepare_fail");
    return;
  }
  const plan = planJob(job, scope, relatedMessageId !== null);
  if (plan.blocked || !scope) {
    if (plan.blocked === "stale") setStatus(t("composeStale"));
    dispatch("prepare_fail");
    return;
  }
  let original: OriginalMessage | undefined;
  if ((plan.needsOriginal || plan.wantsOriginal) && relatedMessageId !== null) {
    try {
      original = await loadOriginal(relatedMessageId);
    } catch {
      // Continue without the original, but say so.
      setStatus(t("composeOriginalFailed"));
      if (replyHasNoBasis(job, false)) {
        setStatus(t("composeReplyNoBasis"));
        dispatch("prepare_fail");
        return;
      }
    }
  }
  const text = scope.text;
  // The text limit of the settings applies to the own text and to the original mail.
  const maxChars = (await readSettings(messenger.storage.local)).maxTextChars;
  if (job.type === "compose" && text.length > maxChars) {
    setStatus(t("composeTooLong", [String(maxChars)]));
    dispatch("prepare_fail");
    return;
  }
  const { system, prompt } =
    job.type === "reply"
      ? buildReplyDraftPrompt(original, job.notes, maxChars)
      : job.type === "compose"
        ? buildComposePrompt(job.action, text)
        : buildInstructionDraftPrompt(job.instruction, original, maxChars);
  result = "";
  previewEl.textContent = "";
  // The background script picks the model for the job from the settings.
  if (!jobPort?.post({ type: "start", system, prompt, job })) {
    setStatus(t("errorInternal"));
    dispatch("prepare_fail");
    return;
  }
  dispatch(startEvent(job));
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
cancelBtn.addEventListener("click", () => jobPort?.post({ type: "cancel" }));

discardBtn.addEventListener("click", () => {
  jobPort?.post({ type: "discard" });
  previewEl.textContent = "";
  result = "";
  setStatus("");
  dispatch("discard");
});
regenerateBtn.addEventListener("click", () => {
  if (!lastJob) return;
  jobPort?.post({ type: "discard" });
  dispatch("discard");
  void start(lastJob);
});
applyBtn.addEventListener("click", () => {
  void (async () => {
    if (tabId === null) return;
    try {
      const res = await applyText(tabId, result);
      if ("ok" in res) {
        jobPort?.post({ type: "applied" });
        window.close();
        return;
      }
      jobPort?.post({ type: "discard" });
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
    await initScope();
  } catch (e) {
    setStatus(errorMessage(e));
  }
  initialized = true;
  if (snapshot) reportOutcome(snapshot);
  syncState();
  await takePendingReplyDraft();
})();

// Opens the port and waits for the first snapshot. If a job runs or a preview exists, the popup must
// not capture again (that would replace the stored range the preview belongs to): it only peeks.
async function initScope(): Promise<void> {
  if (tabId === null) return;
  const first = new Promise<JobSnapshot | null>((resolve) => {
    firstSnapshot = resolve;
    setTimeout(() => resolve(null), 3000);
  });
  try {
    jobPort = await openJobPort(PORT_COMPOSE, onEvent, () => {
      jobPort = null;
    });
    jobPort.post({ type: "open", tabId });
  } catch {
    jobPort = null;
    setStatus(t("errorInternal"));
  }
  const snap = jobPort ? await first : null;
  if (snap) snapshot = snap;
  // Without a snapshot (background slow to wake) a preview may still exist, so only peek; start()
  // captures anyway before every run.
  const holdsRange = snap === null || snap.phase === "streaming" || snap.phase === "done";
  if (holdsRange) showScope(await peekSelection(tabId, isPlainText));
  else await refreshScope();
}

// A reply draft started from the message display popup: prefill the notes and run the usual path.
async function takePendingReplyDraft(): Promise<void> {
  if (tabId === null) return;
  try {
    const res = (await messenger.runtime.sendMessage({ type: "takePendingReplyDraft", tabId })) as TakePendingResponse | undefined;
    if (!res || typeof res.notes !== "string") return;
    replyNotesEl.value = res.notes;
    if (state.canReply && relatedMessageId !== null) void start({ type: "reply", notes: res.notes });
  } catch {
    // No pending draft is the normal case; ignore errors.
  }
}
