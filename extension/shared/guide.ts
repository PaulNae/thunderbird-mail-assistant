// Opening the setup guide (guide/guide.html) from pages and error messages.
import { BackendError } from "../backend/backend.ts";
import { errorMessage, guideSectionFor } from "./errors.ts";
import type { GuideSection } from "./errors.ts";

export const GUIDE_PAGE = "guide/guide.html";

/** Opens the guide in a tab, at the given section. */
export async function openGuide(section?: GuideSection): Promise<void> {
  // tabs.create resolves a relative URL against the extension root.
  await messenger.tabs.create({ url: GUIDE_PAGE + (section ? `#${section}` : "") });
}

/** A link-styled button that opens the guide; `after` runs once the tab is open (popups close themselves). */
export function guideButton(section?: GuideSection, after?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = messenger.i18n.getMessage("guideOpen");
  b.addEventListener("click", () => {
    void openGuide(section)
      .then(() => after?.())
      .catch(() => undefined);
  });
  return b;
}

/** Writes the message of an error into `el`, followed by a link to the guide if the guide explains it. */
export function showError(el: HTMLElement, e: unknown, after?: () => void): void {
  el.textContent = errorMessage(e);
  const section = guideSectionFor(e);
  if (section) el.append(" ", guideButton(section, after));
}

/** Same for a backend error code (as carried in job snapshots). */
export function showErrorCode(el: HTMLElement, code: ConstructorParameters<typeof BackendError>[0], after?: () => void): void {
  showError(el, new BackendError(code), after);
}
