import type { AttachmentMeta } from "./types";
import type { McodeBrowserCaptureV1 } from "@mcode/contracts";

/** Discriminated union describing the auto-updater lifecycle state. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string }
  | { state: "error"; message: string };

/** App version and auto-update controls exposed by the main process. */
interface AppBridge {
  /** Read the running app version (from package.json at build time). */
  getVersion(): Promise<string>;
  /** Get the most recent update status without triggering a new check. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Manually trigger a check for updates. Resolves with the resulting status. */
  checkForUpdates(): Promise<UpdateStatus>;
  /** Quit and install a downloaded update. No-op if nothing is downloaded. */
  installUpdate(): Promise<void>;
  /** Subscribe to push updates of update-status. Returns the listener for cleanup. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): (...args: unknown[]) => void;
  /** Remove a previously registered update-status listener. */
  offUpdateStatus(listener: (...args: unknown[]) => void): void;
}

/** Bounds for aligning the native BrowserView with a DOM region in the React shell. */
export type PreviewShellBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Result of a preview navigation attempt (http and https only). */
export type PreviewNavigateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Result of capturing the embedded preview viewport as a PNG for the composer. */
export type PreviewPictureReferenceResult =
  | {
      readonly ok: true;
      readonly meta: AttachmentMeta;
      readonly previewBytes: Uint8Array;
      readonly capture: McodeBrowserCaptureV1;
    }
  | { readonly ok: false; readonly error: string };

/** Embedded thread preview backed by an Electron BrowserView. */
interface PreviewBridge {
  sync(payload: { visible: boolean; bounds: PreviewShellBounds | null }): Promise<void>;
  navigate(url: string): Promise<PreviewNavigateResult>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  reload(): Promise<void>;
  openExternal(): Promise<void>;
  getNavigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
  /** Captures the visible preview as PNG; desktop only. */
  capturePictureReference(): Promise<PreviewPictureReferenceResult>;
  /** Drag a rectangle on the preview, then capture that region as PNG; desktop only. */
  capturePictureReferenceRegion(): Promise<PreviewPictureReferenceResult>;
  onDidNavigate(callback: (payload: { url: string; title: string }) => void): () => void;
}

/** IPC push transport relayed from the Electron main process. */
interface IpcBridge {
  /** Register a callback for push messages forwarded by the main process. */
  onPush(callback: (data: unknown) => void): void;
  /** Register a callback for IPC connection close events. */
  onDisconnect(callback: () => void): void;
  /** Remove all IPC push listeners. */
  off(): void;
}

/** Data pushed from the main process when the user right-clicks in an editable area. */
export interface SpellcheckContextMenuData {
  readonly x: number;
  readonly y: number;
  readonly misspelledWord: string;
  readonly suggestions: readonly string[];
  readonly selectionText: string;
  readonly isEditable: boolean;
  readonly editFlags: {
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

/** Spellcheck IPC bridge for context menu and dictionary management. */
interface SpellcheckBridge {
  /** Listen for context-menu events. Returns the listener ref for targeted cleanup. */
  onContextMenu(callback: (data: SpellcheckContextMenuData) => void): (...args: unknown[]) => void;
  /** Remove a specific context-menu listener. */
  offContextMenu(listener: (...args: unknown[]) => void): void;
  /** Replace the misspelled word under the cursor with the given word. */
  replaceMisspelling(word: string): Promise<void>;
  /** Add a word to the user's custom dictionary. */
  addToDictionary(word: string): Promise<void>;
  /** Paste from clipboard via Electron's native webContents.paste(). */
  paste(): Promise<void>;
}

/**
 * Thin bridge exposed by the Electron preload script for native
 * desktop operations that cannot go through the WebSocket transport
 * (file dialogs, clipboard, editor launching, etc.).
 */
interface DesktopBridge {
  /** Return the URL and IPC path of the local mcode server. */
  getServerUrl(): Promise<{ url: string; ipcPath: string }>;
  /** Open a native folder-picker dialog. Returns the selected path or null. */
  showOpenDialog(options: { title?: string }): Promise<string | null>;
  /** Launch an external editor at the given directory. */
  openInEditor(editor: string, dirPath: string): Promise<void>;
  /** Open the OS file explorer at the given directory. */
  openInExplorer(dirPath: string): Promise<void>;
  /** Open a URL in the default browser. */
  openExternalUrl(url: string): Promise<void>;
  /** Return a list of detected editor names on the system. */
  detectEditors(): Promise<string[]>;
  /** Read an image from the system clipboard. Returns metadata or null. */
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Save a clipboard file blob to disk. Returns metadata or null. */
  saveClipboardFile(buffer: Uint8Array, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
  /** Return the file path for logging output. */
  getLogPath(): Promise<string>;
  /** Return recent log lines. */
  getRecentLogs(lines: number): Promise<string>;
  /** Map a browser File object to its real filesystem path. */
  getPathForFile(file: File): string;
  /** Clear Blink's in-memory resource caches (images, scripts, CSS).
   * Typically called after a thread switch to reclaim memory. */
  clearRendererCache(): void;
  /** Return total bytes held in Blink's resource cache. */
  getRendererCacheBytes(): number;
  /** Open settings.json in the OS default editor. Resolves to an empty string on success. */
  openSettingsFile(): Promise<string>;
  /** Open keybindings.json in the OS default editor. Creates the file if it doesn't exist. */
  openKeybindingsFile(): Promise<string>;
  /** Spellcheck context menu and dictionary management. */
  spellcheck: SpellcheckBridge;
  /** App version and auto-update controls. */
  app: AppBridge;
  /** IPC push transport relayed from the main process. */
  ipc: IpcBridge;
  /** Embedded site preview (desktop only). */
  preview: PreviewBridge;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
