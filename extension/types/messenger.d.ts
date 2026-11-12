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
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
  }
  namespace compose {
    interface ComposeDetails {
      isPlainText?: boolean;
      type?: "draft" | "new" | "reply" | "forward" | "redirect";
      /** Only set with the messagesRead permission, and not if the original was opened from a file. */
      relatedMessageId?: number;
    }
    function getComposeDetails(tabId: number): Promise<ComposeDetails>;
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
