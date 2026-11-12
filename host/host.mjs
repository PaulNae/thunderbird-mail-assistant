#!/usr/bin/env node
// Native-messaging host: bridges the Thunderbird add-on to the local Claude Code CLI.
// stdout carries ONLY protocol frames. Diagnostics go to stderr and never contain
// prompt, system or model text.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LITTLE = os.endianness() === "LE";
export const MAX_FRAME_BYTES = 256 * 1024;
const MAX_INCOMING_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120000;
const CHECK_TIMEOUT_MS = 15000;
const MODEL_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------- framing

/** Encode one message: 4-byte length in native byte order + UTF-8 JSON. */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (LITTLE) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder; frames may be split across chunks or several per chunk. */
export class FrameDecoder {
  constructor(maxBytes = MAX_INCOMING_BYTES) {
    this.buffer = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  /** Returns an array of frame bodies (Buffers). Throws if a frame is oversized. */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    while (this.buffer.length >= 4) {
      const len = LITTLE ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (len > this.maxBytes) throw new Error("incoming frame too large");
      if (this.buffer.length < 4 + len) break;
      frames.push(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
    }
    return frames;
  }
}

/**
 * Split text on code points so that each `{id,type:"delta",text}` frame stays within maxBytes
 * of JSON. Never splits surrogate pairs.
 */
export function splitDelta(id, text, maxBytes = MAX_FRAME_BYTES) {
  const overhead = Buffer.byteLength(JSON.stringify({ id, type: "delta", text: "" }));
  const budget = Math.max(16, maxBytes - overhead);
  const parts = [];
  let current = "";
  let size = 0;
  for (const ch of text) {
    const cost = Buffer.byteLength(JSON.stringify(ch)) - 2;
    if (size + cost > budget && current) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += cost;
  }
  if (current) parts.push(current);
  return parts;
}

// ---------------------------------------------------------------- stream-json

function classifyResultError(obj, text) {
  if (obj.api_error_status === 429 || /rate limit|usage limit/i.test(text)) return "rate_limited";
  if (/not logged in|please run \/login/i.test(text)) return "not_logged_in";
  return "internal";
}

function classifyAssistantError(error) {
  if (error === "authentication_failed") return "not_logged_in";
  if (String(error).includes("rate_limit")) return "rate_limited";
  return "internal";
}

/**
 * Classify one stdout line of `claude --output-format stream-json`.
 * Returns {kind:"delta",text} | {kind:"assistant_error",code} | {kind:"result",ok,code?} |
 * {kind:"ignore"} | {kind:"invalid"}.
 */
export function classifyStreamLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: "invalid" };
  }
  if (!obj || typeof obj !== "object") return { kind: "invalid" };
  switch (obj.type) {
    case "stream_event": {
      const delta = obj.event?.type === "content_block_delta" ? obj.event.delta : null;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        return { kind: "delta", text: delta.text };
      }
      return { kind: "ignore" };
    }
    case "assistant":
      if (obj.error) return { kind: "assistant_error", code: classifyAssistantError(obj.error) };
      return { kind: "ignore" };
    case "result": {
      if (!obj.is_error) return { kind: "result", ok: true };
      const text = typeof obj.result === "string" ? obj.result : "";
      return { kind: "result", ok: false, code: classifyResultError(obj, text) };
    }
    default:
      return { kind: "ignore" };
  }
}

// ---------------------------------------------------------------- host

const ERROR_MESSAGES = {
  cli_not_found: "Claude CLI not found or not executable",
  not_logged_in: "Claude CLI is not logged in",
  rate_limited: "Rate or usage limit reached",
  timeout: "Claude CLI timed out",
  cancelled: "Run cancelled",
  internal: "Internal error",
};

/** Directories needed so that an npm-installed `#!/usr/bin/env node` claude can find node. */
function extraPathDirs(claudePath) {
  const dirs = [path.dirname(process.execPath)];
  if (claudePath) {
    try {
      dirs.push(path.dirname(realpathSync(claudePath)));
    } catch {
      // claude not resolvable; the spawn error is reported later
    }
  }
  return [...new Set(dirs)];
}

