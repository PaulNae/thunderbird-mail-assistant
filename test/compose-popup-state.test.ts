import { test } from "node:test";
import assert from "node:assert/strict";
import { controls, describeScope, initialState, reduce, resolveAction } from "../extension/compose/popup-state.ts";
import type { PopupEvent } from "../extension/compose/popup-state.ts";

const run = (events: PopupEvent[]) => events.reduce(reduce, initialState());

test("cannot start without a usable scope", () => {
  assert.equal(run(["start"]).phase, "idle");
  assert.equal(run(["scope_unusable", "start"]).phase, "idle");
});

test("happy path idle -> streaming -> preview -> idle", () => {
  assert.equal(run(["scope_ok", "start"]).phase, "streaming");
  assert.equal(run(["scope_ok", "start", "done"]).phase, "preview");
  assert.equal(run(["scope_ok", "start", "done", "discard"]).phase, "idle");
});

test("cancel and failure", () => {
  assert.equal(run(["scope_ok", "start", "cancel"]).phase, "idle");
  assert.equal(run(["scope_ok", "start", "fail"]).phase, "error");
  assert.equal(run(["scope_ok", "start", "fail", "start"]).phase, "streaming");
});

test("controls per phase", () => {
  const s = run(["scope_ok"]);
  assert.deepEqual(controls(s), { actionsEnabled: true, cancelVisible: false, previewVisible: false, previewButtonsVisible: false });
  const st = reduce(s, "start");
  assert.deepEqual(controls(st), { actionsEnabled: false, cancelVisible: true, previewVisible: true, previewButtonsVisible: false });
  const pv = reduce(st, "done");
  assert.deepEqual(controls(pv), { actionsEnabled: false, cancelVisible: false, previewVisible: true, previewButtonsVisible: true });
  assert.equal(controls(run(["scope_unusable"])).actionsEnabled, false);
});

test("resolveAction", () => {
  assert.deepEqual(resolveAction("rephrase"), { kind: "rephrase" });
  assert.deepEqual(resolveAction("shorten"), { kind: "shorten" });
  assert.deepEqual(resolveAction("tone:formal"), { kind: "tone", tone: "formal" });
  assert.deepEqual(resolveAction("translate:en"), { kind: "translate", lang: "en" });
  assert.deepEqual(resolveAction("custom", "  make it rhyme "), { kind: "custom", instruction: "make it rhyme" });
  assert.equal(resolveAction("custom", "   "), null);
  assert.equal(resolveAction("tone:angry"), null);
  assert.equal(resolveAction("translate:fr"), null);
  assert.equal(resolveAction("rephrase:x"), null);
  assert.equal(resolveAction("bogus"), null);
});

test("describeScope", () => {
  assert.deepEqual(describeScope({ scope: "selection", text: "abcd" }), { key: "composeScopeSelection", count: 4, usable: true });
  assert.deepEqual(describeScope({ scope: "body", text: "abc" }), { key: "composeScopeBody", usable: true });
  assert.deepEqual(describeScope({ error: "protected" }), { key: "composeProtected", usable: false });
  assert.deepEqual(describeScope({ error: "empty" }), { key: "composeEmpty", usable: false });
});
