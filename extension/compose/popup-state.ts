// DOM-free logic of the compose popup (testable in Node).
import type { ComposeAction } from "../prompts/compose.ts";
import type { CaptureResult } from "./editor-text.ts";

export type Phase = "idle" | "streaming" | "preview" | "error";

export interface PopupState {
  phase: Phase;
  /** True if a usable text range was captured. */
  canAct: boolean;
}

export type PopupEvent = "start" | "done" | "fail" | "cancel" | "discard" | "scope_ok" | "scope_unusable";

export function initialState(): PopupState {
  return { phase: "idle", canAct: false };
}

export function reduce(state: PopupState, event: PopupEvent): PopupState {
  switch (event) {
    case "scope_ok":
      return { ...state, canAct: true };
    case "scope_unusable":
      return { ...state, canAct: false };
    case "start":
      return state.canAct && state.phase !== "streaming" ? { ...state, phase: "streaming" } : state;
    case "done":
      return state.phase === "streaming" ? { ...state, phase: "preview" } : state;
    case "fail":
      return state.phase === "streaming" ? { ...state, phase: "error" } : state;
    case "cancel":
      return state.phase === "streaming" ? { ...state, phase: "idle" } : state;
    case "discard":
      return state.phase === "preview" || state.phase === "error" ? { ...state, phase: "idle" } : state;
  }
}

export interface Controls {
  actionsEnabled: boolean;
  cancelVisible: boolean;
  previewVisible: boolean;
  previewButtonsVisible: boolean;
}

export function controls(state: PopupState): Controls {
  return {
    actionsEnabled: state.canAct && (state.phase === "idle" || state.phase === "error"),
    cancelVisible: state.phase === "streaming",
    previewVisible: state.phase === "streaming" || state.phase === "preview",
    previewButtonsVisible: state.phase === "preview",
  };
}

/**
 * Maps a button's data-action ("rephrase", "shorten", "tone:friendly", "translate:de", "custom")
 * to a ComposeAction. Returns null for unknown choices or an empty custom instruction.
 */
export function resolveAction(choice: string, instruction = ""): ComposeAction | null {
  const [kind, arg] = choice.split(":");
  switch (kind) {
    case "rephrase":
    case "shorten":
      return arg === undefined ? { kind } : null;
    case "tone":
      return arg === "friendly" || arg === "formal" || arg === "concise" ? { kind: "tone", tone: arg } : null;
    case "translate":
      return arg === "de" || arg === "en" ? { kind: "translate", lang: arg } : null;
    case "custom": {
      const text = instruction.trim();
      return arg === undefined && text ? { kind: "custom", instruction: text } : null;
    }
    default:
      return null;
  }
}

export interface ScopeInfo {
  /** i18n key of the label; `count` is the substitution for the selection label. */
  key: "composeScopeSelection" | "composeScopeBody" | "composeProtected" | "composeEmpty";
  count?: number;
  usable: boolean;
}

export function describeScope(capture: CaptureResult): ScopeInfo {
  if ("error" in capture) {
    return { key: capture.error === "protected" ? "composeProtected" : "composeEmpty", usable: false };
  }
  if (capture.scope === "selection") {
    return { key: "composeScopeSelection", count: capture.text.length, usable: true };
  }
  return { key: "composeScopeBody", usable: true };
}
