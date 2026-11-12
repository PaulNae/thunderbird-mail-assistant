// Fills elements marked with data-i18n="key" with the localized message (textContent only).
export function localizeDocument(root: ParentNode = document): void {
  if (root === document) document.documentElement.lang = messenger.i18n.getUILanguage();
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset["i18n"];
    if (!key) continue;
    const text = messenger.i18n.getMessage(key);
    if (text) el.textContent = text;
  }
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = el.dataset["i18nPlaceholder"];
    if (!key) continue;
    const text = messenger.i18n.getMessage(key);
    if (text) {
      el.placeholder = text;
      el.setAttribute("aria-label", text);
    }
  }
}
