// DOM-free logic of the compose popup (testable in Node).
import type { ComposeAction } from "../prompts/compose.ts";
import { isBlank } from "./editor-text.ts";
import type { CaptureResult } from "./editor-text.ts";

/** What a run does: a rewrite action on the captured text, or a reply draft from the notes. */
export type PopupJob =
  | { type: "compose"; action: ComposeAction }
  | { type: "reply"; notes: string }
  | { type: "instruction_draft"; instruction: string };

export type Phase = "idle" | "preparing" | "streaming" | "preview" | "error";

export interface PopupState {
  phase: Phase;
  /** True if a usable, non-empty text range was captured (rewrite actions). */
  canAct: boolean;
  /** True if a range was captured that a reply draft may replace (an empty own text is fine). */
  canReply: boolean;
}

export type PopupEvent = "prepare" | "prepare_fail" | "start" | "start_reply" | "scope_reply_only" | "done" | "fail" | "cancel" | "discard" | "scope_ok" | "scope_unusable";

export function initialState(): PopupState {
  return { phase: "idle", canAct: false, canReply: false };
}

function canStart(state: PopupState): boolean {
  return state.phase === "idle" || state.phase === "error" || state.phase === "preparing";
}

export function reduce(state: PopupState, event: PopupEvent): PopupState {
  switch (event) {
    case "scope_ok":
      return { ...state, canAct: true, canReply: true };
    case "scope_reply_only":
      return { ...state, canAct: false, canReply: true };
    case "scope_unusable":
      return { ...state, canAct: false, canReply: false };
    case "prepare":
      return state.phase === "idle" || state.phase === "error" ? { ...state, phase: "preparing" } : state;
    case "prepare_fail":
      return state.phase === "preparing" ? { ...state, phase: "idle" } : state;
    case "start":
      return state.canAct && canStart(state) ? { ...state, phase: "streaming" } : state;
    case "start_reply":
      return state.canReply && canStart(state) ? { ...state, phase: "streaming" } : state;
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
  replyEnabled: boolean;
  /** Instruction field and its run button (rewrite by instruction, or draft if the text is empty). */
  instructionEnabled: boolean;
  /** True if the instruction creates new text (own text is empty) instead of rewriting. */
  instructionCreatesDraft: boolean;
  cancelVisible: boolean;
  previewVisible: boolean;
  previewButtonsVisible: boolean;
}

export function controls(state: PopupState): Controls {
  return {
    actionsEnabled: state.canAct && (state.phase === "idle" || state.phase === "error"),
    replyEnabled: state.canReply && (state.phase === "idle" || state.phase === "error"),
    instructionEnabled: (state.canAct || state.canReply) && (state.phase === "idle" || state.phase === "error"),
    instructionCreatesDraft: !state.canAct && state.canReply,
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

/**
 * The job for the free instruction field: rewriting (custom) if there is text to work on, an
 * instruction draft if the own text is empty. Null for a blank instruction or an unusable scope.
 */
export function resolveInstructionJob(state: PopupState, instruction: string): PopupJob | null {
  const text = instruction.trim();
  if (!text) return null;
  if (state.canAct) return { type: "compose", action: { kind: "custom", instruction: text } };
  if (state.canReply) return { type: "instruction_draft", instruction: text };
  return null;
}

export interface ScopeInfo {
  /** i18n key of the label; `count` is the substitution for the selection label. */
  key: "composeScopeSelection" | "composeScopeBody" | "composeScopeInsert" | "composeProtected" | "composeEmpty";
  count?: number;
  /** Usable for rewrite actions (needs non-empty text). */
  usable: boolean;
  /** Usable for a reply draft (an empty own text is fine: the draft goes to the insertion point). */
  replyUsable: boolean;
}

export function describeScope(capture: CaptureResult): ScopeInfo {
  if ("error" in capture) {
    return { key: capture.error === "protected" ? "composeProtected" : "composeEmpty", usable: false, replyUsable: false };
  }
  if (capture.scope === "selection") {
    return { key: "composeScopeSelection", count: capture.text.length, usable: true, replyUsable: true };
  }
  if (isBlank(capture.text)) {
    return { key: "composeScopeInsert", usable: false, replyUsable: true };
  }
  return { key: "composeScopeBody", usable: true, replyUsable: true };
}

/** The scope event matching a ScopeInfo. */
export function scopeEvent(info: ScopeInfo): PopupEvent {
  if (info.usable) return "scope_ok";
  return info.replyUsable ? "scope_reply_only" : "scope_unusable";
}

/** The state event that starts the given job. */
export function startEvent(job: PopupJob): PopupEvent {
  return job.type === "compose" ? "start" : "start_reply";
}

export interface JobScope {
  text: string;
  usable: boolean;
  replyUsable: boolean;
}

export interface JobPlan {
  /** A reply draft: the original is the point of the job (a read failure is reported, the draft continues). */
  needsOriginal: boolean;
  /** An instruction draft in a reply window: the original is added as context if readable. */
  wantsOriginal: boolean;
  /** Set if the job must not run: the text changed meanwhile ("stale") or the scope does not fit ("unusable"). */
  blocked?: "stale" | "unusable";
}

/** Decides from the freshly captured scope whether and how a job runs. Pure; scope null = capture failed. */
export function planJob(job: PopupJob, scope: JobScope | null, hasRelatedMessage: boolean): JobPlan {
  const none = { needsOriginal: false, wantsOriginal: false };
  if (!scope) return { ...none, blocked: "unusable" };
  if (job.type === "compose") return scope.usable ? none : { ...none, blocked: "stale" };
  if (!scope.replyUsable) return { ...none, blocked: "unusable" };
  if (job.type === "instruction_draft") {
    // The own text is no longer empty: the draft would overwrite it.
    if (!isBlank(scope.text)) return { ...none, blocked: "stale" };
    return { needsOriginal: false, wantsOriginal: hasRelatedMessage };
  }
  return hasRelatedMessage ? { needsOriginal: true, wantsOriginal: false } : { ...none, blocked: "unusable" };
}

/** A reply draft without a readable original and without keywords has nothing to base the text on. */
export function replyHasNoBasis(job: PopupJob, originalReadable: boolean): boolean {
  return job.type === "reply" && !originalReadable && job.notes.trim() === "";
}
