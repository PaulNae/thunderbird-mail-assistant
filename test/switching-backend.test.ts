import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendError } from "../extension/backend/backend.ts";
import type { Backend, BackendKind, RunRequest } from "../extension/backend/backend.ts";
import { SwitchingBackend, cliSupported } from "../extension/background/switching-backend.ts";

class Fake implements Backend {
  runs = 0;
  checks = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async *run(): AsyncGenerator<string, void, undefined> {
    this.runs++;
    yield this.name;
  }
  async check(): Promise<{ ok: boolean; detail?: string }> {
    this.checks++;
    return { ok: true, detail: this.name };
  }
}

const req = (): RunRequest => ({ system: "", prompt: "", signal: new AbortController().signal });
async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test("each run and check uses the backend chosen at that moment", async () => {
  const api = new Fake("api");
  const cli = new Fake("cli");
  let choice: BackendKind = "api";
  const b = new SwitchingBackend({ backends: { api, cli }, choice: async () => choice, os: async () => "mac" });
  assert.deepEqual(await collect(b.run(req())), ["api"]);
  choice = "cli";
  assert.deepEqual(await collect(b.run(req())), ["cli"]);
  assert.deepEqual(await b.check(), { ok: true, detail: "cli" });
  assert.deepEqual(await b.current(), { kind: "cli", supported: true });
  assert.equal(api.runs, 1);
  assert.equal(cli.runs, 1);
});

test("the CLI backend is refused outside macOS without touching it; the API works everywhere", async () => {
  assert.equal(cliSupported("mac"), true);
  for (const os of ["win", "linux", "openbsd", ""]) assert.equal(cliSupported(os), false);
  const api = new Fake("api");
  const cli = new Fake("cli");
  let choice: BackendKind = "cli";
  const b = new SwitchingBackend({ backends: { api, cli }, choice: async () => choice, os: async () => "win" });
  await assert.rejects(collect(b.run(req())), (e: unknown) => e instanceof BackendError && e.code === "cli_unsupported");
  assert.deepEqual(await b.check(), { ok: false, detail: "cli_unsupported" });
  assert.equal(cli.runs + cli.checks, 0);
  choice = "api";
  assert.deepEqual(await collect(b.run(req())), ["api"]);
  // An unknown platform counts as unsupported.
  const failing = new SwitchingBackend({ backends: { api, cli }, choice: async () => "cli", os: async () => Promise.reject(new Error("x")) });
  assert.deepEqual(await failing.current(), { kind: "cli", supported: false });
});
