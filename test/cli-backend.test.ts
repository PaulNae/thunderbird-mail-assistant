import { test } from "node:test";
import assert from "node:assert/strict";
import { CliBackend } from "../extension/backend/cli-backend.ts";
import type { NativePort } from "../extension/backend/cli-backend.ts";
import { BackendError } from "../extension/backend/backend.ts";

class FakePort implements NativePort {
  sent: Record<string, unknown>[] = [];
  error: { message?: string } | null = null;
  private msgCbs: ((m: unknown) => void)[] = [];
  private discCbs: ((p: NativePort) => void)[] = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => void this.msgCbs.push(cb) };
  onDisconnect = { addListener: (cb: (p: NativePort) => void) => void this.discCbs.push(cb) };
  postMessage(m: unknown): void {
    this.sent.push(m as Record<string, unknown>);
  }
  disconnect(): void {}
  emit(m: unknown): void {
    this.msgCbs.forEach((cb) => cb(m));
  }
  drop(error?: string): void {
    if (error) this.error = { message: error };
    this.discCbs.forEach((cb) => cb(this));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const setup = () => {
  const ports: FakePort[] = [];
  const backend = new CliBackend(() => {
    const p = new FakePort();
    ports.push(p);
    return p;
  });
  return { ports, backend };
};
const collect = async (it: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
};

test("streams deltas in order and finishes on done", async () => {
  const { ports, backend } = setup();
  const it = backend.run({ system: "s", prompt: "p", model: "haiku", signal: new AbortController().signal });
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const c of it) seen.push(c);
  })();
  await tick();
  const port = ports[0] as FakePort;
  const req = port.sent[0] as Record<string, unknown>;
  assert.equal(req["type"], "run");
  assert.equal(req["system"], "s");
  assert.equal(req["model"], "haiku");
  port.emit({ id: req["id"], type: "delta", text: "He" });
  await tick();
  assert.deepEqual(seen, ["He"]);
  port.emit({ id: req["id"], type: "delta", text: "llo" });
  port.emit({ id: req["id"], type: "done" });
  await consumer;
  assert.deepEqual(seen, ["He", "llo"]);
});

test("error frame becomes BackendError with its code", async () => {
  const { ports, backend } = setup();
  const p = collect(backend.run({ system: "s", prompt: "p", signal: new AbortController().signal }));
  await tick();
  const port = ports[0] as FakePort;
  port.emit({ id: port.sent[0]?.["id"], type: "error", code: "not_logged_in", message: "x" });
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.code === "not_logged_in");
});

test("abort sends cancel and ends with cancelled", async () => {
  const { ports, backend } = setup();
  const ac = new AbortController();
  const p = collect(backend.run({ system: "s", prompt: "p", signal: ac.signal }));
  await tick();
  ac.abort();
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.code === "cancelled");
  const port = ports[0] as FakePort;
  assert.equal(port.sent[1]?.["type"], "cancel");
  assert.equal(port.sent[1]?.["id"], port.sent[0]?.["id"]);
});

test("disconnect with error gives host_not_found and next run reconnects", async () => {
  const { ports, backend } = setup();
  const p = collect(backend.run({ system: "s", prompt: "p", signal: new AbortController().signal }));
  await tick();
  (ports[0] as FakePort).drop("no such host");
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.code === "host_not_found");
  const p2 = collect(backend.run({ system: "s", prompt: "p", signal: new AbortController().signal }));
  await tick();
  assert.equal(ports.length, 2);
  const port = ports[1] as FakePort;
  port.emit({ id: port.sent[0]?.["id"], type: "delta", text: "ok" });
  port.emit({ id: port.sent[0]?.["id"], type: "done" });
  assert.deepEqual(await p2, ["ok"]);
});

test("connect throwing maps to host_not_found", async () => {
  const backend = new CliBackend(() => {
    throw new Error("boom");
  });
  await assert.rejects(
    collect(backend.run({ system: "s", prompt: "p", signal: new AbortController().signal })),
    (e: unknown) => e instanceof BackendError && e.code === "host_not_found",
  );
});

test("concurrent runs are routed by id", async () => {
  const { ports, backend } = setup();
  const a = collect(backend.run({ system: "s", prompt: "a", signal: new AbortController().signal }));
  const b = collect(backend.run({ system: "s", prompt: "b", signal: new AbortController().signal }));
  await tick();
  assert.equal(ports.length, 1);
  const port = ports[0] as FakePort;
  const idA = port.sent.find((m) => m["prompt"] === "a")?.["id"];
  const idB = port.sent.find((m) => m["prompt"] === "b")?.["id"];
  assert.notEqual(idA, idB);
  port.emit({ id: idB, type: "delta", text: "B" });
  port.emit({ id: idA, type: "delta", text: "A" });
  port.emit({ id: idA, type: "done" });
  port.emit({ id: idB, type: "done" });
  assert.deepEqual(await a, ["A"]);
  assert.deepEqual(await b, ["B"]);
});

test("check resolves from the check reply", async () => {
  const { ports, backend } = setup();
  const p = backend.check();
  await tick();
  const port = ports[0] as FakePort;
  assert.deepEqual(port.sent[0], { type: "check" });
  port.emit({ type: "check", ok: true, version: "2.1.0" });
  assert.deepEqual(await p, { ok: true, detail: "2.1.0" });
  const p2 = backend.check();
  await tick();
  port.emit({ type: "check", ok: false, code: "cli_not_found" });
  assert.deepEqual(await p2, { ok: false, detail: "cli_not_found" });
});

test("early break from the consumer sends cancel", async () => {
  const { ports, backend } = setup();
  const it = backend.run({ system: "s", prompt: "p", signal: new AbortController().signal });
  const consumer = (async () => {
    for await (const c of it) {
      void c;
      break;
    }
  })();
  await tick();
  const port = ports[0] as FakePort;
  const id = port.sent[0]?.["id"];
  port.emit({ id, type: "delta", text: "x" });
  await consumer;
  assert.deepEqual(port.sent[1], { id, type: "cancel" });
});

test("abort while connecting cancels without sending a run message", async () => {
  const port = new FakePort();
  let release: (p: NativePort) => void = () => {};
  const backend = new CliBackend(() => new Promise<NativePort>((r) => (release = r)));
  const ac = new AbortController();
  const p = collect(backend.run({ system: "s", prompt: "p", signal: ac.signal }));
  await tick();
  ac.abort();
  release(port);
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.code === "cancelled");
  assert.deepEqual(port.sent, []);
});

test("disconnect without error after messages were received gives internal", async () => {
  const { ports, backend } = setup();
  const p = collect(backend.run({ system: "s", prompt: "p", signal: new AbortController().signal }));
  await tick();
  const port = ports[0] as FakePort;
  port.emit({ id: port.sent[0]?.["id"], type: "delta", text: "x" });
  port.drop();
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.code === "internal");
});
