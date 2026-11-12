import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const hostPath = path.join(root, "host", "host.mjs");
const fakeClaude = path.join(root, "test", "fixtures", "fake-claude.mjs");
const LE = os.endianness() === "LE";

// The host puts node's directory on the child's PATH, so the fake's `#!/usr/bin/env node` works.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "host-test-"));
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));
function launcher(loggedIn: boolean): string {
  const file = path.join(tmpDir, loggedIn ? "claude-in" : "claude-out");
  symlinkSync(fakeClaude, file);
  return file;
}
const defaultClaude = launcher(true);

type Msg = Record<string, unknown> & { type: string; id?: string };

function frame(msg: unknown): Buffer {
  const body = Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  if (LE) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

class HostProc {
  proc: ChildProcess;
  messages: Msg[] = [];
  frameSizes: number[] = [];
  stderr = "";
  exited: Promise<number | null>;
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];

  constructor(env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [hostPath], {
      env: { ...process.env, MAIL_ASSISTANT_CLAUDE: defaultClaude, ANTHROPIC_API_KEY: "dummy", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (c: string) => (this.stderr += c));
    this.proc.stdout!.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      while (this.buf.length >= 4) {
        const len = LE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
        if (this.buf.length < 4 + len) break;
        this.frameSizes.push(len);
        this.messages.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")) as Msg);
        this.buf = this.buf.subarray(4 + len);
      }
      this.waiters.splice(0).forEach((w) => w());
    });
    this.exited = new Promise((resolve) => this.proc.on("exit", (code) => resolve(code)));
  }

  write(data: Buffer): void {
    this.proc.stdin!.write(data);
  }
  send(msg: unknown): void {
    this.write(frame(msg));
  }

  async waitFor(pred: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout waiting for host message");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
  terminal(id: string): Promise<Msg> {
    return this.waitFor((m) => m.id === id && (m.type === "done" || m.type === "error"));
  }
  forId(id: string): Msg[] {
    return this.messages.filter((m) => m.id === id);
  }
  async close(): Promise<void> {
    this.proc.stdin!.end();
    await this.exited;
  }
}

const run = (id: string, system: string, prompt = "PROMPT-Q9") => ({ id, type: "run", system, prompt });

test("streams deltas then done; prompt arrives via stdin", async () => {
  const h = new HostProc();
  h.send(run("a", "mode:stream", "SECRET-PROMPT-123"));
  const end = await h.terminal("a");
  assert.equal(end.type, "done");
  const text = h.forId("a").filter((m) => m.type === "delta").map((m) => m["text"]).join("");
  assert.equal(text, "Hallo stdin:SECRET-PROMPT-123");
  assert.ok(h.forId("a").filter((m) => m.type === "delta").length >= 2);
  assert.equal(h.forId("a").filter((m) => m.type === "done" || m.type === "error").length, 1);
  await h.close();
  assert.ok(!h.stderr.includes("SECRET-PROMPT-123") && !h.stderr.includes("mode:stream"));
});

test("two frames in one write and one frame split across writes", async () => {
  const h = new HostProc();
  h.write(Buffer.concat([frame(run("one", "mode:stream", "AAA7")), frame(run("two", "mode:stream", "BBB7"))]));
  assert.equal((await h.terminal("one")).type, "done");
  assert.equal((await h.terminal("two")).type, "done");

  const split = frame(run("three", "mode:stream", "CCC7"));
  h.write(split.subarray(0, 2));
  await new Promise((r) => setTimeout(r, 30));
  h.write(split.subarray(2, 9));
  await new Promise((r) => setTimeout(r, 30));
  h.write(split.subarray(9));
  assert.equal((await h.terminal("three")).type, "done");
  await h.close();
});

test("large delta is split into frames below the limit and reassembles exactly", async () => {
  const h = new HostProc();
  h.send(run("big", "mode:big"));
  assert.equal((await h.terminal("big")).type, "done");
  const deltas = h.forId("big").filter((m) => m.type === "delta");
  assert.ok(deltas.length > 1);
  assert.ok(Math.max(...h.frameSizes) <= 256 * 1024, `max frame ${Math.max(...h.frameSizes)}`);
  const text = deltas.map((m) => m["text"]).join("");
  assert.equal(text, "äö😀x\n".repeat(250000));
  assert.ok(!text.includes("�"));
  await h.close();
});

test("cancel kills the child and reports cancelled", async () => {
  const h = new HostProc();
  h.send(run("c", "mode:sleep"));
  const pidMsg = await h.waitFor((m) => m.id === "c" && m.type === "delta");
  const pid = Number(String(pidMsg["text"]).replace("pid:", ""));
  assert.ok(pid > 0);
  h.send({ id: "c", type: "cancel" });
  const end = await h.terminal("c");
  assert.equal(end.type, "error");
  assert.equal(end["code"], "cancelled");
  const deadline = Date.now() + 4000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "child still running");
  h.send({ id: "unknown", type: "cancel" }); // ignored
  await h.close();
});

test("duplicate active id yields internal error", async () => {
  const h = new HostProc();
  h.send(run("d", "mode:sleep"));
  await h.waitFor((m) => m.id === "d" && m.type === "delta");
  h.send(run("d", "mode:stream"));
  const err = await h.waitFor((m) => m.id === "d" && m.type === "error");
  assert.equal(err["code"], "internal");
  await h.close();
});

