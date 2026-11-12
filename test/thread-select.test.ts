import { test } from "node:test";
import assert from "node:assert/strict";
import { selectThread, parseMessageIds, MIN_PARTIAL_CHARS } from "../extension/mail/thread-select.ts";
import type { ThreadLimits } from "../extension/mail/thread-select.ts";

const msg = (id: number, day: number, len: number) => ({
  id,
  from: "a@x",
  subject: "s",
  date: day ? new Date(Date.UTC(2026, 0, day)).toISOString() : "",
  body: "x".repeat(len),
  attachments: [],
});
const limits = (o: Partial<ThreadLimits> = {}): ThreadLimits => ({
  maxMessages: 6,
  maxChars: 1000,
  maxMessageChars: 800,
  ...o,
});

test("sorts chronologically and marks the displayed mail", () => {
  const t = selectThread(2, [msg(2, 2, 10), msg(3, 3, 10), msg(1, 1, 10)], limits());
  assert.deepEqual(t.messages.map((m) => [m.id, m.current]), [[1, false], [2, true], [3, false]]);
  assert.equal(t.truncated, false);
  assert.equal(t.omittedCount, 0);
});

test("drops the oldest messages beyond the message limit", () => {
  const t = selectThread(4, [msg(1, 1, 5), msg(2, 2, 5), msg(3, 3, 5), msg(4, 4, 5)], limits({ maxMessages: 2 }));
  assert.deepEqual(t.messages.map((m) => m.id), [3, 4]);
  assert.equal(t.omittedCount, 2);
  assert.equal(t.truncated, true);
});

test("displayed mail wins over the budget; older ones are shortened or omitted", () => {
  const t = selectThread(3, [msg(1, 1, 600), msg(2, 2, 600), msg(3, 3, 450)], limits());
  assert.deepEqual(t.messages.map((m) => [m.id, m.body.length]), [[2, 550], [3, 450]]);
  assert.equal(t.omittedCount, 1);
  assert.equal(t.truncated, true);
});

test("omits an older message when less than the minimum is left", () => {
  const t = selectThread(2, [msg(1, 1, 600), msg(2, 2, 1000 - MIN_PARTIAL_CHARS + 1)], limits({ maxMessageChars: 1000 }));
  assert.deepEqual(t.messages.map((m) => m.id), [2]);
  assert.equal(t.omittedCount, 1);
});

test("cuts a single over-long message and flags it", () => {
  const t = selectThread(1, [msg(1, 1, 900)], limits());
  assert.equal(t.messages[0]!.body.length, 800);
  assert.equal(t.truncated, true);
  assert.equal(t.omittedCount, 0);
});

test("ignores duplicates, tolerates missing dates, requires the displayed mail", () => {
  const t = selectThread(1, [msg(1, 0, 5), msg(1, 0, 5), msg(2, 0, 5)], limits());
  assert.equal(t.messages.length, 2);
  assert.throws(() => selectThread(9, [msg(1, 1, 5)], limits()));
});

test("parseMessageIds extracts ids without brackets", () => {
  assert.deepEqual(parseMessageIds(["<a@x> <b@y>\n <c@z>", "<a@x>"]), ["a@x", "b@y", "c@z", "a@x"]);
  assert.deepEqual(parseMessageIds(["no ids"]), []);
});
