import { test } from "node:test";
import assert from "node:assert/strict";
import { appendHistory, canAsk, controls, initialState, isSubmitKey, reduce, threadNotice, uiLang } from "../extension/display/popup-state.ts";
import type { DisplayEvent } from "../extension/display/popup-state.ts";

const run = (events: DisplayEvent[]) => events.reduce(reduce, initialState());

test("loading -> idle or unavailable", () => {
  assert.equal(run([]).phase, "loading");
  assert.equal(run(["loaded"]).phase, "idle");
  assert.equal(run(["unavailable"]).phase, "unavailable");
  assert.equal(run(["prepare"]).phase, "loading");
});

test("happy path and double start guard", () => {
  assert.equal(run(["loaded", "prepare", "start"]).phase, "streaming");
  assert.equal(run(["loaded", "prepare", "start", "done"]).phase, "done");
  assert.equal(run(["loaded", "prepare", "prepare"]).phase, "preparing");
  assert.equal(run(["loaded", "prepare", "start", "prepare"]).phase, "streaming");
  assert.equal(run(["loaded", "prepare", "start"]).phase, "streaming");
});

test("cancel, failure, prepare_fail, restart", () => {
  assert.equal(run(["loaded", "prepare", "start", "cancel"]).phase, "idle");
  assert.equal(run(["loaded", "prepare", "start", "fail"]).phase, "error");
  assert.equal(run(["loaded", "prepare", "prepare_fail"]).phase, "idle");
  assert.equal(run(["loaded", "prepare", "start", "fail", "prepare"]).phase, "preparing");
  assert.equal(run(["loaded", "prepare", "start", "done", "prepare"]).phase, "preparing");
});

test("controls", () => {
  assert.deepEqual(controls(run([])), { summarizeEnabled: false, askEnabled: false, cancelVisible: false });
  assert.deepEqual(controls(run(["unavailable"])), { summarizeEnabled: false, askEnabled: false, cancelVisible: false });
  assert.deepEqual(controls(run(["loaded"])), { summarizeEnabled: true, askEnabled: true, cancelVisible: false });
  assert.deepEqual(controls(run(["loaded", "prepare", "start"])), { summarizeEnabled: false, askEnabled: false, cancelVisible: true });
  assert.equal(controls(run(["loaded", "prepare", "start", "done"])).askEnabled, true);
});

test("canAsk needs a ready state and a non-blank question", () => {
  const idle = run(["loaded"]);
  assert.equal(canAsk(idle, "  "), false);
  assert.equal(canAsk(idle, "Wann?"), true);
  assert.equal(canAsk(run(["loaded", "prepare", "start"]), "Wann?"), false);
});

test("history only grows on success", () => {
  const h = appendHistory([], " Q1 ", "A1", true);
  assert.deepEqual(h, [{ question: "Q1", answer: "A1" }]);
  assert.deepEqual(appendHistory(h, "Q2", "partial", false), h);
  assert.deepEqual(appendHistory(h, "Q2", "  ", true), h);
  assert.notEqual(appendHistory(h, "Q2", "x", false), h);
});

test("thread notice", () => {
  assert.equal(threadNotice({ truncated: false, omittedCount: 0 }), null);
  assert.deepEqual(threadNotice({ truncated: false, omittedCount: 3 }), { key: "displayOmitted", count: 3 });
  assert.deepEqual(threadNotice({ truncated: true, omittedCount: 0 }), { key: "displayShortened" });
  assert.deepEqual(threadNotice({ truncated: true, omittedCount: 2 }), { key: "displayOmittedShortened", count: 2 });
});

test("submit key and ui language", () => {
  assert.equal(isSubmitKey({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(isSubmitKey({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(isSubmitKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(uiLang("de-AT"), "de");
  assert.equal(uiLang("fr"), "en");
});
