import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the built content script (npm run check builds before testing) twice in one global,
// like repeated scripting.executeScript injections into the same frame.
const code = readFileSync(new URL("../dist/compose/editor.js", import.meta.url), "utf8");

function makeContext(): vm.Context {
  const range = {
    collapsed: true,
    setStart() {},
    collapse() {},
  };
  const selection = {
    rangeCount: 0,
    isCollapsed: true,
    removeAllRanges() {},
    addRange() {},
    getRangeAt: () => range,
    toString: () => "",
  };
  const document = {
    body: { children: [], childNodes: [], contains: () => true },
    querySelector: () => null,
    querySelectorAll: () => [],
    createRange: () => ({ ...range }),
  };
  const sandbox: Record<string, unknown> = { document, Node: { TEXT_NODE: 3 } };
  sandbox["window"] = { getSelection: () => selection };
  sandbox["globalThis"] = sandbox;
  return vm.createContext(sandbox);
}

// Results come from another realm; normalize prototypes before deep comparison.
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

interface Api {
  capture(isPlainText: boolean): unknown;
  apply(text: string): unknown;
}

test("editor bundle keeps its state when injected twice into the same global", () => {
  const ctx = makeContext();
  vm.runInContext(code, ctx);
  const first = vm.runInContext("globalThis.mailAssistantEditor", ctx) as Api;
  assert.ok(first);
  // No module state leaks as top-level bindings.
  assert.equal(vm.runInContext("typeof current", ctx), "undefined");

  assert.deepEqual(plain(first.capture(true)), { scope: "body", text: "" });

  vm.runInContext(code, ctx);
  const second = vm.runInContext("globalThis.mailAssistantEditor", ctx) as Api;
  assert.equal(second, first);
  assert.deepEqual(plain(second.apply("")), { ok: true });
});
