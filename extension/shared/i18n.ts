// Fills elements marked with data-i18n="key" with the localized message (textContent only).
export function localizeDocument(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset["i18n"];
    if (!key) continue;
    const text = messenger.i18n.getMessage(key);
    if (text) el.textContent = text;
  }
}
