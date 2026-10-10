import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { browserPartitionFor } from "@mcode/shared/browser-partition";
import { browserProfiles } from "./browser-profiles.js";

function validateSender(event: IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.webContents !== event.sender) throw new Error("Invalid Browser profile sender");
}

function workspaceId(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a workspace UUID");
  browserPartitionFor(value);
  return value;
}

/** Registers UUID-validated profile deletion and bounded complete-list reconciliation. */
export function registerBrowserProfileHandlers(): void {
  browserProfiles.initialize();
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
