import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_NOTES_CHARS, PendingReplyDrafts, isOwnSender, parseRuntimeRequest } from "../extension/shared/messages.ts";

test("parseRuntimeRequest accepts valid messages", () => {
  assert.deepEqual(parseRuntimeRequest({ type: "startReplyDraft", messageId: 5, notes: "hi" }), { type: "startReplyDraft", messageId: 5, notes: "hi" });
  assert.deepEqual(parseRuntimeRequest({ type: "startReplyDraft", messageId: 5 }), { type: "startReplyDraft", messageId: 5, notes: "" });
  assert.deepEqual(parseRuntimeRequest({ type: "takePendingReplyDraft", tabId: 0 }), { type: "takePendingReplyDraft", tabId: 0 });
});

test("parseRuntimeRequest rejects malformed or unknown messages", () => {
  for (const m of [null, undefined, "x", 3, [], {}, { type: "other" }, { type: "startReplyDraft", messageId: "5", notes: "" }, { type: "startReplyDraft", messageId: -1 }, { type: "startReplyDraft", messageId: 1.5 }, { type: "startReplyDraft", messageId: 1, notes: 4 }, { type: "takePendingReplyDraft" }, { type: "takePendingReplyDraft", tabId: NaN }]) {
    assert.equal(parseRuntimeRequest(m), null, JSON.stringify(m));
  }
});

test("parseRuntimeRequest caps notes length", () => {
  const r = parseRuntimeRequest({ type: "startReplyDraft", messageId: 1, notes: "x".repeat(MAX_NOTES_CHARS + 50) });
  assert.equal(r?.type === "startReplyDraft" && r.notes.length, MAX_NOTES_CHARS);
});

test("isOwnSender", () => {
  assert.equal(isOwnSender("a@b", "a@b"), true);
  assert.equal(isOwnSender("c@d", "a@b"), false);
  assert.equal(isOwnSender(undefined, "a@b"), false);
});

test("PendingReplyDrafts: take removes, expiry, per tab", () => {
  let now = 0;
  const store = new PendingReplyDrafts(1000, () => now);
  store.put(1, "a");
  store.put(2, "b");
  assert.deepEqual(store.take(1), { notes: "a" });
  assert.equal(store.take(1), null);
  now = 1000;
  assert.equal(store.take(2), null);
});
