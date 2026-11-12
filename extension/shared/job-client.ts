// Page side of the connection to the background script (popups and the chat tab).
import { parsePortEvent } from "./job-messages.ts";
import type { PortEvent, PortName } from "./job-messages.ts";

export interface JobPort {
  post(message: unknown): boolean;
}

/** Connects to the background script; incoming messages are validated by `parse`. `onClose` runs if the background side goes away. */
export async function openPort<E>(name: string, parse: (raw: unknown) => E | null, onEvent: (event: E) => void, onClose: () => void): Promise<JobPort> {
  const port = await messenger.runtime.connect(messenger.runtime.id, { name });
  let open = true;
  port.onMessage.addListener((raw) => {
    const event = parse(raw);
    if (event) onEvent(event);
  });
  port.onDisconnect.addListener(() => {
    open = false;
    onClose();
  });
  return {
    post(message: unknown): boolean {
      if (!open) return false;
      try {
        port.postMessage(message);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function openJobPort(name: PortName, onEvent: (event: PortEvent) => void, onClose: () => void): Promise<JobPort> {
  return openPort(name, parsePortEvent, onEvent, onClose);
}
