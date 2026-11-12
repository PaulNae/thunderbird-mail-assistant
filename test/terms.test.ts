import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TERMS_CHECKED_ON, TERMS_URL, formatTermsDate } from "../extension/shared/terms.ts";

test("the terms check date is one constant, shown per language", () => {
  assert.match(TERMS_CHECKED_ON, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatTermsDate("de"), "12.11.2026");
  assert.equal(formatTermsDate("en-US"), "Nov 12, 2026");
  assert.equal(TERMS_URL, "https://code.claude.com/docs/en/legal-and-compliance");
});

test("the README states the same check date and links the terms", () => {
  const readme = readFileSync(path.resolve(import.meta.dirname, "..", "README.md"), "utf8");
  assert.ok(readme.includes(TERMS_CHECKED_ON), "README misses the check date");
  assert.ok(readme.includes(TERMS_URL), "README misses the terms link");
});

test("the guide and the README point to GitHub issues for bugs and feature requests", async () => {
  const { ISSUES_URL } = await import("../extension/shared/terms.ts");
  assert.equal(ISSUES_URL, "https://github.com/PaulNae/thunderbird-mail-assistant/issues");
  const root = path.resolve(import.meta.dirname, "..");
  assert.ok(readFileSync(path.join(root, "README.md"), "utf8").includes(ISSUES_URL));
  assert.match(readFileSync(path.join(root, "extension", "guide", "guide.html"), "utf8"), /<section id="feedback"/);
});
