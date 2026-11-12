import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ORIGINAL_TEXT, joinParts, selectParts } from "../extension/compose/original-text.ts";

test("prefers text/plain over text/html", () => {
  const sel = selectParts([
    { contentType: "text/html", content: "<p>h</p>" },
    { contentType: "text/plain; charset=utf-8", content: "plain" },
  ]);
  assert.deepEqual(sel, { kind: "plain", parts: ["plain"] });
});

test("falls back to html when plain is blank or missing", () => {
  assert.deepEqual(
    selectParts([
      { contentType: "text/plain", content: " \n " },
      { contentType: "TEXT/HTML", content: "<p>h</p>" },
    ]),
    { kind: "html", parts: ["<p>h</p>"] },
  );
});

test("returns null without usable text parts", () => {
  assert.equal(selectParts([]), null);
  assert.equal(selectParts([{ contentType: "image/png", content: "x" }]), null);
  assert.equal(selectParts([{ contentType: "text/plain", content: "  " }]), null);
});

test("keeps several parts of the chosen kind in order", () => {
  const sel = selectParts([
    { contentType: "text/plain", content: "a" },
    { contentType: "text/html", content: "<b>x</b>" },
    { contentType: "text/plain", content: "b" },
  ]);
  assert.deepEqual(sel?.parts, ["a", "b"]);
});

test("joinParts normalizes, trims, skips blanks and caps", () => {
  assert.equal(joinParts(["a\r\nb\r", " ", "c\n"]), "a\nb\n\nc");
  assert.equal(joinParts([]), "");
  assert.equal(joinParts(["x".repeat(MAX_ORIGINAL_TEXT + 5)]).length, MAX_ORIGINAL_TEXT);
});
