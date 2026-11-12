import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERY_MAX_SCAN, pickNewest, scanLimit, selectResults } from "../extension/mail/search-select.ts";
import type { LoadedMessage } from "../extension/mail/types.ts";
import { TRUNCATION_MARKER } from "../extension/prompts/compose.ts";

test("pickNewest dedupes, sorts newest first and puts undated last", () => {
  const h = [
    { id: 1, date: new Date("2026-01-01") },
    { id: 2, date: new Date("2026-03-01") },
    { id: 3 },
    { id: 2, date: new Date("2026-03-01") },
    { id: 4, date: new Date("2026-02-01") },
    { id: 5, date: new Date("invalid") },
  ];
  assert.deepEqual(pickNewest(h, 10).map((x) => x.id), [2, 4, 1, 3, 5]);
  assert.deepEqual(pickNewest(h, 2).map((x) => x.id), [2, 4]);
  assert.deepEqual(pickNewest(h, 0), []);
});

test("scanLimit scans many headers, at least as many as may be sent", () => {
  assert.equal(scanLimit(15), QUERY_MAX_SCAN);
  assert.equal(scanLimit(QUERY_MAX_SCAN + 5), QUERY_MAX_SCAN + 5);
});

const m = (id: number, len: number): LoadedMessage => ({ id, from: "a", subject: "s", date: "", body: "x".repeat(len), attachments: [] });

test("selectResults keeps short mails unchanged", () => {
  const r = selectResults([m(1, 10), m(2, 20)], { maxMessageChars: 100, maxTotalChars: 1000 });
  assert.deepEqual(r.messages.map((x) => x.id), [1, 2]);
  assert.equal(r.truncated, false);
  assert.equal(r.omittedCount, 0);
});

test("selectResults cuts long mails and marks them", () => {
  const r = selectResults([m(1, 5000)], { maxMessageChars: 1000, maxTotalChars: 10000 });
  assert.equal(r.messages[0]!.body.length, 1000);
  assert.ok(r.messages[0]!.body.endsWith(TRUNCATION_MARKER));
  assert.equal(r.truncated, true);
});

test("selectResults enforces the total budget: one partial, the rest omitted", () => {
  const r = selectResults([m(1, 900), m(2, 900), m(3, 900), m(4, 10)], { maxMessageChars: 1000, maxTotalChars: 2500 });
  assert.deepEqual(r.messages.map((x) => x.id), [1, 2, 3]);
  assert.equal(r.messages[2]!.body.length, 700);
  assert.ok(r.messages[2]!.body.endsWith(TRUNCATION_MARKER));
  assert.equal(r.omittedCount, 1);
  assert.equal(r.truncated, true);
  const total = r.messages.reduce((s, x) => s + x.body.length, 0);
  assert.ok(total <= 2500);
});

test("selectResults omits instead of a tiny partial and keeps no gaps", () => {
  const r = selectResults([m(1, 900), m(2, 900), m(3, 10)], { maxMessageChars: 1000, maxTotalChars: 1200 });
  assert.deepEqual(r.messages.map((x) => x.id), [1]);
  assert.equal(r.omittedCount, 2);
  assert.equal(r.truncated, true);
});
