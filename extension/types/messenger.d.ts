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
      /** Set on ports passed to onConnect. */
      sender?: MessageSender;
      error?: { message?: string } | null;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: MessengerEvent<(message: unknown) => void>;
      onDisconnect: MessengerEvent<(port: Port) => void>;
    }
    const lastError: { message?: string } | null | undefined;
    // Callers use `await`, which handles both a Port and a Promise<Port>.
    function connectNative(application: string): Port | Promise<Port>;
    /** Resolves to a Port; the extension id is passed explicitly because a lone connectInfo is not documented. */
    function connect(extensionId: string, connectInfo?: { name?: string }): Port | Promise<Port>;
    const onConnect: MessengerEvent<(port: Port) => void>;
    const onInstalled: MessengerEvent<(details: InstalledDetails) => void>;
    const id: string;
    /** Opens the page of the manifest's options_ui (TB 48+). */
    function openOptionsPage(): Promise<void>;
    interface MessageSender {
      id?: string;
      /** The tab that opened the connection, if any. */
      tab?: tabs.Tab;
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
    /** Content tab; a relative url is relative to the extension root. Only in normal windows. */
    function create(createProperties: { url?: string; active?: boolean; windowId?: number }): Promise<Tab>;
    function update(tabId: number, updateProperties: { active?: boolean }): Promise<Tab>;
    const onRemoved: MessengerEvent<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
  }
  namespace messageDisplay {
    // MV3 returns a MessageList ({ id, messages }), not an array.
    function getDisplayedMessages(tabId?: number): Promise<messages.MessageList>;
    /** Needs messagesRead. Fired for a single message and for multiple selected messages. */
    const onMessagesDisplayed: MessengerEvent<(tab: tabs.Tab, displayedMessages: messages.MessageList) => void>;
    /** TB 102+, needs messagesRead. Exactly one of messageId, headerMessageId, file. */
    function open(openProperties: { messageId?: number; location?: "tab" | "window"; active?: boolean; windowId?: number }): Promise<tabs.Tab>;
  }
  namespace compose {
    interface ComposeDetails {
      isPlainText?: boolean;
      type?: "draft" | "new" | "reply" | "forward" | "redirect";
      /** Only set with the messagesRead permission, and not if the original was opened from a file. */
      relatedMessageId?: number;
      /** Needs accountsRead (TB 76+). */
      identityId?: string;
    }
    function getComposeDetails(tabId: number): Promise<ComposeDetails>;
    function beginReply(messageId: number, replyType?: "replyToAll" | "replyToList" | "replyToSender" | undefined, details?: ComposeDetails): Promise<tabs.Tab>;
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
      /** To recipients; ccList/bccList are not populated for news messages. */
      recipients?: string[];
      ccList?: string[];
      bccList?: string[];
      /** Only present with accountsRead; accountId is a string since TB 121. */
      folder?: { accountId: string; specialUse?: string[] };
      /** Marked as junk; always false for news and external messages. */
      junk?: boolean;
      /** TB 106+: message opened from a file or attachment. */
      external?: boolean;
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
    /** Options exist only from TB 133 (strict_min_version is 128), so none are passed. */
    function getFull(messageId: number): Promise<MessagePart>;
    interface QueryInfo {
      headerMessageId?: string;
      /** TB 121+. */
      accountId?: string | string[];
      /** Subject, body or author contains the string. */
      fullText?: string;
      /** Address matches completely, name partially, case-insensitive. */
      author?: string;
      /** Semicolon-separated addresses or names; all must match. */
      recipients?: string;
      subject?: string;
      /** Messages dated after this value. */
      fromDate?: Date;
      /** Messages dated before this value. */
      toDate?: Date;
      /** TB 120+, default 100. */
      messagesPerPage?: number;
      /** TB 120+: resolve to the list id instead of the first page; pages via continueList. */
      returnMessageListId?: boolean;
    }
    function query(queryInfo: QueryInfo & { returnMessageListId: true }): Promise<string>;
    function query(queryInfo: QueryInfo): Promise<MessageList>;
    /** Next page of a list; the last page has a falsy id. */
    function continueList(messageListId: string): Promise<MessageList>;
    /** TB 120+. Finalizes a list and stops any process still adding messages. */
    function abortList(messageListId: string): Promise<void>;
  }
}

// Set by the compose editor content script (extension/compose/editor.ts).
// eslint-disable-next-line no-var
declare var mailAssistantEditor: import("../compose/editor-text.ts").EditorApi | undefined;

declare namespace messenger {
  namespace accounts {
    interface MailIdentity {
      id?: string;
      email?: string;
    }
    interface MailAccount {
      id: string;
      /** The default identity is listed first. */
      identities: MailIdentity[];
    }
    function get(accountId: string, includeSubFolders?: boolean): Promise<MailAccount | null>;
  }
}

declare namespace messenger {
  namespace action {
    /** Not fired if the action has a popup. */
    const onClicked: MessengerEvent<(tab: tabs.Tab, info?: { modifiers?: string[]; button?: number }) => void>;
  }
  namespace windows {
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<unknown>;
  }
}

declare namespace messenger {
  namespace storage {
    /** Persistent; only used for settings, never for mail content. */
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    /** areaName is "local", "session", "sync" or "managed". */
    const onChanged: MessengerEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
    /** Kept in memory only, until Thunderbird or the add-on is closed or reloaded (TB 115+, needs "storage"). */
    const session: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }
}
