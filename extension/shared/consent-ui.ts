// Consent dialog shown inside a page (popups, chat tab) before anything can be sent to the model.
// The page's own content stays hidden until the user agrees. The background script enforces the
// consent independently (background/gated-backend.ts); this is only the explanation and the switch.
import { CONSENT_KEY, grantConsent, readConsent } from "./consent.ts";

/** The paragraphs of the consent text, in order. Changing them in substance means raising CONSENT_VERSION. */
export const CONSENT_TEXT_KEYS = ["consentIntro", "consentWhat", "consentWhere", "consentNoAction", "consentNoDisk", "consentRevoke"] as const;

const t = (key: string): string => messenger.i18n.getMessage(key);

/** Appends the heading and the paragraphs of the consent text to `el` (textContent only). */
export function renderConsentText(el: HTMLElement, headingLevel: "h1" | "h2" = "h2"): void {
  const heading = document.createElement(headingLevel);
  heading.textContent = t("consentHeading");
  heading.id = `${el.id || "consent"}-heading`;
  el.append(heading);
  for (const key of CONSENT_TEXT_KEYS) {
    const p = document.createElement("p");
    p.textContent = t(key);
    p.id = `${el.id || "consent"}-${key}`;
    el.append(p);
  }
}

/** The ids of the paragraphs written by renderConsentText into `el`. */
const paragraphIds = (el: HTMLElement): string => CONSENT_TEXT_KEYS.map((k) => `${el.id || "consent"}-${k}`).join(" ");

/** First enabled control of `root`, for moving the focus there. */
function firstControl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]), [tabindex=\"0\"]");
}

export interface ConsentGate {
  /** Re-reads the consent and shows either the dialog or the page. Resolves to the consent state. */
  refresh(): Promise<boolean>;
}

/**
 * Builds the dialog into `panel` and toggles it against `app`. `onDecline` runs for "Not now"
 * (popups close themselves); `onChange` runs whenever the state may have changed.
 */
export function setupConsent(panel: HTMLElement, app: HTMLElement, opts: { onDecline?: () => void; onChange?: (given: boolean) => void } = {}): ConsentGate {
  panel.replaceChildren();
  panel.setAttribute("role", "region");
  renderConsentText(panel);
  panel.setAttribute("aria-labelledby", `${panel.id || "consent"}-heading`);
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  const row = document.createElement("div");
  row.className = "row";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary";
  accept.textContent = t("consentAccept");
  // Focus lands on this button; the description makes screen readers read the consent text with it.
  accept.setAttribute("aria-describedby", paragraphIds(panel));
  const decline = document.createElement("button");
  decline.type = "button";
  decline.textContent = t("consentDecline");
  row.append(accept, decline);
  panel.append(row, status);

  // Neither is shown until the consent has been read.
  panel.hidden = true;
  app.hidden = true;
  let given: boolean | null = null;
  const show = (now: boolean): void => {
    const before = given;
    given = now;
    panel.hidden = now;
    app.hidden = !now;
    if (before !== now && !now) accept.focus();
    // Just agreed: the button is gone, so the focus moves into the page instead of falling to <body>.
    if (before === false && now) {
      const target = firstControl(app) ?? app.querySelector<HTMLElement>("h1");
      if (target && target.tagName === "H1") target.tabIndex = -1;
      target?.focus();
    }
    opts.onChange?.(now);
  };
  const refresh = async (): Promise<boolean> => {
    const now = await readConsent(messenger.storage.local);
    show(now);
    return now;
  };

  accept.addEventListener("click", () => {
    void (async () => {
      try {
        await grantConsent(messenger.storage.local);
        status.textContent = "";
      } catch {
        status.textContent = t("errorInternal");
      }
      await refresh();
    })();
  });
  decline.addEventListener("click", () => {
    status.textContent = t("consentDeclined");
    opts.onDecline?.();
  });
  // Granted or revoked in another window (or the settings page).
  messenger.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && CONSENT_KEY in changes) void refresh();
  });
  return { refresh };
}
