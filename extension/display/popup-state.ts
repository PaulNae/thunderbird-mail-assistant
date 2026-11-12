// DOM-free logic of the message display popup (testable in Node).
import type { HistoryEntry } from "../prompts/read.ts";

export type Phase = "loading" | "unavailable" | "idle" | "preparing" | "streaming" | "done" | "error";

export interface DisplayState {
  phase: Phase;
}

export type DisplayEvent = "loaded" | "unavailable" | "prepare" | "prepare_fail" | "start" | "done" | "fail" | "cancel";

export function initialState(): DisplayState {
  return { phase: "loading" };
}

const READY: readonly Phase[] = ["idle", "done", "error"];

export function reduce(state: DisplayState, event: DisplayEvent): DisplayState {
  const p = state.phase;
  switch (event) {
    case "loaded":
      return p === "loading" ? { phase: "idle" } : state;
    case "unavailable":
      return p === "loading" ? { phase: "unavailable" } : state;
    case "prepare":
      return READY.includes(p) ? { phase: "preparing" } : state;
    case "prepare_fail":
      return p === "preparing" ? { phase: "idle" } : state;
    case "start":
      return p === "preparing" ? { phase: "streaming" } : state;
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
  cancelVisible: boolean;
}

export function controls(state: DisplayState): Controls {
  const ready = READY.includes(state.phase);
  return { summarizeEnabled: ready, askEnabled: ready, cancelVisible: state.phase === "streaming" };
}

/** Whether the ask button may start: a ready state and a non-blank question. */
export function canAsk(state: DisplayState, question: string): boolean {
  return controls(state).askEnabled && question.trim() !== "";
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
