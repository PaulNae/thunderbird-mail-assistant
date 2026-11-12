// Setup guide: API key, Claude Code helper, notices. Opened from the settings, the consent dialog, error
// messages and once after a new installation. Static text from _locales; links open in the system browser.
import { localizeDocument } from "../shared/i18n.ts";
import { externalLink, termsNotice } from "../shared/links.ts";
import { CONSOLE_KEYS_URL, ISSUES_URL, REPOSITORY_URL } from "../shared/terms.ts";
import { cliSupported } from "../background/switching-backend.ts";

localizeDocument();

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
};

$("console-link").append(externalLink("guideApiConsoleLink", CONSOLE_KEYS_URL));
$("repo-link").append(externalLink("guideCliRepoLink", REPOSITORY_URL));
$("terms-row").append(termsNotice());
$("issues-link").append(externalLink("guideFeedbackLink", ISSUES_URL));

const settings = document.createElement("button");
settings.type = "button";
settings.textContent = messenger.i18n.getMessage("openSettings");
settings.addEventListener("click", () => void messenger.runtime.openOptionsPage().catch(() => undefined));
$("settings-row").append(settings);

void messenger.runtime
  .getPlatformInfo()
  .then((p) => {
    $("cli-unsupported").hidden = cliSupported(p.os);
  })
  .catch(() => undefined);
