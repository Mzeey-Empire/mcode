import * as NodePath from "node:path";
import { browserProfiles } from "./browser-profiles.js";
import { findPendingPreviewAttachment } from "../surfaces/registry.js";

/** Mutable web preferences received with Electron's will-attach-webview event. */
export interface PreviewWebviewPreferences {
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  devTools?: boolean;
  preload?: string;
  preloadURL?: string;
}

/** Mutable attachment parameters received with Electron's will-attach-webview event. */
export interface PreviewWebviewAttachParams {
  src?: string;
  partition?: string;
  preload?: string;
}

/** Resolves the only preload that preview webviews may execute. */
export function resolvePreviewGuestPreloadPath(mainBundleDirectory: string): string {
  return NodePath.join(mainBundleDirectory, "..", "preload", "preview-guest-preload.cjs");
}

/** Authorizes the prepared workspace partition before applying sandbox and preload policy. */
export function hardenPreviewWebviewAttachment(
  webPreferences: PreviewWebviewPreferences,
  params: PreviewWebviewAttachParams,
  guestPreloadPath: string,
  windowId: number,
): boolean {
  const pending = findPendingPreviewAttachment(windowId, params.src);
  if (!pending || params.partition !== pending.partition) return false;
  try {
    browserProfiles.sessionForWorkspace(pending.surface.identity.workspaceId);
  } catch {
    // A removed profile or failed policy installation must refuse attachment.
    return false;
  }
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.devTools = true;
  webPreferences.preload = guestPreloadPath;
  delete webPreferences.preloadURL;
  params.preload = guestPreloadPath;
  return true;
}
