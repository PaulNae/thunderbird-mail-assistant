// Minimal declarations for the messenger.* APIs actually used by this extension.
// Extend only when a new API is used. Source: https://webextension-api.thunderbird.net/en/mv3/
interface MessengerEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener(callback: T): boolean;
}

declare namespace messenger {
  namespace runtime {
    interface InstalledDetails {
      reason: "install" | "update" | "browser_update" | "shared_module_update";
      previousVersion?: string;
    }
    const onInstalled: MessengerEvent<(details: InstalledDetails) => void>;
  }
}
