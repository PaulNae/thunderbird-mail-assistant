// Popup-side bridge: injects the editor content script into a compose tab and calls it.
import type { ApplyResult, CaptureResult } from "./editor-text.ts";

export type { ApplyResult, CaptureResult };

type Op = "capture" | "apply" | "peek";

async function callEditor<T>(tabId: number, op: Op, arg: boolean | string): Promise<T> {
  // Inject only once per document: the script keeps the captured range in its module state.
  const probe = await messenger.scripting.executeScript({
    target: { tabId },
    func: (): boolean => typeof globalThis.mailAssistantEditor !== "undefined",
  });
  if (probe[0]?.result !== true) {
    await messenger.scripting.executeScript({
      target: { tabId },
      files: ["/compose/editor.js"],
    });
  }
  const results = await messenger.scripting.executeScript({
    target: { tabId },
    func: (operation: string, argument: boolean | string): unknown => {
      const api = globalThis.mailAssistantEditor as unknown as Record<string, (a: unknown) => unknown>;
      return api[operation]?.(argument);
    },
    args: [op, arg],
  });
  const first = results[0];
  if (!first) throw new Error("No result from the compose editor script");
  if (first.error) throw new Error(first.error.message ?? "Compose editor script failed");
  return first.result as T;
}

/** Captures the selection, or the user's own text if nothing is selected. */
export function captureSelection(tabId: number, isPlainText: boolean): Promise<CaptureResult> {
  return callEditor<CaptureResult>(tabId, "capture", isPlainText);
}

/** The range capture would find, without replacing the stored capture. */
export function peekSelection(tabId: number, isPlainText: boolean): Promise<CaptureResult> {
  return callEditor<CaptureResult>(tabId, "peek", isPlainText);
}

/** Replaces the previously captured range with the given text (text only, no markup). */
export function applyText(tabId: number, text: string): Promise<ApplyResult> {
  return callEditor<ApplyResult>(tabId, "apply", text);
}
