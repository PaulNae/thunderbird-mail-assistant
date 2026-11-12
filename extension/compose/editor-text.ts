// DOM-free helpers and shared types for the compose editor script (testable in Node).

export type CaptureScope = "selection" | "body";
export type CaptureResult =
  | { scope: CaptureScope; text: string }
  | { error: "protected" | "empty" };
export type ApplyResult = { ok: true } | { error: "no_capture" | "stale" };

export interface EditorApi {
  capture(isPlainText: boolean): CaptureResult;
  apply(text: string): ApplyResult;
  /** Same range determination as capture, but leaves the stored capture untouched (for display only). */
  peek(isPlainText: boolean): CaptureResult;
}

export type InsertOp = { kind: "text"; value: string } | { kind: "br" };

/** Normalizes all line break variants to "\n". */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Splits text into lines after normalizing line breaks. Always returns at least one entry. */
export function splitLines(text: string): string[] {
  return normalizeNewlines(text).split("\n");
}

/** Converts text into insert operations: text runs and line breaks (empty lines yield no text op). */
export function toInsertOps(text: string): InsertOp[] {
  const ops: InsertOp[] = [];
  splitLines(text).forEach((line, i) => {
    if (i > 0) ops.push({ kind: "br" });
    if (line !== "") ops.push({ kind: "text", value: line });
  });
  return ops;
}

/** Compares captured text with fresh text, ignoring line break style and non-breaking spaces. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string): string => normalizeNewlines(s).replace(/\u00a0/g, " ");
  return norm(a) === norm(b);
}

/** True if the text is empty or only whitespace (including non-breaking spaces). */
export function isBlank(text: string): boolean {
  return text.replace(/[\s\u00a0]+/g, "") === "";
}

/** Offset of the first plain-text signature delimiter line ("-- ") in a text node's data, or -1. */
export function findSignatureOffset(data: string): number {
  const norm = data.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  let offset = 0;
  for (const line of norm.split("\n")) {
    if (line === "-- ") return offset;
    offset += line.length + 1;
  }
  return -1;
}
