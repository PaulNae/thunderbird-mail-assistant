// ApiBackend against a mocked fetch and against a local HTTP server that imitates the Messages API stream.
// No real key and no request to Anthropic: the fetch passed in redirects to the local server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  API_MODEL_IDS,
  API_VERSION,
  ApiBackend,
  MESSAGES_URL,
  MODELS_URL,
  SseParser,
  codeForApiError,
  interpretEvent,
  messagesBody,
} from "../extension/backend/api-backend.ts";
import type { FetchFn } from "../extension/backend/api-backend.ts";
import { BackendError } from "../extension/backend/backend.ts";
import type { BackendErrorCode } from "../extension/backend/backend.ts";

const KEY = "sk-ant-test-0123456789";

const sse = (events: [string, unknown][]): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const textStream = (...parts: string[]): string =>
  sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", content: [] } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["ping", { type: "ping" }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ...parts.map((text): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }]),
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
    ["message_stop", { type: "message_stop" }],
  ]);

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}
async function codeOf(p: Promise<unknown>): Promise<BackendErrorCode> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BackendError, String(e));
    return e.code;
  }
  assert.fail("expected an error");
}

/** A Response whose body is streamed in the given chunks. */
function streamResponse(chunks: string[], init: ResponseInit = { status: 200 }): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    init,
  );
}

const run = (b: ApiBackend, extra: Partial<Parameters<ApiBackend["run"]>[0]> = {}) =>
  b.run({ system: "SYS", prompt: "PROMPT", model: "haiku", signal: new AbortController().signal, ...extra });

test("the request goes only to the Messages API with the documented headers and no tools", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return streamResponse([textStream("Hallo", " Welt")]);
  };
  const b = new ApiBackend({ getKey: async () => KEY, fetch: fetchFn });
  assert.deepEqual(await collect(run(b)), ["Hallo", " Welt"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, MESSAGES_URL);
  assert.equal(MESSAGES_URL, "https://api.anthropic.com/v1/messages");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h["anthropic-version"], API_VERSION);
  assert.equal(h["authorization"], `Bearer ${KEY}`);
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "omit");
  const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
  assert.equal(body["model"], "claude-haiku-5-5");
  assert.equal(body["stream"], true);
  assert.equal(body["system"], "SYS");
  assert.deepEqual(body["messages"], [{ role: "user", content: "PROMPT" }]);
  assert.ok(!("tools" in body) && !("tool_choice" in body) && !("mcp_servers" in body));
});

test("model names of the settings map to API ids; unknown names are rejected", () => {
  assert.deepEqual({ ...API_MODEL_IDS }, { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
  assert.equal(messagesBody({ system: "", prompt: "", model: "opus" })["model"], "claude-opus-5-5");
  assert.equal(messagesBody({ system: "", prompt: "" })["model"], "claude-sonnet-5-5");
  assert.throws(() => messagesBody({ system: "", prompt: "", model: "gpt-4" }), (e: unknown) => e instanceof BackendError && e.code === "internal");
});

test("a missing key fails before any request", async () => {
  let called = false;
  const fetchFn: FetchFn = async () => {
    called = true;
    return new Response("");
  };
  for (const getKey of [async () => undefined, async () => "", async () => Promise.reject(new Error("x"))]) {
    const b = new ApiBackend({ getKey, fetch: fetchFn });
    assert.equal(await codeOf(collect(run(b))), "api_key_missing");
    assert.deepEqual(await b.check(), { ok: false, detail: "api_key_missing" });
  }
  assert.equal(called, false);
});

test("HTTP errors map to clear codes and never carry the key or the response text", async () => {
  const cases: [number, unknown, BackendErrorCode][] = [
    [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "api_key_invalid"],
    [403, { type: "error", error: { type: "permission_error", message: "no" } }, "api_key_invalid"],
    [402, { type: "error", error: { type: "billing_error", message: "pay" } }, "api_billing"],
    [400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API." } }, "api_billing"],
    [400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } }, "internal"],
    [429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "rate_limited"],
    [529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "overloaded"],
    [500, "not json", "internal"],
    [404, { type: "error", error: { type: "not_found_error", message: "model" } }, "internal"],
  ];
  for (const [status, body, code] of cases) {
    const b = new ApiBackend({ getKey: async () => KEY, fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }) });
    try {
      await collect(run(b));
      assert.fail("expected an error");
    } catch (e) {
      assert.ok(e instanceof BackendError);
      assert.equal(e.code, code, `status ${status}`);
      assert.ok(!e.message.includes(KEY) && !e.message.includes("slow") && !e.message.includes("credit"), e.message);
    }
  }
});

