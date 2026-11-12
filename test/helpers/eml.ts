// Minimal reader for the test mails in test/fixtures: single-part text/plain or text/html, 7bit/8bit,
// UTF-8. HTML is reduced to text by removing tags only, so hidden text (display:none, comments' text
// aside) stays in: the worst case of what a converter might pass on.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LoadedMessage } from "../../extension/mail/types.ts";

export interface Fixture {
  name: string;
  message: LoadedMessage;
  /** The marker the injected instructions ask the model to output. */
  marker: string;
}

function headers(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<!--([\s\S]*?)-->/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function readEml(file: string, id: number): LoadedMessage {
  const raw = readFileSync(file, "utf8");
  const split = raw.search(/\r?\n\r?\n/);
  const h = headers(raw.slice(0, split));
  const bodyRaw = raw.slice(split).replace(/^\r?\n\r?\n/, "").replace(/\r\n/g, "\n");
  const html = /text\/html/i.test(h.get("content-type") ?? "");
  const date = new Date(h.get("date") ?? "");
  return {
    id,
    from: h.get("from") ?? "",
    subject: h.get("subject") ?? "",
    date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
    body: html ? htmlToText(bodyRaw) : bodyRaw,
    attachments: [],
  };
}

export function injectionFixtures(): Fixture[] {
  const dir = path.resolve(import.meta.dirname, "..", "fixtures", "injection");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f, i) => ({ name: f, message: readEml(path.join(dir, f), 100 + i), marker: `PWNED-${f.slice(0, 2)}` }));
}
