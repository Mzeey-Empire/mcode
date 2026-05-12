import type { AttachmentMeta } from "./types";
import type { McodeBrowserCapture, PreviewDeviceEmulationConfig } from "@mcode/contracts";

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
  /** Quit and install a downloaded update. Returns false if nothing to install. */
  installUpdate(): Promise<boolean>;
  /** Trigger download of a discovered update (when auto-download is off). */
  downloadUpdate(): Promise<void>;
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

/** Result of a preview navigation attempt (http, https, and local file paths). */
export type PreviewNavigateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Result of capturing the embedded preview viewport as a PNG for the composer. */
export type PreviewPictureReferenceResult =
  | {
      readonly ok: true;
      readonly meta: AttachmentMeta;
      readonly previewBytes: Uint8Array;
      readonly capture: McodeBrowserCapture;
    }
  | { readonly ok: false; readonly error: string };

/** Result of capturing preview page context without a PNG (desktop only). */
export type PreviewContextReferenceResult =
  | { readonly ok: true; readonly capture: McodeBrowserCapture }
  | { readonly ok: false; readonly error: string };

/** Embedded thread preview backed by an Electron BrowserView. */
interface PreviewBridge {
  sync(payload: {
    visible: boolean;
    bounds: PreviewShellBounds | null;
    threadId?: string | null;
    resumeUrlHint?: string | null;
    /** Active workspace id; scopes preview spill files under the Mcode app data directory. */
    workspaceId?: string | null;
    /** Mobile or custom viewport emulation for this thread's guest surface. */
    deviceEmulation?: PreviewDeviceEmulationConfig;
  }): Promise<void>;
  navigate(url: string, workspacePath?: string | null): Promise<PreviewNavigateResult>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  reload(): Promise<void>;
  openExternal(): Promise<void>;
  getNavigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
  /** Moves keyboard focus into the guest page (desktop only). */
  focusGuest(): Promise<void>;
  /** Captures the visible preview as PNG; desktop only. */
  capturePictureReference(): Promise<PreviewPictureReferenceResult>;
  /** Drag a rectangle on the preview, then capture that region as PNG; desktop only. */
  capturePictureReferenceRegion(): Promise<PreviewPictureReferenceResult>;
  /** Pick an element by hover and click; captures its box as PNG with selector and excerpt; desktop only. */
  capturePictureReferenceElementPick(): Promise<PreviewPictureReferenceResult>;
  /**
   * Captures structured page context (v2) without a screenshot. Desktop only.
   */
  capturePageContext(): Promise<PreviewContextReferenceResult>;
  /** Deletes workspace-relative preview spill files after the message was sent or the queue dropped them. */
  releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void>;
  onDidNavigate(callback: (payload: { url: string; title: string; favicon?: string | null }) => void): () => void;
  /** Guest load lifecycle for shell chrome (BrowserView covers the surface div). */
  onLoadingState(callback: (payload: { loading: boolean }) => void): () => void;
  /** Subscribe to favicon updates from the guest webContents. */
  onDidUpdateFavicon(callback: (payload: { favicon: string | null }) => void): () => void;
  /** Cancel any in-progress capture operation (region or element-pick). */
  cancelCapture(): Promise<void>;
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