test("timeout kills the child and reports timeout", async () => {
  const h = new HostProc({ MAIL_ASSISTANT_TIMEOUT_MS: "300" });
  h.send(run("t", "mode:sleep"));
  const pidMsg = await h.waitFor((m) => m.id === "t" && m.type === "delta");
  const pid = Number(String(pidMsg["text"]).replace("pid:", ""));
  const end = await h.terminal("t");
  assert.equal(end["code"], "timeout");
  const deadline = Date.now() + 4000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "child still running after timeout");
  await h.close();
});

test("maps CLI failures to error codes", async () => {
  const h = new HostProc();
  h.send(run("nl", "mode:notlogged"));
  h.send(run("rl", "mode:ratelimit"));
  h.send(run("nr", "mode:noresult"));
  assert.equal((await h.terminal("nl"))["code"], "not_logged_in");
  assert.equal((await h.terminal("rl"))["code"], "rate_limited");
  const nr = await h.terminal("nr");
  assert.equal(nr["code"], "internal");
  assert.ok(String(nr["message"]).includes("3"));
  await h.close();
});

test("invalid model name is rejected", async () => {
  const h = new HostProc();
  h.send({ ...run("m", "mode:stream"), model: "x; rm -rf" });
  assert.equal((await h.terminal("m"))["code"], "internal");
  await h.close();
});

test("missing claude binary yields cli_not_found", async () => {
  const h = new HostProc({ MAIL_ASSISTANT_CLAUDE: "/nonexistent/claude" });
  h.send(run("x", "mode:stream"));
  assert.equal((await h.terminal("x"))["code"], "cli_not_found");
  h.send({ type: "check" });
  const chk = await h.waitFor((m) => m.type === "check");
  assert.equal(chk["ok"], false);
  assert.equal(chk["code"], "cli_not_found");
  await h.close();
});

test("malformed JSON and unknown type give internal errors without crashing", async () => {
  const h = new HostProc();
  h.write(frame("{not json"));
  h.send({ id: "u", type: "bogus" });
  const e1 = await h.waitFor((m) => m.type === "error" && m.id === undefined);
  assert.equal(e1["code"], "internal");
  const e2 = await h.waitFor((m) => m.type === "error" && m.id === "u");
  assert.equal(e2["code"], "internal");
  h.send(run("after", "mode:stream"));
  assert.equal((await h.terminal("after")).type, "done");
  await h.close();
});

test("check reports ok with version, or not_logged_in", async () => {
  const ok = new HostProc();
  ok.send({ type: "check" });
  const r1 = await ok.waitFor((m) => m.type === "check");
  assert.equal(r1["ok"], true);
  assert.equal(r1["version"], "2.1.322");
  await ok.close();

  const out = new HostProc({ MAIL_ASSISTANT_CLAUDE: launcher(false) });
  out.send({ type: "check" });
  const r2 = await out.waitFor((m) => m.type === "check");
  assert.equal(r2["ok"], false);
  assert.equal(r2["code"], "not_logged_in");
  await out.close();
});

test("host exits and kills children when stdin closes", async () => {
  const h = new HostProc();
  h.send(run("s", "mode:sleep"));
  const pidMsg = await h.waitFor((m) => m.id === "s" && m.type === "delta");
  const pid = Number(String(pidMsg["text"]).replace("pid:", ""));
  h.proc.stdin!.end();
  assert.equal(await h.exited, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0));
});

test("child gets hardened args, empty cwd, minimal env; nothing sensitive in argv or stderr", async () => {
  const SYS = "mode:args SYSTEM-TEXT-7731";
  const PROMPT = "PROMPT-TEXT-4409";
  const h = new HostProc();
  h.send(run("args", SYS, PROMPT));
  assert.equal((await h.terminal("args")).type, "done");
  const text = h.forId("args").filter((m) => m.type === "delta").map((m) => m["text"]).join("");
  const info = JSON.parse(text) as { argv: string[]; cwdEntries: string[]; envKeys: string[] };
  const { argv } = info;
  const at = (flag: string): number => argv.indexOf(flag);
  assert.ok(at("--tools") >= 0 && argv[at("--tools") + 1] === "", "--tools with empty value");
  assert.ok(at("--setting-sources") >= 0 && argv[at("--setting-sources") + 1] === "");
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--safe-mode", "--system-prompt-file"]) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.ok(!argv.includes("--system-prompt"));
  assert.ok(!argv.some((a) => a.includes("SYSTEM-TEXT-7731") || a.includes(PROMPT)));
  assert.deepEqual(info.cwdEntries, []);
  // __CF_USER_TEXT_ENCODING is added by macOS itself to every spawned process.
  const allowed = new Set(["HOME", "USER", "LOGNAME", "PATH", "LANG", "__CF_USER_TEXT_ENCODING"]);
  assert.ok(info.envKeys.every((k) => allowed.has(k)), `env keys: ${info.envKeys.join(",")}`);
  await h.close();
  assert.ok(!h.stderr.includes("SYSTEM-TEXT-7731") && !h.stderr.includes(PROMPT));
});
