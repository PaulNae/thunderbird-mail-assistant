import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSignatureOffset,
  isBlank,
  normalizeNewlines,
  sameText,
  splitLines,
  toInsertOps,
} from "../extension/compose/editor-text.ts";

test("normalizeNewlines converts CRLF and CR to LF", () => {
  assert.equal(normalizeNewlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("splitLines keeps empty lines and returns one entry for empty text", () => {
  assert.deepEqual(splitLines("a\r\n\r\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines(""), [""]);
});

test("toInsertOps yields text and line breaks, skipping empty text", () => {
  assert.deepEqual(toInsertOps("a\n\nb"), [
    { kind: "text", value: "a" },
    { kind: "br" },
    { kind: "br" },
    { kind: "text", value: "b" },
  ]);
  assert.deepEqual(toInsertOps(""), []);
  assert.deepEqual(toInsertOps("<b>x</b>"), [{ kind: "text", value: "<b>x</b>" }]);
});

test("sameText ignores newline style and nbsp", () => {
  assert.ok(sameText("a\r\nb", "a\nb"));
  assert.ok(sameText("a\u00a0b", "a b"));
  assert.ok(!sameText("a", "b"));
});

test("isBlank detects whitespace-only text", () => {
  assert.ok(isBlank(" \n\u00a0\t"));
  assert.ok(!isBlank(" x "));
});

test("findSignatureOffset finds the '-- ' line only", () => {
  assert.equal(findSignatureOffset("hello\n-- \nJane"), 6);
  assert.equal(findSignatureOffset("-- "), 0);
  assert.equal(findSignatureOffset("--\nfoo"), -1);
  assert.equal(findSignatureOffset("a -- b"), -1);
  assert.equal(findSignatureOffset("x\r\n--\u00a0\r\ny"), 2);
});
