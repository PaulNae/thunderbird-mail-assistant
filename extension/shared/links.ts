import { TERMS_URL, formatTermsDate } from "./terms.ts";

// External links of the add-on pages open in the system browser, never inside Thunderbird.
/** A link-styled button that opens `url` (a fixed address from the code) in the default browser. */
export function externalLink(textKey: string, url: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = messenger.i18n.getMessage(textKey);
  b.addEventListener("click", () => {
    void Promise.resolve(messenger.windows.openDefaultBrowser(url)).catch(() => undefined);
  });
  return b;
}

/** The dated notice about Anthropic's terms, with a link to them. */
export function termsNotice(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "notice";
  p.textContent = messenger.i18n.getMessage("termsNotice", [formatTermsDate(messenger.i18n.getUILanguage())]);
  p.append(" ", externalLink("termsLink", TERMS_URL));
  return p;
}
