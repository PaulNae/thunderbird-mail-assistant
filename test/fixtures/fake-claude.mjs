#!/usr/bin/env node
// Fake `claude` CLI for host tests. The mode is the start of the system prompt, which the host
// passes as a file via --system-prompt-file, e.g. "mode:stream".
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const textDelta = (text) =>
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

if (argv[0] === "--version") {
  console.log("2.1.322 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth") {
  // Logged out when invoked through a symlink named "claude-out" (the host passes no custom env).
  const loggedIn = !String(process.argv[1]).endsWith("claude-out");
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}

const sysIdx = argv.indexOf("--system-prompt-file");
const system = sysIdx >= 0 ? readFileSync(argv[sysIdx + 1], "utf8") : "";
const mode = /^mode:(\w+)/.exec(system)?.[1] ?? "stream";

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) prompt += c;

if (argv.some((a) => a.includes(prompt) && prompt.length > 0)) {
  emit({ type: "result", is_error: true, result: "prompt leaked into argv", api_error_status: null });
  process.exit(1);
}

emit({ type: "system", subtype: "init" });
process.stdout.write("this is not json\n");

if (mode === "stream") {
  textDelta("Hallo ");
  textDelta("stdin:" + prompt);
  emit({ type: "assistant", message: { content: [{ type: "text", text: "x" }] }, error: null });
  emit({ type: "result", is_error: false, result: "ok", api_error_status: null });
} else if (mode === "args") {
  const shown = argv.filter((_, i) => i !== sysIdx + 1);
  textDelta(
    JSON.stringify({ argv: shown, cwdEntries: readdirSync(process.cwd()), envKeys: Object.keys(process.env).sort() }),
  );
  emit({ type: "result", is_error: false, result: "ok", api_error_status: null });
} else if (mode === "big") {
  textDelta("äö😀x\n".repeat(250000)); // ~1.7 MB in one delta
  emit({ type: "result", is_error: false, result: "ok", api_error_status: null });
} else if (mode === "sleep") {
  textDelta("pid:" + process.pid);
  await sleep(1e9);
} else if (mode === "notlogged") {
  emit({ type: "result", is_error: true, result: "Not logged in · Please run /login", api_error_status: null });
} else if (mode === "ratelimit") {
  emit({ type: "result", is_error: true, result: "boom", api_error_status: 429 });
} else if (mode === "noresult") {
  textDelta("partial");
  process.exit(3);
}
