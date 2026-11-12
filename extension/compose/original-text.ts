// DOM-free selection logic for the text of the original message (testable in Node).

export interface TextPart {
  contentType: string;
  content: string;
}

/** Upper bound for the combined text; the prompt builder truncates further. */
export const MAX_ORIGINAL_TEXT = 200_000;

function isBlank(s: string): boolean {
  return s.replace(/[\s\u00a0]+/g, "") === "";
}

const typeOf = (p: TextPart): string => p.contentType.split(";")[0]?.trim().toLowerCase() ?? "";

export interface PartSelection {
  kind: "plain" | "html";
  parts: string[];
}

/** Prefers non-blank text/plain parts; falls back to non-blank text/html parts; else null. */
export function selectParts(parts: readonly TextPart[]): PartSelection | null {
  const pick = (type: string): string[] =>
    parts.filter((p) => typeOf(p) === type && !isBlank(p.content)).map((p) => p.content);
  const plain = pick("text/plain");
  if (plain.length > 0) return { kind: "plain", parts: plain };
  const html = pick("text/html");
  if (html.length > 0) return { kind: "html", parts: html };
  return null;
}

/** Joins several parts with a blank line, normalizes line breaks and caps the length. */
export function joinParts(parts: readonly string[]): string {
  const joined = parts
    .map((p) => p.replace(/\r\n?/g, "\n").trim())
    .filter((p) => p !== "")
    .join("\n\n");
  return joined.length > MAX_ORIGINAL_TEXT ? joined.slice(0, MAX_ORIGINAL_TEXT) : joined;
}
