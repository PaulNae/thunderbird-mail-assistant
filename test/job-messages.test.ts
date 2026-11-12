import { test } from "node:test";
import assert from "node:assert/strict";
import { PORT_COMPOSE, PORT_DISPLAY, parsePortEvent, parsePortRequest, portName, sanitizeSnapshot } from "../extension/shared/job-messages.ts";

test("portName accepts only known names", () => {
  assert.equal(portName("display"), "display");
  assert.equal(portName("compose"), "compose");
  assert.equal(portName("x"), null);
  assert.equal(portName(undefined), null);
});

test("parsePortRequest validates open/start/cancel", () => {
  assert.deepEqual(parsePortRequest(PORT_DISPLAY, { type: "open", tabId: 3, messageId: 4 }), { type: "open", tabId: 3, messageId: 4 });
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "open", tabId: -1 }), null);
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "open", tabId: 1, messageId: "a" }), null);
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "start", kind: "question", system: "s", prompt: "p", messageId: 1, question: "  " }), null);
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "start", kind: "summary", system: "s", prompt: "p" }), null);
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "start", kind: "reply", system: "s", prompt: "p", messageId: 1 }), null);
  assert.deepEqual(parsePortRequest(PORT_COMPOSE, { type: "start", system: "s", prompt: "p", model: "sonnet", job: { type: "instruction_draft", instruction: "hi" } }), {
    type: "start",
    // A model sent by a page is dropped: the background script picks it from the settings.
    start: { kind: "instruction_draft", system: "s", prompt: "p", job: { type: "instruction_draft", instruction: "hi" } },
  });
  assert.equal(parsePortRequest(PORT_COMPOSE, { type: "start", system: "s", prompt: "p", job: { type: "compose", action: { kind: "tone", tone: "rude" } } }), null);
  assert.equal(parsePortRequest(PORT_COMPOSE, { type: "start", system: "s", prompt: "p" }), null);
  assert.deepEqual(parsePortRequest(PORT_DISPLAY, { type: "cancel" }), { type: "cancel" });
  assert.equal(parsePortRequest(PORT_DISPLAY, { type: "discard" }), null);
  assert.deepEqual(parsePortRequest(PORT_COMPOSE, { type: "applied" }), { type: "applied" });
  assert.equal(parsePortRequest(PORT_COMPOSE, "x"), null);
  assert.equal(parsePortRequest(PORT_COMPOSE, { type: "nope" }), null);
});

test("sanitizeSnapshot rejects malformed data and keeps valid data", () => {
  const ok = { phase: "done", text: "t", summary: "s", history: [{ question: "q", answer: "a" }], kind: "summary", messageId: 2 };
  assert.deepEqual(sanitizeSnapshot(ok), ok);
  assert.equal(sanitizeSnapshot({ ...ok, phase: "x" }), null);
  assert.equal(sanitizeSnapshot({ ...ok, history: [{ question: 1 }] }), null);
  assert.equal(sanitizeSnapshot({ ...ok, error: "weird" }), null);
  assert.equal(sanitizeSnapshot(null), null);
});

test("parsePortEvent", () => {
  assert.deepEqual(parsePortEvent({ type: "delta", text: "x" }), { type: "delta", text: "x" });
  assert.equal(parsePortEvent({ type: "delta", text: 1 }), null);
  assert.equal(parsePortEvent({ type: "snapshot", snapshot: {} }), null);
});
