import { ipcMain } from "electron";
import type { IpcMain, Session, WebContents } from "electron";
import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";
import { registerPreviewClipboardPermissionHandlers } from "./clipboard-trust.js";
import type { PreviewPopupRequest, PreviewPopupSurfaceRef } from "../contracts/popup.js";
import { registerWebRequestInterceptor } from "../capture/handlers.js";

/** Bounded host-side popup sink used by a generation-bound guest binding. */
export type PreviewPopupEmitter = (request: PreviewPopupRequest) => void;

/** Agent-operation predicate used to classify the exact popup source guest. */
export type PreviewAgentOperationPredicate = (webContents: WebContents) => boolean;

/** Options for binding one exact generation-bound guest to popup mediation. */
export interface PreviewGuestPopupBindingOptions {
  readonly sourceSurface: PreviewPopupSurfaceRef;
  readonly emitPopup: PreviewPopupEmitter;
  readonly isAgentOperationActive: PreviewAgentOperationPredicate;
}

const denyPopup = () => ({ action: "deny" as const });

function validPopupAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > BROWSER_TAB_INFO_STRING_MAX.url) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0
  );
}

const policySessions = new WeakSet<Session>();

/** Installs clipboard trust, download denial and failed-request recording once per workspace session. */
export function installBrowserSessionPolicy(profile: Session, clipboardIpc: Pick<IpcMain, "on"> = ipcMain): void {
  if (policySessions.has(profile)) return;
  registerPreviewClipboardPermissionHandlers(profile, clipboardIpc);
  profile.on("will-download", (event) => event.preventDefault());
  registerWebRequestInterceptor(profile);
  policySessions.add(profile);
}

/** Mediates popups from one adopted guest, regardless of its workspace session. */
export function bindGuestPopup(
  guest: WebContents,
  options: PreviewGuestPopupBindingOptions,
): () => void {
  let bound = true;
  const unbind = () => {
    if (!bound) return;
    bound = false;
    try {
      guest.removeListener("destroyed", onDestroyed);
      if (!guest.isDestroyed()) guest.setWindowOpenHandler(denyPopup);
    } catch {
      // Electron can destroy a guest before release cleanup reaches this adapter.
    }
  };
  const onDestroyed = () => {
    bound = false;
    try {
      guest.removeListener("destroyed", onDestroyed);
    } catch {
      // Guest teardown is already complete.
    }
  };
  guest.setWindowOpenHandler(({ url }: { url: string }) => {
    if (bound && validPopupAddress(url)) {
      try {
        options.emitPopup({
          sourceSurface: options.sourceSurface,
          address: url,
          initiator: options.isAgentOperationActive(guest) ? "agent" : "human",
        });
      } catch {
        // Popup delivery must not bypass Electron's direct-window denial.
      }
    }
    return denyPopup();
  });
  guest.once("destroyed", onDestroyed);
  return unbind;
}
