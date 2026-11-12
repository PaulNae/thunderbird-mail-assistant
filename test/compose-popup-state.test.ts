import { test } from "node:test";
import assert from "node:assert/strict";
import { controls, describeScope, initialState, reduce, resolveAction, resolveInstructionJob, scopeEvent, startEvent } from "../extension/compose/popup-state.ts";
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
  assert.deepEqual(controls(s), { actionsEnabled: true, replyEnabled: true, instructionEnabled: true, instructionCreatesDraft: false, cancelVisible: false, previewVisible: false, previewButtonsVisible: false });
  const st = reduce(s, "start");
  assert.deepEqual(controls(st), { actionsEnabled: false, replyEnabled: false, instructionEnabled: false, instructionCreatesDraft: false, cancelVisible: true, previewVisible: true, previewButtonsVisible: false });
  const pv = reduce(st, "done");
  assert.deepEqual(controls(pv), { actionsEnabled: false, replyEnabled: false, instructionEnabled: false, instructionCreatesDraft: false, cancelVisible: false, previewVisible: true, previewButtonsVisible: true });
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
  assert.deepEqual(describeScope({ scope: "selection", text: "abcd" }), { key: "composeScopeSelection", count: 4, usable: true, replyUsable: true });
  assert.deepEqual(describeScope({ scope: "body", text: "abc" }), { key: "composeScopeBody", usable: true, replyUsable: true });
  assert.deepEqual(describeScope({ error: "protected" }), { key: "composeProtected", usable: false, replyUsable: false });
  assert.deepEqual(describeScope({ error: "empty" }), { key: "composeEmpty", usable: false, replyUsable: false });
});

test("empty own text: rewrite actions stay blocked, reply draft is allowed", () => {
  const info = describeScope({ scope: "body", text: "" });
  assert.deepEqual(info, { key: "composeScopeInsert", usable: false, replyUsable: true });
  assert.equal(scopeEvent(info), "scope_reply_only");
  const s = run(["scope_reply_only"]);
  assert.equal(controls(s).actionsEnabled, false);
  assert.equal(controls(s).replyEnabled, true);
  assert.equal(reduce(s, "start").phase, "idle");
  assert.equal(reduce(s, "start_reply").phase, "streaming");
  assert.equal(describeScope({ scope: "body", text: " \u00a0\n" }).usable, false);
});

test("reply job goes through the same phases and can be repeated", () => {
  const s = run(["scope_ok", "start_reply", "done"]);
  assert.equal(s.phase, "preview");
  assert.equal(reduce(reduce(s, "discard"), "start_reply").phase, "streaming");
  assert.equal(run(["start_reply"]).phase, "idle");
  assert.equal(run(["scope_unusable", "start_reply"]).phase, "idle");
  assert.equal(run(["scope_ok", "start_reply", "start_reply"]).phase, "streaming");
  assert.equal(run(["scope_ok", "start_reply", "fail", "start_reply"]).phase, "streaming");
});

test("scopeEvent and startEvent", () => {
  assert.equal(scopeEvent(describeScope({ scope: "body", text: "abc" })), "scope_ok");
  assert.equal(scopeEvent(describeScope({ error: "protected" })), "scope_unusable");
  assert.equal(startEvent({ type: "reply", notes: "" }), "start_reply");
  assert.equal(startEvent({ type: "compose", action: { kind: "rephrase" } }), "start");
});

test("preparing blocks a second start until the first one resolves", () => {
  const prep = run(["scope_ok", "prepare"]);
  assert.equal(prep.phase, "preparing");
  assert.equal(reduce(prep, "prepare").phase, "preparing");
  const c = controls(prep);
  assert.equal(c.actionsEnabled, false);
  assert.equal(c.replyEnabled, false);
  assert.equal(c.cancelVisible, false);
  assert.equal(reduce(prep, "start").phase, "streaming");
  assert.equal(reduce(prep, "start_reply").phase, "streaming");
  assert.equal(reduce(prep, "prepare_fail").phase, "idle");
  assert.equal(run(["scope_ok", "start", "prepare"]).phase, "streaming");
  assert.equal(run(["scope_ok", "start", "prepare_fail"]).phase, "streaming");
  assert.equal(run(["scope_ok", "prepare", "scope_unusable", "start"]).phase, "preparing");
  assert.equal(run(["scope_ok", "start", "fail", "prepare"]).phase, "preparing");
});

test("empty text: rewrite buttons off, instruction field on and creates a draft", () => {
  const s = run(["scope_reply_only"]);
  const c = controls(s);
  assert.equal(c.actionsEnabled, false);
  assert.equal(c.instructionEnabled, true);
  assert.equal(c.instructionCreatesDraft, true);
  const full = controls(run(["scope_ok"]));
  assert.equal(full.instructionEnabled, true);
  assert.equal(full.instructionCreatesDraft, false);
  assert.equal(controls(run(["scope_unusable"])).instructionEnabled, false);
  assert.equal(controls(run(["scope_reply_only", "start_reply"])).instructionEnabled, false);
});

test("resolveInstructionJob picks the job by scope", () => {
  assert.deepEqual(resolveInstructionJob(run(["scope_reply_only"]), " Write hi "), { type: "instruction_draft", instruction: "Write hi" });
  assert.deepEqual(resolveInstructionJob(run(["scope_ok"]), "Shorter"), { type: "compose", action: { kind: "custom", instruction: "Shorter" } });
  assert.equal(resolveInstructionJob(run(["scope_reply_only"]), "  "), null);
  assert.equal(resolveInstructionJob(run(["scope_unusable"]), "x"), null);
});

test("instruction draft uses the draft path and can be regenerated", () => {
  const job = { type: "instruction_draft", instruction: "x" } as const;
  assert.equal(startEvent(job), "start_reply");
  const s = run(["scope_reply_only", "start_reply", "done"]);
  assert.equal(s.phase, "preview");
  assert.equal(reduce(reduce(s, "discard"), startEvent(job)).phase, "streaming");
});
