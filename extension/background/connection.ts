// Connects popup ports to the job store. Pure apart from the port object, so it is testable in Node.
import { isOwnSender } from "../shared/messages.ts";
import { PORT_COMPOSE, parsePortRequest, portName } from "../shared/job-messages.ts";
import type { PortEvent } from "../shared/job-messages.ts";
import { composeKey, displayKey } from "./jobs.ts";
import type { JobStore } from "./jobs.ts";

export interface PortLike {
  name: string;
  sender?: { id?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export function handleConnection(store: JobStore, port: PortLike, ownId: string): void {
  const name = portName(port.name);
  if (!name || !isOwnSender(port.sender?.id, ownId)) {
    port.disconnect();
    return;
  }
  let key: string | null = null;
  let closed = false;
  let detach: (() => void) | null = null;
  const send = (event: PortEvent): void => {
    if (closed) return;
    try {
      port.postMessage(event);
    } catch {
      // The popup is gone; the job continues.
    }
  };

  port.onMessage.addListener((raw) => {
    const req = parsePortRequest(name, raw);
    if (!req) return;
    if (req.type === "open") {
      if (key !== null) return;
      key = name === PORT_COMPOSE ? composeKey(req.tabId) : displayKey(req.tabId);
      void store.open(key, send, req.messageId).then((d) => {
        if (closed) d();
        else detach = d;
      });
      return;
    }
    if (key === null) return;
    switch (req.type) {
      case "start":
        void store.start(key, req.start);
        break;
      case "cancel":
        store.cancel(key);
        break;
      case "discard":
      case "applied":
        void store.clear(key);
        break;
    }
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    detach?.();
  });
}