function buildChildEnv(claudePath) {
  let info = {};
  try {
    info = os.userInfo();
  } catch {
    // ignore, fall back to env only
  }
  const env = {
    HOME: process.env.HOME || info.homedir || os.homedir(),
    USER: process.env.USER || info.username || "",
    LOGNAME: process.env.LOGNAME || process.env.USER || info.username || "",
    PATH: [...extraPathDirs(claudePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
  };
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

export function startHost({ input = process.stdin, output = process.stdout, exit = process.exit } = {}) {
  const claudePath = process.env.MAIL_ASSISTANT_CLAUDE;
  const timeoutMs = Number(process.env.MAIL_ASSISTANT_TIMEOUT_MS) > 0
    ? Number(process.env.MAIL_ASSISTANT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const env = buildChildEnv(claudePath);
  // Empty working directory for the child; system prompt files live in a separate 0700 dir.
  const cwd = mkdtempSync(path.join(os.tmpdir(), "mail-assistant-"));
  const sysDir = mkdtempSync(path.join(os.tmpdir(), "mail-assistant-sys-"));
  /** @type {Map<string, {child: import("node:child_process").ChildProcess}>} */
  const runs = new Map();
  const children = new Set();
  const decoder = new FrameDecoder();

  const log = (msg) => process.stderr.write(`[host] ${msg}\n`);
  const send = (message, cb) => {
    try {
      output.write(encodeFrame(message), cb);
    } catch {
      log("write to stdout failed");
      cb?.();
    }
  };
  const sendError = (id, code, message, cb) => {
    const m = { type: "error", code, message: message ?? ERROR_MESSAGES[code] };
    if (id !== undefined) m.id = id;
    send(m, cb);
  };

  function killChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    t.unref();
  }

  function spawnClaude(args) {
    const child = spawn(claudePath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stderr.on("data", () => {}); // drain; content is never logged
    return child;
  }

  function handleRun(msg) {
    const id = msg.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return sendError(undefined, "internal", "Missing id");
    }
    if (runs.has(id)) return sendError(id, "internal", "Duplicate run id");
    if (typeof msg.system !== "string" || typeof msg.prompt !== "string") {
      return sendError(id, "internal", "Invalid run request");
    }
    if (msg.model !== undefined && msg.model !== null && msg.model !== "") {
      if (typeof msg.model !== "string" || !MODEL_RE.test(msg.model)) {
        return sendError(id, "internal", "Invalid model name");
      }
    }
    if (!claudePath) return sendError(id, "cli_not_found");

    // The system prompt may contain mail content: keep it out of argv (visible via ps).
    const sysFile = path.join(sysDir, `system-${randomUUID()}.txt`);
    const removeSysFile = () => rmSync(sysFile, { force: true });
    try {
      writeFileSync(sysFile, msg.system, { mode: 0o600, flag: "wx" });
    } catch {
      removeSysFile();
      return sendError(id, "internal", "Could not write system prompt file");
    }
    const args = [
      "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--tools", "", "--system-prompt-file", sysFile, "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--safe-mode",
    ];
    if (msg.model) args.push("--model", msg.model);

    let child;
    try {
      child = spawnClaude(args);
    } catch {
      removeSysFile();
      return sendError(id, "cli_not_found");
    }
    child.on("close", removeSysFile);
    child.on("error", removeSysFile);

    let finished = false;
    let assistantCode = null;
    let lineBuf = "";
    let ignoredLines = 0;
    const run = { child };
    runs.set(id, run);

    const timer = setTimeout(() => {
      if (finish("timeout")) killChild(child);
    }, timeoutMs);

    /** Sends the single terminal message. Returns false if one was already sent. */
    function finish(code, message) {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      runs.delete(id);
      if (code) sendError(id, code, message);
      else {
        send({ id, type: "done" });
        // The run is complete; make sure a lingering child does not outlive it.
        setTimeout(() => killChild(child), KILL_GRACE_MS).unref();
      }
      return true;
    }
    run.cancel = () => {
      if (finish("cancelled")) killChild(child);
    };

    const handleLine = (line) => {
      if (!line.trim() || finished) return;
      const ev = classifyStreamLine(line);
      if (ev.kind === "delta") {
        for (const text of splitDelta(id, ev.text)) send({ id, type: "delta", text });
      } else if (ev.kind === "assistant_error") {
        assistantCode = assistantCode ?? ev.code;
      } else if (ev.kind === "result") {
        if (ev.ok && !assistantCode) finish();
        else finish(assistantCode ?? ev.code);
      } else if (ev.kind === "invalid") {
        ignoredLines++;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    child.on("error", (err) => {
      const code = err.code === "ENOENT" || err.code === "EACCES" ? "cli_not_found" : "internal";
      log(`run ${id}: spawn error ${err.code ?? "unknown"}`);
      finish(code);
    });
    child.on("close", (exitCode, signal) => {
      if (lineBuf) handleLine(lineBuf);
      lineBuf = "";
      if (ignoredLines) log(`run ${id}: ${ignoredLines} non-JSON line(s) ignored`);
      log(`run ${id}: claude exited code=${exitCode} signal=${signal}`);
      if (!assistantCode && exitCode === 127) return void finish("cli_not_found");
      finish(assistantCode ?? "internal", assistantCode ? undefined : `claude exited without result (code ${exitCode ?? signal})`);
    });
    child.stdin.on("error", () => {}); // EPIPE if the child dies early
    child.stdin.end(msg.prompt);
  }

  /** Runs the CLI with args and a short timeout. Resolves {spawnFailed} or {code, stdout}. */
  function capture(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnClaude(args);
      } catch {
        return resolve({ spawnFailed: true });
      }
      let out = "";
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(r);
      };
      const t = setTimeout(() => {
        killChild(child);
        done({ code: null, stdout: out, timedOut: true });
      }, CHECK_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (out += c));
      child.stdin.on("error", () => {});
      child.stdin.end();
      child.on("error", () => done({ spawnFailed: true }));
      child.on("close", (code) => done({ code, stdout: out }));
    });
  }

  async function handleCheck() {
    const fail = (code, message) =>
      send({ type: "check", ok: false, code, message: message ?? ERROR_MESSAGES[code] });
    const failInternal = () => fail("internal");
    try {
      return await doCheck(fail);
    } catch {
      return failInternal();
    }
  }

  async function doCheck(fail) {
    if (!claudePath) return fail("cli_not_found");
    const ver = await capture(["--version"]);
    if (ver.spawnFailed) return fail("cli_not_found");
    const m = /\d+\.\d+\.\d+\S*/.exec(ver.stdout);
    if (ver.code !== 0 || !m) return fail("internal", "Could not determine CLI version");
    const version = m[0];
    const auth = await capture(["auth", "status"]);
    if (auth.spawnFailed) return fail("cli_not_found");
    let status;
    try {
      status = JSON.parse(auth.stdout);
    } catch {
      status = null;
    }
    if (status && status.loggedIn === true) return send({ type: "check", ok: true, version });
    if (status && status.loggedIn === false) return fail("not_logged_in");
    return fail("internal", "Could not determine login status");
  }

  function handleMessage(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return sendError(undefined, "internal", "Malformed JSON");
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return sendError(undefined, "internal", "Message must be an object");
    }
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : undefined;
    switch (msg.type) {
      case "run":
        return handleRun(msg);
      case "cancel":
        return runs.get(id)?.cancel();
      case "check":
        return void handleCheck();
      default:
        return sendError(id, "internal", "Unknown message type");
    }
  }

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sysDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    exit(0);
  }

  input.on("data", (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      return sendError(undefined, "internal", "Invalid frame", shutdown);
    }
    for (const f of frames) handleMessage(f);
  });
  input.on("end", shutdown);
  input.on("close", shutdown);
  input.on("error", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { shutdown };
}

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) startHost();
