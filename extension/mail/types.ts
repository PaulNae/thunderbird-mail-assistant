// Shared mail types (no messenger.* or DOM, usable in Node tests).

export interface LoadedMessage {
  id: number;
  from: string;
  subject: string;
  /** ISO string, or "" if the message has no valid date. */
  date: string;
  body: string;
  /** Names only, never content. */
  attachments: string[];
}
