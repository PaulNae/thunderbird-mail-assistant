// Content script injected into the compose editor document via scripting.executeScript.
// Captures the selection (or the user's own text) and later replaces only that range.
// Quotes, forwarded content and the signature are never touched. Text is inserted as text only.
import {
  findSignatureOffset,
  isBlank,
  sameText,
  toInsertOps,
  type ApplyResult,
  type CaptureResult,
  type EditorApi,
  type InsertOp,
} from "./editor-text.ts";

const PROTECTED_SELECTOR =
  'blockquote[type="cite"], .moz-cite-prefix, .moz-signature, .moz-forward-container, span[_moz_quote="true"]';
const WRAPPER_SELECTOR = ".moz-text-plain, .moz-text-flowed, .moz-text-html";

interface Capture {
  range: Range;
  text: string;
}

let current: Capture | null = null;

function isProtectedNode(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el && el.closest(PROTECTED_SELECTOR) !== null;
}

function containsProtected(node: Node): boolean {
  if (isProtectedNode(node)) return true;
  return node instanceof Element && node.querySelector(PROTECTED_SELECTOR) !== null;
}

/** Top-level container: the body, or the single Thunderbird wrapper div inside it. */
function getRoot(): Element {
  const body = document.body;
  const elements = Array.from(body.children);
  const onlyWrapper = elements.length === 1 && elements[0]?.matches(WRAPPER_SELECTOR);
  const hasOwnText = Array.from(body.childNodes).some(
    (n) => n.nodeType === Node.TEXT_NODE && !isBlank(n.textContent ?? ""),
  );
  return onlyWrapper && !hasOwnText ? (elements[0] as Element) : body;
}

interface SignaturePoint {
  node: Node;
  offset: number;
}

/**
 * Plain-text signature delimiter ("-- " line), only if no .moz-signature element exists.
 * Everything from this point to the end of the root is treated as protected.
 */
function findPlainSignature(root: Element, isPlainText: boolean): SignaturePoint | null {
  if (!isPlainText || document.querySelector(".moz-signature")) return null;
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const offset = findSignatureOffset(child.textContent ?? "");
    if (offset >= 0) return { node: child, offset };
  }
  return null;
}

function selectionTouchesProtected(range: Range, sig: SignaturePoint | null): boolean {
  if (isProtectedNode(range.commonAncestorContainer)) return true;
  for (const el of Array.from(document.querySelectorAll(PROTECTED_SELECTOR))) {
    if (range.intersectsNode(el)) return true;
  }
  // The signature runs to the end of the root, so the range touches it if its start
  // is not after the delimiter.
  return !!sig && range.comparePoint(sig.node, sig.offset) <= 0;
}

/** Range of the first contiguous run of own (unprotected, non-empty) top-level content. */
function findOwnTextRange(root: Element, sig: SignaturePoint | null): Range | null {
  const nodes = Array.from(root.childNodes);
  const sigIndex = sig ? nodes.indexOf(sig.node as ChildNode) : -1;
  const limit = sigIndex >= 0 ? sigIndex : nodes.length;
  const hasText = (n: Node): boolean => !isBlank(n.textContent ?? "");

  let first = -1;
  let last = -1;
  for (let i = 0; i < limit; i++) {
    const n = nodes[i] as ChildNode;
    if (containsProtected(n)) {
      if (first >= 0) break;
      continue;
    }
    if (hasText(n)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  let partialEnd: SignaturePoint | null = null;
  if (sig && sigIndex >= 0 && sig.offset > 0 && !isBlank((sig.node.textContent ?? "").slice(0, sig.offset))) {
    // Own text sits in the same text node before the delimiter. Only usable if the run
    // reached this node without hitting a protected node.
    const reached = first < 0 ? nodes.slice(0, sigIndex).every((n) => !containsProtected(n)) : last === sigIndex - 1 || nodes.slice(last + 1, sigIndex).every((n) => !containsProtected(n) && !hasText(n));
    if (reached) {
      partialEnd = sig;
      if (first < 0) first = sigIndex;
    }
  }
  if (first < 0) return null;
  const range = document.createRange();
  range.setStartBefore(nodes[first] as ChildNode);
  if (partialEnd) range.setEnd(partialEnd.node, partialEnd.offset);
  else range.setEndAfter(nodes[last] as ChildNode);
  return range;
}

function emptyBodyRange(root: Element): Range {
  const range = document.createRange();
  range.setStart(root, 0);
  range.collapse(true);
  return range;
}

/** A collapsed caret in unprotected content of the root, used as insertion point for empty own text. */
function cursorRange(root: Element, sig: SignaturePoint | null): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (isProtectedNode(range.startContainer)) return null;
  if (sig && range.comparePoint(sig.node, sig.offset) < 0) return null;
  return range.cloneRange();
}

function textOfRange(range: Range): string {
  const sel = window.getSelection();
  if (!sel) return "";
  const saved: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i).cloneRange());
  sel.removeAllRanges();
  sel.addRange(range);
  const text = sel.toString();
  sel.removeAllRanges();
  for (const r of saved) sel.addRange(r);
  return text;
}

function capture(isPlainText: boolean): CaptureResult {
  current = null;
  const root = getRoot();
  const sig = findPlainSignature(root, isPlainText);
  const sel = window.getSelection();

  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return { error: "protected" };
    if (selectionTouchesProtected(range, sig)) return { error: "protected" };
    const text = sel.toString();
    if (isBlank(text)) return { error: "empty" };
    current = { range: range.cloneRange(), text };
    return { scope: "selection", text };
  }

  const own = findOwnTextRange(root, sig);
  const range = own ?? cursorRange(root, sig) ?? emptyBodyRange(root);
  const text = own ? textOfRange(range) : "";
  current = { range, text };
  return { scope: "body", text };
}

function runOps(ops: InsertOp[]): number {
  // Returns the index of the first op that failed, or ops.length on success.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as InsertOp;
    let ok: boolean;
    try {
      ok =
        op.kind === "text"
          ? document.execCommand("insertText", false, op.value)
          : document.execCommand("insertLineBreak");
    } catch {
      ok = false;
    }
    if (!ok) return i;
  }
  return ops.length;
}

function domInsert(range: Range, ops: InsertOp[]): void {
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  for (const op of ops) {
    fragment.appendChild(
      op.kind === "text" ? document.createTextNode(op.value) : document.createElement("br"),
    );
  }
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) range.setStartAfter(last);
  range.collapse(true);
}

function apply(text: string): ApplyResult {
  const cap = current;
  if (!cap) return { error: "no_capture" };
  const sel = window.getSelection();
  if (!sel) return { error: "no_capture" };
  if (!sameText(textOfRange(cap.range), cap.text)) {
    current = null;
    return { error: "stale" };
  }
  current = null;

  sel.removeAllRanges();
  sel.addRange(cap.range);
  const ops = toInsertOps(text);

  if (ops.length === 0) {
    if (!cap.range.collapsed) {
      let ok: boolean;
      try {
        ok = document.execCommand("delete");
      } catch {
        ok = false;
      }
      if (!ok) cap.range.deleteContents();
    }
    return { ok: true };
  }

  const failedAt = runOps(ops);
  if (failedAt < ops.length) {
    // Continue at the current caret (or over the still-selected range if nothing was inserted).
    const live = sel.rangeCount > 0 ? sel.getRangeAt(0) : cap.range;
    domInsert(live, ops.slice(failedAt));
  }
  return { ok: true };
}

const api: EditorApi = { capture, apply };
const g = globalThis as { mailAssistantEditor?: EditorApi };
if (!g.mailAssistantEditor) g.mailAssistantEditor = api;
