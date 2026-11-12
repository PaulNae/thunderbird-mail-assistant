import { test } from "node:test";
import assert from "node:assert/strict";
import { isSearchable, searchHeaders } from "../extension/mail/search.ts";
import type { SearchApi, SearchHeader } from "../extension/mail/search.ts";

/** Each query gets its own list, served in the given pages. */
function fakeApi(listsByQuery: SearchHeader[][][]) {
  const lists = new Map<string, SearchHeader[][]>();
  const aborted: string[] = [];
  const queries: unknown[] = [];
  let n = 0;
  const api: SearchApi = {
    async query(info) {
      queries.push(info);
      const id = `L${n}`;
      lists.set(id, [...(listsByQuery[n++] ?? [])]);
      return id;
    },
    async continueList(id) {
      const pages = lists.get(id)!;
      const page = pages.shift() ?? [];
      return { id: pages.length > 0 ? id : null, messages: page };
    },
    async abortList(id) {
      aborted.push(id);
    },
  };
  return { api, aborted, queries };
}

const h = (id: number, extra: Partial<SearchHeader> = {}): SearchHeader => ({ id, date: new Date(2026, 0, id), ...extra });

test("reads all pages of a complete search and maps the fields", async () => {
  const f = fakeApi([[[h(1), h(2)], [h(3)]]]);
  const r = await searchHeaders([{ text: "Angebot", after: "2026-11-02" }], 10, new AbortController().signal, f.api);
  assert.deepEqual(r.headers.map((x) => x.id), [1, 2, 3]);
  assert.equal(r.complete, true);
  assert.deepEqual(f.aborted, []);
  const q = f.queries[0] as Record<string, unknown>;
  assert.equal(q["fullText"], "Angebot");
  assert.equal(q["returnMessageListId"], true);
  assert.ok(q["fromDate"] instanceof Date);
});

test("stops early at the limit, aborts the list and reports an incomplete search", async () => {
  const f = fakeApi([[[h(1), h(2)], [h(3), h(4)], [h(5)]]]);
  const r = await searchHeaders([{ text: "x" }], 3, new AbortController().signal, f.api);
  assert.deepEqual(r.headers.map((x) => x.id), [1, 2, 3]);
  assert.equal(r.complete, false);
  assert.deepEqual(f.aborted, ["L0"]);
});

test("the limit exactly at the end of the last page is complete", async () => {
  const f = fakeApi([[[h(1), h(2)]]]);
  const r = await searchHeaders([{ text: "x" }], 2, new AbortController().signal, f.api);
  assert.equal(r.complete, true);
  assert.deepEqual(f.aborted, []);
});

test("several queries are merged without duplicates; junk, trash and external mails are skipped", async () => {
  const f = fakeApi([
    [[h(1), h(2, { junk: true })]],
    [[h(1), h(3, { folder: { specialUse: ["trash"] } }), h(4, { external: true }), h(5, { folder: { specialUse: ["inbox"] } })]],
  ]);
  const r = await searchHeaders([{ text: "a" }, { text: "b" }], 10, new AbortController().signal, f.api);
  assert.deepEqual(r.headers.map((x) => x.id), [1, 5]);
  assert.equal(isSearchable(h(6, { folder: { specialUse: ["junk"] } })), false);
});

test("cancel while waiting for a page rejects with cancelled and aborts the list", async () => {
  const ctl = new AbortController();
  const aborted: string[] = [];
  const api: SearchApi = {
    query: async () => "L",
    continueList: () => new Promise(() => undefined),
    abortList: async (id) => void aborted.push(id),
  };
  const p = searchHeaders([{ text: "x" }], 10, ctl.signal, api);
  await new Promise((r) => setTimeout(r, 0));
  ctl.abort();
  await assert.rejects(p, (e: Error & { code?: string }) => e.code === "cancelled");
  assert.deepEqual(aborted, ["L"]);
});

test("cancel before the list id arrives still aborts the list later", async () => {
  const ctl = new AbortController();
  const aborted: string[] = [];
  let resolveId!: (id: string) => void;
  const api: SearchApi = {
    query: () => new Promise((r) => (resolveId = r)),
    continueList: async () => ({ id: null, messages: [] }),
    abortList: async (id) => void aborted.push(id),
  };
  const p = searchHeaders([{ text: "x" }], 10, ctl.signal, api);
  ctl.abort();
  await assert.rejects(p);
  resolveId("L");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(aborted, ["L"]);
});
