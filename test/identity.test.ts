import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAddress, pickIdentity } from "../extension/mail/identity.ts";

const ids = [
  { id: "id1", email: "main@example.org" },
  { id: "id2", email: "Work@Example.com" },
];

test("extractAddress handles common forms", () => {
  assert.equal(extractAddress("Name <A@B.c>"), "a@b.c");
  assert.equal(extractAddress('"Doe, Jane" <j@x.y>'), "j@x.y");
  assert.equal(extractAddress("<a@b>"), "a@b");
  assert.equal(extractAddress("  A@B  "), "a@b");
});

test("pickIdentity matches case-insensitively and in recipient order", () => {
  assert.equal(pickIdentity(["Me <work@example.com>"], ids, "id1"), "id2");
  assert.equal(pickIdentity(["x@y.z", "main@example.org", "work@example.com"], ids, "id2"), "id1");
});

test("pickIdentity falls back to the default, then to undefined", () => {
  assert.equal(pickIdentity(["x@y.z"], ids, "id1"), "id1");
  assert.equal(pickIdentity(["x@y.z"], ids), undefined);
  assert.equal(pickIdentity([], [], undefined), undefined);
  assert.equal(pickIdentity(["a@b"], [], "id9"), "id9");
});

test("pickIdentity ignores identities without id or email", () => {
  assert.equal(pickIdentity(["a@b"], [{ email: "a@b" }, { id: "i" }], undefined), undefined);
});
