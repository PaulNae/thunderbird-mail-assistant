import { CliBackend } from "../backend/cli-backend.ts";
import { errorMessage } from "./errors.ts";
import { BRIDGE_TEST_MODEL, BRIDGE_TEST_SYSTEM, bridgeTestPrompt } from "../prompts/bridge-test.ts";

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
        out.textContent = errorMessage(e);
      } finally {
        controller = null;
        testBtn.disabled = false;
        cancelBtn.hidden = true;
      }
    })();
  });
}
