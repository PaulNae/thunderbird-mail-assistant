// Loads sender, subject and plain text of a message (the one being replied to).
// HTML is never passed on: it is converted to plain text first.
import { joinParts, selectParts } from "./original-text.ts";

export interface OriginalMessage {
  from: string;
  subject: string;
  body: string;
}

interface Converter {
  convertToPlainText?: (body: string) => Promise<string>;
}

// Fallback for Thunderbird < 137 (no messengerUtilities.convertToPlainText). DOMParser builds an
// inert document: scripts do not run and nothing is loaded. Only text content is read.
function htmlToTextFallback(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, head, template").forEach((el) => el.remove());
  doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
  doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre").forEach((el) =>
    el.append("\n"),
  );
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n");
}

async function htmlToText(html: string): Promise<string> {
  const utils = (messenger as unknown as { messengerUtilities?: Converter }).messengerUtilities;
  if (typeof utils?.convertToPlainText === "function") return utils.convertToPlainText(html);
  return htmlToTextFallback(html);
}

/** Errors thrown here never contain mail content. */
export async function loadOriginal(messageId: number): Promise<OriginalMessage> {
  const [header, parts] = await Promise.all([
    messenger.messages.get(messageId),
    messenger.messages.listInlineTextParts(messageId),
  ]);
  const selection = selectParts(parts);
  let body = "";
  if (selection) {
    const texts =
      selection.kind === "plain" ? selection.parts : await Promise.all(selection.parts.map(htmlToText));
    body = joinParts(texts);
  }
  return { from: header.author, subject: header.subject, body };
}
