// Settings page (options_ui): backend and API key, models per task, limits, connection test, consent.
// Only settings, the API key and the consent record are written to storage.local; values are validated on
// read and write. The stored key is never shown again, only whether there is one.
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
  settleBackendChoice,
  writeSettings,
} from "../shared/settings.ts";
import type { Bounds, ModelTask, Settings } from "../shared/settings.ts";
import { parseCheckResponse } from "../shared/messages.ts";
import { BackendError } from "../backend/backend.ts";
import type { BackendKind } from "../backend/backend.ts";
import { API_KEY_KEY, readApiKey, removeApiKey, writeApiKey } from "../shared/api-key.ts";
import { guideButton, showError } from "../shared/guide.ts";
import { termsNotice } from "../shared/links.ts";
import { cliSupported } from "../background/switching-backend.ts";

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
const radios: Record<BackendKind, HTMLInputElement> = { api: $<HTMLInputElement>("backend-api"), cli: $<HTMLInputElement>("backend-cli") };
const cliUnsupportedEl = $("backend-cli-unsupported");
const keyBox = $("api-key-box");
const keyInput = $<HTMLInputElement>("api-key");
const keySaveBtn = $<HTMLButtonElement>("api-key-save");
const keyRemoveBtn = $<HTMLButtonElement>("api-key-remove");
const keyStateEl = $("api-key-state");
const keyStatusEl = $("api-key-status");

$("guide-row").append(guideButton());
$("terms-row").append(termsNotice());

/** Whether this system can run the CLI backend; the option stays selectable while it is the current choice. */
let cliOk = true;
let backend: BackendKind = "api";

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

function showBackend(kind: BackendKind): void {
  const changed = kind !== backend;
  backend = kind;
  radios[kind].checked = true;
  keyBox.hidden = kind !== "api";
  radios.cli.disabled = !cliOk && kind !== "cli";
  cliUnsupportedEl.hidden = cliOk;
  if (changed) {
    renderConsent();
    checkResultEl.textContent = "";
  }
}

function show(s: Settings): void {
  showBackend(s.backend);
  for (const [task, sel] of selects) sel.value = s.models[task];
  for (const f of numbers) f.el.value = String(s[f.key]);
}

function collect(): Record<string, unknown> {
  const models: Record<string, string> = {};
  for (const [task, sel] of selects) models[task] = sel.value;
  const out: Record<string, unknown> = { backend: radios.cli.checked ? "cli" : "api", models };
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
for (const r of Object.values(radios)) r.addEventListener("change", () => void save());
for (const f of numbers) f.el.addEventListener("change", () => void save());
resetBtn.addEventListener("click", () => {
  // The backend is the user's choice, not a limit: resetting keeps it.
  show({ ...defaultSettings(), backend });
  void save();
});

async function showConsent(): Promise<void> {
  const given = await readConsent(messenger.storage.local);
  consentStateEl.textContent = t(given ? "optionsConsentGiven" : "optionsConsentMissing");
  consentTextEl.hidden = given;
  grantBtn.hidden = given;
  revokeBtn.hidden = !given;
}
function renderConsent(): void {
  consentTextEl.replaceChildren();
  renderConsentText(consentTextEl, "h2", backend);
}

async function showKeyState(): Promise<void> {
  keyStateEl.textContent = t((await readApiKey(messenger.storage.local)) ? "optionsApiKeyStored" : "optionsApiKeyNone");
}
keySaveBtn.addEventListener("click", () => {
  void (async () => {
    try {
      const ok = await writeApiKey(messenger.storage.local, keyInput.value);
      keyStatusEl.textContent = t(ok ? "optionsApiKeySaved" : "optionsApiKeyInvalidFormat");
      // The field is emptied once the key is stored, so it is never shown again.
      if (ok) keyInput.value = "";
    } catch {
      keyStatusEl.textContent = t("errorInternal");
    }
    await showKeyState();
  })();
});
keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") keySaveBtn.click();
});
keyRemoveBtn.addEventListener("click", () => {
  void removeApiKey(messenger.storage.local)
    .then(() => {
      keyStatusEl.textContent = t("optionsApiKeyRemoved");
    })
    .catch(() => {
      keyStatusEl.textContent = t("errorInternal");
    })
    .then(showKeyState);
});
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

checkBtn.addEventListener("click", () => {
  checkBtn.disabled = true;
  checkResultEl.textContent = t("optionsCheckRunning");
  void (async () => {
    try {
      const res = parseCheckResponse(await messenger.runtime.sendMessage({ type: "checkBackend" }));
      if (!res || res.state === "internal") checkResultEl.textContent = t("optionsCheckInternal");
      else if (res.state === "ok") checkResultEl.textContent = res.backend === "api" ? t("optionsCheckOkApi") : t("optionsCheckOk", [res.version ?? "?"]);
      else if (res.state === "timeout") checkResultEl.textContent = t("optionsCheckTimeout");
      else showError(checkResultEl, new BackendError(res.state));
    } catch {
      checkResultEl.textContent = t("optionsCheckInternal");
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
  if (API_KEY_KEY in changes) void showKeyState();
});

void (async () => {
  cliOk = cliSupported(await messenger.runtime.getPlatformInfo().then((p) => p.os).catch(() => "mac"));
  // Normally done by the background script already; repeated here so the page never shows a wrong default.
  await settleBackendChoice(messenger.storage.local).catch(() => undefined);
  const s = await readSettings(messenger.storage.local);
  backend = s.backend;
  renderConsent();
  show(s);
})();
void showConsent();
void showKeyState();
