// Loads sender, subject, date, plain text and attachment names of a message.
// HTML is never passed on: it is converted to plain text first. Attachments are only named.
import type { LoadedMessage } from "./types.ts";
import { joinParts, selectParts } from "./text-parts.ts";

export type { LoadedMessage } from "./types.ts";

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

async function loadBody(messageId: number): Promise<string> {
  const parts = await messenger.messages.listInlineTextParts(messageId);
  const selection = selectParts(parts);
  if (!selection) return "";
  const texts =
    selection.kind === "plain" ? selection.parts : await Promise.all(selection.parts.map(htmlToText));
  return joinParts(texts);
}

/** Errors thrown here never contain mail content. */
export async function loadOriginal(messageId: number): Promise<OriginalMessage> {
  const [header, body] = await Promise.all([messenger.messages.get(messageId), loadBody(messageId)]);
  return { from: header.author, subject: header.subject, body };
}

function isoDate(d: Date | undefined): string {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
}

/** Errors thrown here never contain mail content. A failing attachment list yields no names. */
export async function loadMessage(messageId: number): Promise<LoadedMessage> {
  const [header, body, attachments] = await Promise.all([
    messenger.messages.get(messageId),
    loadBody(messageId),
    messenger.messages
      .listAttachments(messageId)
      .then((list) => list.map((a) => a.name))
      .catch(() => [] as string[]),
  ]);
  return {
    id: messageId,
    from: header.author,
    subject: header.subject,
    date: isoDate(header.date),
    body,
    attachments,
  };
}
