import { localizeDocument } from "../shared/i18n.ts";
import { errorMessage } from "../shared/errors.ts";
import { BackendError } from "../backend/backend.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { COMPOSE_MODEL, buildComposePrompt, cleanModelOutput } from "../prompts/compose.ts";
import type { ComposeAction } from "../prompts/compose.ts";
import { applyText, captureSelection } from "./editor-bridge.ts";
import { controls, describeScope, initialState, reduce, resolveAction } from "./popup-state.ts";
import type { PopupEvent } from "./popup-state.ts";

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
const runCustomBtn = $<HTMLButtonElement>("run-custom");
const cancelBtn = $<HTMLButtonElement>("cancel");
const applyBtn = $<HTMLButtonElement>("apply");
const discardBtn = $<HTMLButtonElement>("discard");
const regenerateBtn = $<HTMLButtonElement>("regenerate");
const actionButtons = [...actionsEl.querySelectorAll<HTMLButtonElement>("button[data-action]")];

const backend = new CliBackend();
let state = initialState();
let tabId: number | null = null;
let isPlainText = false;
let lastAction: ComposeAction | null = null;
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
  instructionEl.disabled = !c.actionsEnabled;
  runCustomBtn.disabled = !c.actionsEnabled || instructionEl.value.trim() === "";
  previewSection.hidden = !c.previewVisible;
  cancelBtn.hidden = !c.cancelVisible;
  for (const b of [applyBtn, discardBtn, regenerateBtn]) b.hidden = !c.previewButtonsVisible;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// Captures the current range and updates the scope label and state; returns the text to process.
async function refreshScope(): Promise<string | null> {
  if (tabId === null) {
    dispatch("scope_unusable");
    return null;
  }
  const capture = await captureSelection(tabId, isPlainText);
  const info = describeScope(capture);
  scopeEl.textContent =
    info.count === undefined ? t(info.key) : t(info.key, [String(info.count)]);
  dispatch(info.usable ? "scope_ok" : "scope_unusable");
  return info.usable && "text" in capture ? capture.text : null;
}

async function start(action: ComposeAction): Promise<void> {
  if (state.phase === "streaming") return;
  lastAction = action;
  setStatus("");
  let text: string | null;
  try {
    text = await refreshScope();
  } catch (e) {
    setStatus(errorMessage(e));
    return;
  }
  if (text === null) return;
  const ctl = new AbortController();
  controller = ctl;
  result = "";
  previewEl.textContent = "";
  dispatch("start");
  try {
    const { system, prompt } = buildComposePrompt(action, text);
    for await (const chunk of backend.run({ system, prompt, model: COMPOSE_MODEL, signal: ctl.signal })) {
      result += chunk;
      previewEl.textContent = result;
    }
    if (ctl.signal.aborted) throw new BackendError("cancelled");
    result = cleanModelOutput(result);
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
  if (action) void start(action);
}

for (const b of actionButtons) {
  b.addEventListener("click", () => startChoice(b.dataset["action"] ?? ""));
}
runCustomBtn.addEventListener("click", () => startChoice("custom"));
instructionEl.addEventListener("input", render);
instructionEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    if (!runCustomBtn.disabled) startChoice("custom");
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
  if (!lastAction) return;
  dispatch("discard");
  void start(lastAction);
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
    isPlainText = (await messenger.compose.getComposeDetails(id)).isPlainText === true;
    await refreshScope();
  } catch (e) {
    setStatus(errorMessage(e));
  }
})();
