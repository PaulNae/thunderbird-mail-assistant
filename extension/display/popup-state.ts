// DOM-free logic of the message display popup (testable in Node).
import { MAX_QUESTION_CHARS } from "../prompts/read.ts";
import type { HistoryEntry } from "../prompts/read.ts";

export type Phase = "loading" | "unavailable" | "idle" | "preparing" | "streaming" | "done" | "error";

export interface DisplayState {
  phase: Phase;
  /** Thread loading failed, but the displayed message is known: only the reply draft works. */
  replyOnly?: boolean;
}

export type DisplayEvent = "loaded" | "loaded_no_thread" | "unavailable" | "prepare" | "prepare_fail" | "start" | "resume" | "done" | "fail" | "cancel";

export function initialState(): DisplayState {
  return { phase: "loading" };
}

const READY: readonly Phase[] = ["idle", "done", "error"];

export function reduce(state: DisplayState, event: DisplayEvent): DisplayState {
  const next = step(state, event);
  return next === state || !state.replyOnly ? next : { ...next, replyOnly: true };
}

function step(state: DisplayState, event: DisplayEvent): DisplayState {
  const p = state.phase;
  switch (event) {
    case "loaded":
      return p === "loading" ? { phase: "idle" } : state;
    case "loaded_no_thread":
      return p === "loading" ? { phase: "idle", replyOnly: true } : state;
    case "unavailable":
      return p === "loading" ? { phase: "unavailable" } : state;
    case "prepare":
      return READY.includes(p) ? { phase: "preparing" } : state;
    case "prepare_fail":
      return p === "preparing" ? { phase: "idle" } : state;
    case "start":
      return p === "preparing" ? { phase: "streaming" } : state;
    case "resume":
      // A job started earlier (popup reopened) is still running in the background.
      return READY.includes(p) ? { phase: "streaming" } : state;
    case "done":
      return p === "streaming" ? { phase: "done" } : state;
    case "fail":
      return p === "streaming" ? { phase: "error" } : state;
    case "cancel":
      return p === "streaming" ? { phase: "idle" } : state;
  }
}

export interface Controls {
  /** Summarize button. */
  summarizeEnabled: boolean;
  /** Question field and ask button (the button also needs a non-empty question). */
  askEnabled: boolean;
  /** Reply draft button and its notes field. */
  replyEnabled: boolean;
  cancelVisible: boolean;
}

export function controls(state: DisplayState): Controls {
  const ready = READY.includes(state.phase);
  const read = ready && state.replyOnly !== true;
  return { summarizeEnabled: read, askEnabled: read, replyEnabled: ready, cancelVisible: state.phase === "streaming" };
}

/** Whether the ask button may start: a ready state and a non-blank question. */
export function canAsk(state: DisplayState, question: string): boolean {
  return controls(state).askEnabled && question.trim() !== "";
}

/** Whether the question is too long to send. */
export function questionTooLong(question: string): boolean {
  return question.trim().length > MAX_QUESTION_CHARS;
}

/** The history after a finished answer; failed or cancelled answers are never added. */
export function appendHistory(
  history: readonly HistoryEntry[],
  question: string,
  answer: string,
  ok: boolean,
): HistoryEntry[] {
  return ok && answer.trim() !== "" ? [...history, { question: question.trim(), answer }] : [...history];
}

export interface NoticeInput {
  truncated: boolean;
  omittedCount: number;
}

export interface Notice {
  key: "displayOmitted" | "displayShortened" | "displayOmittedShortened";
  count?: number;
}

/** The visible hint if the thread context was cut down; null if nothing was cut. */
export function threadNotice(thread: NoticeInput): Notice | null {
  if (thread.omittedCount > 0 && thread.truncated) return { key: "displayOmittedShortened", count: thread.omittedCount };
  if (thread.omittedCount > 0) return { key: "displayOmitted", count: thread.omittedCount };
  if (thread.truncated) return { key: "displayShortened" };
  return null;
}

/** Enter without Shift (and not during IME composition) starts the question. */
export function isSubmitKey(ev: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return ev.key === "Enter" && !ev.shiftKey && !ev.isComposing;
}

export function uiLang(language: string): "de" | "en" {
  return language.toLowerCase().startsWith("de") ? "de" : "en";
}
