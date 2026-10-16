import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { browserPartitionFor } from "@mcode/shared/browser-partition";
import { browserProfiles } from "./browser-profiles.js";
import { sanitizeHistoryUrl } from "../profiles/history-store.js";
import { BrowserCertificateFailureSchema } from "@mcode/contracts";
import { resolveAdoptedPreviewSurfaceForWindow } from "../surfaces/registry.js";

function validateSender(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.webContents !== event.sender) throw new Error("Invalid Browser profile sender");
  return win;
}

function certificateGuest(event: IpcMainInvokeEvent, surfaceId: unknown) {
  const win = validateSender(event);
  const record = resolveAdoptedPreviewSurfaceForWindow(win.id, surfaceId, event.sender);
  if (!record || browserProfiles.workspaceForSession(record.webContents.session) !== record.surface.identity.workspaceId.toLowerCase()) {
    throw new Error("Invalid Browser certificate surface");
  }
  return record.webContents;
}

function workspaceId(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a workspace UUID");
  browserPartitionFor(value);
  return value.toLowerCase();
}

/** Registers UUID-validated profile deletion and bounded complete-list reconciliation. */
export function registerBrowserProfileHandlers(): void {
  browserProfiles.initialize();
  ipcMain.handle("preview:certificate.state", (event, surfaceId: unknown) => {
    return browserProfiles.certificates.state(certificateGuest(event, surfaceId));
  });
  ipcMain.handle("preview:certificate.proceed", (event, surfaceId: unknown, fingerprint: unknown) => {
    const guest = certificateGuest(event, surfaceId);
    const parsed = BrowserCertificateFailureSchema().shape.fingerprint.parse(fingerprint);
    return browserProfiles.certificates.proceed(guest, parsed);
  });
  ipcMain.handle("preview:certificate.revoke", (event, surfaceId: unknown) => {
    return browserProfiles.certificates.revoke(certificateGuest(event, surfaceId));
  });
  ipcMain.handle("preview:history.list", (event, value: unknown) => {
    validateSender(event);
    return browserProfiles.history.list(workspaceId(value));
  });
  ipcMain.handle("preview:history.remove", (event, value: unknown, url: unknown) => {
    validateSender(event);
    const id = workspaceId(value);
    if (typeof url !== "string" || !sanitizeHistoryUrl(url)) throw new TypeError("Expected a bounded HTTP(S) history URL");
    return browserProfiles.history.remove(id, url);
  });
  ipcMain.handle("preview:profiles.remove", (event, value: unknown) => {
    validateSender(event);
    return browserProfiles.remove(workspaceId(value));
  });
  ipcMain.handle("preview:profiles.reconcile", (event, value: unknown) => {
    validateSender(event);
    if (!Array.isArray(value) || value.length > 10_000) throw new TypeError("Expected at most 10000 workspace UUIDs");
    return browserProfiles.reconcile(new Set(value.map(workspaceId)));
  });
}
