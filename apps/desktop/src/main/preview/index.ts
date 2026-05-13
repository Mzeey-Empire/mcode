/**
 * Public surface of the preview browser subsystem.
 * Wires all IPC handlers and re-exports the symbols that main.ts needs.
 */

export { disposePreviewForWindow } from "./preview-lifecycle.js";
export type {
  PreviewPictureReferenceResult,
  PreviewContextReferenceResult,
} from "./preview-capture.js";

import { session } from "electron";
import { registerNavigationHandlers } from "./preview-navigation.js";
import { registerCaptureHandlers, registerWebRequestInterceptor } from "./preview-capture.js";
import { registerOverlayHandlers } from "./preview-overlay.js";
import { registerSpillHandlers } from "./preview-spill.js";

/** Registers all preview:* IPC handlers. Call once at app startup. */
export function registerPreviewBrowserHandlers(): void {
  const previewPartition = session.fromPartition("persist:mcode-preview");
  previewPartition.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  registerNavigationHandlers();
  registerCaptureHandlers();
  registerWebRequestInterceptor(previewPartition);
  registerOverlayHandlers();
  registerSpillHandlers();
}
