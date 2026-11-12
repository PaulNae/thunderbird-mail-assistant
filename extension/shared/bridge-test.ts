import { BackendError } from "../backend/backend.ts";
import type { BackendErrorCode } from "../backend/backend.ts";
import { CliBackend } from "../backend/cli-backend.ts";
import { BRIDGE_TEST_MODEL, BRIDGE_TEST_SYSTEM, bridgeTestPrompt } from "../prompts/bridge-test.ts";

const ERROR_KEYS: Record<BackendErrorCode, string> = {
  host_not_found: "errorHostNotFound",
  cli_not_found: "errorCliNotFound",
  not_logged_in: "errorNotLoggedIn",
  rate_limited: "errorRateLimited",
  timeout: "errorTimeout",
  cancelled: "errorCancelled",
  internal: "errorInternal",
};

const backend = new CliBackend();

// Wires the test and cancel buttons to a streamed run; output is written via textContent only.
export function setupBridgeTest(doc: Document = document): void {
  const testBtn = doc.getElementById("bridge-test") as HTMLButtonElement | null;
  const cancelBtn = doc.getElementById("bridge-cancel") as HTMLButtonElement | null;
  const out = doc.getElementById("bridge-output");
  if (!testBtn || !cancelBtn || !out) return;
  let controller: AbortController | null = null;

  cancelBtn.addEventListener("click", () => controller?.abort());
  testBtn.addEventListener("click", () => {
    void (async () => {
      controller = new AbortController();
      testBtn.disabled = true;
      cancelBtn.hidden = false;
      out.textContent = "";
      try {
        for await (const chunk of backend.run({
          system: BRIDGE_TEST_SYSTEM,
          prompt: bridgeTestPrompt(),
          model: BRIDGE_TEST_MODEL,
          signal: controller.signal,
        })) {
          out.textContent = (out.textContent ?? "") + chunk;
        }
      } catch (e) {
        const code: BackendErrorCode = e instanceof BackendError ? e.code : "internal";
        out.textContent = messenger.i18n.getMessage(ERROR_KEYS[code]);
      } finally {
        controller = null;
        testBtn.disabled = false;
        cancelBtn.hidden = true;
      }
    })();
  });
}
