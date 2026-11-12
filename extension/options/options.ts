// Settings page (options_ui): models per task, limits, connection test, consent.
// Only settings and the consent record are written to storage.local; values are validated on read and write.
import { localizeDocument } from "../shared/i18n.ts";
import { renderConsentText } from "../shared/consent-ui.ts";
import { CONSENT_KEY, grantConsent, readConsent, revokeConsent } from "../shared/consent.ts";
import {
  MAX_MESSAGES_BOUNDS,
  MAX_TEXT_BOUNDS,
  MODEL_CHOICES,
  MODEL_TASKS,
  SETTINGS_KEY,
  TIMEOUT_BOUNDS,
  defaultSettings,
  readSettings,
  writeSettings,
} from "../shared/settings.ts";
import type { Bounds, ModelTask, Settings } from "../shared/settings.ts";
import { parseCheckResponse } from "../shared/messages.ts";
import type { CheckState } from "../shared/messages.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};
const t = (key: string, subs?: string[]): string => messenger.i18n.getMessage(key, subs);

const savedEl = $("saved");
const consentStateEl = $("consent-state");
const consentTextEl = $("consent-text");
const grantBtn = $<HTMLButtonElement>("consent-grant");
const revokeBtn = $<HTMLButtonElement>("consent-revoke");
const checkBtn = $<HTMLButtonElement>("check");
const checkResultEl = $("check-result");
const resetBtn = $<HTMLButtonElement>("reset");

const MODEL_KEYS: Record<(typeof MODEL_CHOICES)[number], string> = {
  haiku: "optionsModelHaiku",
  sonnet: "optionsModelSonnet",
  opus: "optionsModelOpus",
};

const selects = new Map<ModelTask, HTMLSelectElement>(MODEL_TASKS.map((task) => [task, $<HTMLSelectElement>(`model-${task}`)]));
for (const sel of selects.values()) {
  for (const m of MODEL_CHOICES) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = t(MODEL_KEYS[m]);
    sel.append(opt);
  }
}

interface NumberField {
  el: HTMLInputElement;
  bounds: Bounds;
  key: "maxMessages" | "maxTextChars" | "timeoutSec";
}
const numbers: NumberField[] = [
  { el: $<HTMLInputElement>("max-messages"), bounds: MAX_MESSAGES_BOUNDS, key: "maxMessages" },
  { el: $<HTMLInputElement>("max-text"), bounds: MAX_TEXT_BOUNDS, key: "maxTextChars" },
  { el: $<HTMLInputElement>("timeout"), bounds: TIMEOUT_BOUNDS, key: "timeoutSec" },
];
for (const f of numbers) {
  f.el.min = String(f.bounds.min);
  f.el.max = String(f.bounds.max);
  const range = document.getElementById(`${f.el.id}-range`);
  if (range) range.textContent = t("optionsRange", [String(f.bounds.min), String(f.bounds.max), String(f.bounds.def)]);
}

function show(s: Settings): void {
  for (const [task, sel] of selects) sel.value = s.models[task];
  for (const f of numbers) f.el.value = String(s[f.key]);
}

function collect(): Record<string, unknown> {
  const models: Record<string, string> = {};
  for (const [task, sel] of selects) models[task] = sel.value;
  const out: Record<string, unknown> = { models };
  for (const f of numbers) out[f.key] = f.el.value;
  return out;
}

async function save(): Promise<void> {
  try {
    // writeSettings validates and clamps; the form shows what was actually stored.
    show(await writeSettings(messenger.storage.local, collect()));
    savedEl.textContent = t("optionsSaved");
  } catch {
    savedEl.textContent = t("errorInternal");
  }
}

for (const sel of selects.values()) sel.addEventListener("change", () => void save());
for (const f of numbers) f.el.addEventListener("change", () => void save());
resetBtn.addEventListener("click", () => {
  show(defaultSettings());
  void save();
});

async function showConsent(): Promise<void> {
  const given = await readConsent(messenger.storage.local);
  consentStateEl.textContent = t(given ? "optionsConsentGiven" : "optionsConsentMissing");
  consentTextEl.hidden = given;
  grantBtn.hidden = given;
  revokeBtn.hidden = !given;
}
renderConsentText(consentTextEl, "h2");
grantBtn.addEventListener("click", () => {
  void grantConsent(messenger.storage.local)
    .catch(() => {
      savedEl.textContent = t("errorInternal");
    })
    .then(showConsent)
    .then(() => revokeBtn.focus());
});
revokeBtn.addEventListener("click", () => {
  void revokeConsent(messenger.storage.local)
    .catch(() => {
      savedEl.textContent = t("errorInternal");
    })
    .then(showConsent)
    .then(() => grantBtn.focus());
});

const CHECK_KEYS: Record<CheckState, string> = {
  ok: "optionsCheckOk",
  host_not_found: "optionsCheckHostNotFound",
  cli_not_found: "optionsCheckCliNotFound",
  not_logged_in: "optionsCheckNotLoggedIn",
  timeout: "optionsCheckTimeout",
  internal: "optionsCheckInternal",
};

checkBtn.addEventListener("click", () => {
  checkBtn.disabled = true;
  checkResultEl.textContent = t("optionsCheckRunning");
  void (async () => {
    try {
      const res = parseCheckResponse(await messenger.runtime.sendMessage({ type: "checkBackend" }));
      if (!res) checkResultEl.textContent = t(CHECK_KEYS.internal);
      else if (res.state === "ok") checkResultEl.textContent = t("optionsCheckOk", [res.version ?? "?"]);
      else checkResultEl.textContent = t(CHECK_KEYS[res.state]);
    } catch {
      checkResultEl.textContent = t(CHECK_KEYS.internal);
    } finally {
      checkBtn.disabled = false;
    }
  })();
});

// Changes from another page (the consent dialog of a popup).
messenger.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (CONSENT_KEY in changes) void showConsent();
  if (SETTINGS_KEY in changes) void readSettings(messenger.storage.local).then(show);
});

void readSettings(messenger.storage.local).then(show);
void showConsent();
