// Minimal declarations for the messenger.* APIs actually used by this extension.
// Extend only when a new API is used. Source: https://webextension-api.thunderbird.net/en/mv3/
interface MessengerEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener(callback: T): boolean;
}

declare namespace messenger {
  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
    function getUILanguage(): string;
  }
  namespace runtime {
    interface InstalledDetails {
      reason: "install" | "update" | "browser_update" | "shared_module_update";
      previousVersion?: string;
    }
    interface Port {
      name: string;
      error?: { message?: string } | null;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: MessengerEvent<(message: unknown) => void>;
      onDisconnect: MessengerEvent<(port: Port) => void>;
    }
    const lastError: { message?: string } | null | undefined;
    // Callers use `await`, which handles both a Port and a Promise<Port>.
    function connectNative(application: string): Port | Promise<Port>;
    const onInstalled: MessengerEvent<(details: InstalledDetails) => void>;
    const id: string;
    interface MessageSender {
      id?: string;
    }
    function sendMessage(message: unknown): Promise<unknown>;
    // Return true to call sendResponse asynchronously.
    const onMessage: MessengerEvent<(message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void>;
  }
}

declare namespace messenger {
  namespace scripting {
    interface InjectionResult {
      frameId: number;
      result?: unknown;
      error?: { message?: string };
    }
    interface ScriptTarget {
      tabId: number;
    }
    type ExecuteScriptDetails =
      | { target: ScriptTarget; files: string[] }
      | { target: ScriptTarget; func: (...args: never[]) => unknown; args?: unknown[] };
    function executeScript(details: ExecuteScriptDetails): Promise<InjectionResult[]>;
  }
}

declare namespace messenger {
  namespace tabs {
    // Only `id` is used; url/title would need the "tabs" permission.
    interface Tab {
      id?: number;
      windowId?: number;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
  }
  namespace messageDisplay {
    // MV3 returns a MessageList ({ id, messages }), not an array.
    function getDisplayedMessages(tabId?: number): Promise<messages.MessageList>;
  }
  namespace compose {
    interface ComposeDetails {
      isPlainText?: boolean;
      type?: "draft" | "new" | "reply" | "forward" | "redirect";
      /** Only set with the messagesRead permission, and not if the original was opened from a file. */
      relatedMessageId?: number;
    }
    function getComposeDetails(tabId: number): Promise<ComposeDetails>;
    function beginReply(messageId: number, replyType?: "replyToAll" | "replyToList" | "replyToSender", details?: ComposeDetails): Promise<tabs.Tab>;
  }
  namespace composeAction {
    /** Resolves to false if the popup cannot be opened (TB 113+ for options and return value). */
    function openPopup(options?: { windowId?: number }): Promise<boolean>;
  }
}

declare namespace messenger {
  namespace messages {
    interface MessageHeader {
      id: number;
      author: string;
      subject: string;
      /** Date header; may be invalid or missing for broken messages. */
      date?: Date;
      headerMessageId: string;
    }
    interface MessageAttachment {
      name: string;
    }
    /** Only the headers are used. Keys are not documented as lowercase. */
    interface MessagePart {
      headers?: Record<string, string[]>;
    }
    interface MessageList {
      id: string | null;
      messages: MessageHeader[];
    }
    interface InlineTextPart {
      contentType: string;
      content: string;
    }
    function get(messageId: number): Promise<MessageHeader>;
    function listInlineTextParts(messageId: number): Promise<InlineTextPart[]>;
    function listAttachments(messageId: number): Promise<MessageAttachment[]>;
    function getFull(
      messageId: number,
      options?: { decodeHeaders?: boolean; decodeContent?: boolean },
    ): Promise<MessagePart>;
    function query(queryInfo: { headerMessageId?: string }): Promise<MessageList>;
  }
}

// Set by the compose editor content script (extension/compose/editor.ts).
// eslint-disable-next-line no-var
declare var mailAssistantEditor: import("../compose/editor-text.ts").EditorApi | undefined;
