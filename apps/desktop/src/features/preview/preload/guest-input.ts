import { ipcRenderer } from "electron";
import {
  PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
  PREVIEW_GUEST_AGENT_POINTER_CHANNEL,
  PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL,
  PREVIEW_GUEST_HUMAN_INPUT_CHANNEL,
  PREVIEW_GUEST_SCROLL_CHANNEL,
  PreviewGuestInputSuppressor,
  toPreviewGuestHumanInputMessage,
} from "../contracts/guest-input.js";
import { createGuestAgentCursor, type GuestAgentCursor } from "./agent-cursor.js";

const suppressor = new PreviewGuestInputSuppressor();

setInterval(() => {
  suppressor.expire();
}, 1_000);

ipcRenderer.on(PREVIEW_GUEST_AGENT_INPUT_CHANNEL, (_event, input: unknown) => {
  if (input && typeof input === "object" && (input as { action?: unknown }).action === "revoke") {
    suppressor.revoke(input);
  } else {
    suppressor.allow(input);
  }
});

// Created on the first point: the host only sends points while recording, so most pages never pay for it.
let agentCursor: GuestAgentCursor | null = null;

ipcRenderer.on(PREVIEW_GUEST_AGENT_POINTER_CHANNEL, (_event, pointer: unknown) => {
  agentCursor ??= createGuestAgentCursor(document);
  agentCursor.show(pointer);
});

for (const eventType of ["keydown", "pointerdown", "touchstart", "wheel"] as const) {
  window.addEventListener(
    eventType,
    (event) => {
      const message = toPreviewGuestHumanInputMessage(event.type, event.isTrusted);
      if (message && !suppressor.consume(message.kind)) {
        if (message.kind === "pointer") {
          ipcRenderer.send(PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL);
        }
        ipcRenderer.sendToHost(PREVIEW_GUEST_HUMAN_INPUT_CHANNEL, message);
      }
    },
    { capture: true, passive: true },
  );
}

let scrollReportPending = false;

function reportScroll(): void {
  scrollReportPending = false;
  ipcRenderer.sendToHost(PREVIEW_GUEST_SCROLL_CHANNEL, { x: window.scrollX, y: window.scrollY });
}

window.addEventListener(
  "scroll",
  () => {
    if (scrollReportPending) return;
    scrollReportPending = true;
    window.requestAnimationFrame(reportScroll);
  },
  { passive: true },
);

window.addEventListener("load", reportScroll);