test("a network failure and an error event in the stream give their codes", async () => {
  const offline = new ApiBackend({ getKey: async () => KEY, fetch: async () => Promise.reject(new TypeError("NetworkError")) });
  assert.equal(await codeOf(collect(run(offline))), "network_error");
  assert.deepEqual(await offline.check(), { ok: false, detail: "network_error" });

  const overloaded = new ApiBackend({
    getKey: async () => KEY,
    fetch: async () => streamResponse([sse([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]])]),
  });
  assert.equal(await codeOf(collect(run(overloaded))), "overloaded");

  // Text before an error is delivered, then the error is thrown.
  const partial = new ApiBackend({
    getKey: async () => KEY,
    fetch: async () =>
      streamResponse([
        sse([["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Teil" } }]]),
        sse([["error", { type: "error", error: { type: "rate_limit_error", message: "x" } }]]),
      ]),
  });
  const got: string[] = [];
  const code = await codeOf(
    (async () => {
      for await (const c of run(partial)) got.push(c);
    })(),
  );
  assert.deepEqual(got, ["Teil"]);
  assert.equal(code, "rate_limited");

  // A stream that ends without message_stop is incomplete.
  const cut = new ApiBackend({ getKey: async () => KEY, fetch: async () => streamResponse([sse([["message_start", { type: "message_start" }]])]) });
  assert.equal(await codeOf(collect(run(cut))), "network_error");
});

test("the SSE parser handles split chunks, CRLF, comments and several events per chunk", () => {
  const p = new SseParser();
  const all = [
    ...p.push("event: content_block_delta\r\nda"),
    ...p.push('ta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\r\n\r\n: keep-alive\n\nevent: message_stop\ndata: {"type":"message_stop"}\n'),
    ...p.push("\n"),
  ];
  assert.equal(all.length, 2);
  assert.deepEqual(interpretEvent(all[0]!), { text: "a" });
  assert.deepEqual(interpretEvent(all[1]!), { done: true });
  assert.equal(interpretEvent({ event: "content_block_delta", data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}' }), null);
  assert.equal(interpretEvent({ event: "ping", data: '{"type":"ping"}' }), null);
  assert.deepEqual(interpretEvent({ event: "error", data: "garbage" }), { error: "internal" });
  assert.equal(codeForApiError(undefined, "overloaded_error"), "overloaded");
});

test("the connection test lists one model and sends no mail content", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = new ApiBackend({
    getKey: async () => KEY,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }] }), { status: 200 });
    },
  });
  assert.deepEqual(await ok.check(), { ok: true });
  assert.equal(calls[0]!.url, MODELS_URL);
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.body, undefined);
  const bad = new ApiBackend({ getKey: async () => KEY, fetch: async () => new Response("{}", { status: 401 }) });
  assert.deepEqual(await bad.check(), { ok: false, detail: "api_key_invalid" });
});

// Local server imitating the API: streams slowly so cancel and timeout can be tested over real HTTP.
async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, fn: (fetchFn: FetchFn, seen: { body: string; headers: IncomingMessage["headers"] }[]) => Promise<void>): Promise<void> {
  const seen: { body: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ body, headers: req.headers });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const fetchFn: FetchFn = (url, init) => fetch(url.replace("https://api.anthropic.com", `http://127.0.0.1:${port}`), init);
  try {
    await fn(fetchFn, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("streams over real HTTP from an imitated API", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const body = textStream("Eins", "Zwei", "Drei");
      // Arbitrary chunk boundaries.
      let i = 0;
      const tick = setInterval(() => {
        if (i >= body.length) {
          clearInterval(tick);
          res.end();
          return;
        }
        res.write(body.slice(i, i + 37));
        i += 37;
      }, 1);
    },
    async (fetchFn, seen) => {
      const b = new ApiBackend({ getKey: async () => KEY, fetch: fetchFn });
      assert.equal((await collect(run(b))).join(""), "EinsZweiDrei");
      assert.equal(seen[0]!.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(JSON.parse(seen[0]!.body).stream, true);
    },
  );
});

test("cancel and timeout stop a running stream over real HTTP", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anfang" } }]]));
      // Never finishes.
    },
    async (fetchFn) => {
      const b = new ApiBackend({ getKey: async () => KEY, fetch: fetchFn });
      const ac = new AbortController();
      const got: string[] = [];
      const code = await codeOf(
        (async () => {
          for await (const c of b.run({ system: "", prompt: "", model: "haiku", signal: ac.signal })) {
            got.push(c);
            ac.abort();
          }
        })(),
      );
      assert.deepEqual(got, ["Anfang"]);
      assert.equal(code, "cancelled");

      // Below the minimum the default applies, so test the timeout through a minimum-length run.
      const start = Date.now();
      const t = await codeOf(collect(b.run({ system: "", prompt: "", model: "haiku", timeoutMs: 10000, signal: new AbortController().signal })));
      assert.equal(t, "timeout");
      assert.ok(Date.now() - start >= 9900);
    },
  );
});

test("an already aborted signal sends nothing", async () => {
  let called = false;
  const b = new ApiBackend({
    getKey: async () => KEY,
    fetch: async () => {
      called = true;
      return new Response("");
    },
  });
  const ac = new AbortController();
  ac.abort();
  assert.equal(await codeOf(collect(run(b, { signal: ac.signal }))), "cancelled");
  assert.equal(called, false);
});
