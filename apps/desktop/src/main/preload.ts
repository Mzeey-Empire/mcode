/**
 * Electron preload script.
 * Exposes the `desktopBridge` API to the renderer via contextBridge,
 * providing access to native OS features (dialogs, clipboard, editors)
 * and the server connection URL.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktopBridge", {
  /** Get the WebSocket URL (with auth token) and IPC path for connecting to the server. */
  getServerUrl: (): Promise<{ url: string; ipcPath: string }> => ipcRenderer.invoke("get-server-url"),

  /** Show a native open-directory dialog. Returns the selected path or null. */
  showOpenDialog: (opts: Record<string, unknown>): Promise<string | null> =>
    ipcRenderer.invoke("show-open-dialog", opts),

  /** Open a directory in the specified editor. */
  openInEditor: (editor: string, path: string): Promise<void> =>
    ipcRenderer.invoke("open-in-editor", editor, path),

  /** Open a directory in the system file explorer. */
  openInExplorer: (path: string): Promise<void> =>
    ipcRenderer.invoke("open-in-explorer", path),

  /** Open a URL in the default browser (https, http, mailto). */
  openExternalUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external-url", url),

  /** Detect which supported editors are installed. */
  detectEditors: (): Promise<string[]> => ipcRenderer.invoke("detect-editors"),

  /** Read an image from the clipboard and save it as a temp JPEG. */
  readClipboardImage: (): Promise<unknown> =>
    ipcRenderer.invoke("read-clipboard-image"),

  /** Save a file blob from the clipboard to a temp location. */
  saveClipboardFile: (buffer: Uint8Array, mimeType: string, fileName: string): Promise<unknown> =>
    ipcRenderer.invoke("save-clipboard-file", buffer, mimeType, fileName),

  /** Get the absolute path to the log directory. */
  getLogPath: (): Promise<string> => ipcRenderer.invoke("get-log-path"),

  /** Read the last N lines from the most recent log file. */
  getRecentLogs: (lines: number): Promise<string> =>
    ipcRenderer.invoke("get-recent-logs", lines),

  /** Resolve the native file path for a File object (drag-and-drop). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Clear Blink's in-memory resource caches (images, scripts, CSS).
   * Typically called after a thread switch to reclaim memory. */
  clearRendererCache: (): void => webFrame.clearCache(),

  /** Return total bytes held in Blink's resource cache (images, scripts, CSS, fonts). */
  getRendererCacheBytes: (): number => {
    const { images, scripts, cssStyleSheets, xslStyleSheets, fonts, other } =
      webFrame.getResourceUsage();
    return (
      images.size + scripts.size + cssStyleSheets.size +
      xslStyleSheets.size + fonts.size + other.size
    );
  },

  /** Open settings.json in the OS default editor. Resolves to an empty string on success. */
  openSettingsFile: (): Promise<string> =>
    ipcRenderer.invoke("open-settings-file"),

  /** Open keybindings.json in the OS default editor. Creates the file if it doesn't exist. */
  openKeybindingsFile: (): Promise<string> =>
    ipcRenderer.invoke("open-keybindings-file"),

  /** Spellcheck context menu and dictionary management. */
  spellcheck: {
    /** Listen for context-menu events with spelling data from the main process. Returns the listener reference for targeted cleanup. */
    onContextMenu(callback: (data: unknown) => void) {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on("spellcheck:context-menu", listener);
      return listener;
    },
    /** Remove a specific context-menu listener (avoids removing other listeners on the channel). */
    offContextMenu(listener: (...args: unknown[]) => void) {
      ipcRenderer.removeListener("spellcheck:context-menu", listener);
    },
    /** Replace the misspelled word under the cursor with the given word. */
    replaceMisspelling(word: string): Promise<void> {
      return ipcRenderer.invoke("spellcheck:replace-misspelling", word);
    },
    /** Add a word to the user's custom dictionary. */
    addToDictionary(word: string): Promise<void> {
      return ipcRenderer.invoke("spellcheck:add-to-dictionary", word);
    },
    /** Paste from clipboard via Electron's native webContents.paste(). */
    paste(): Promise<void> {
      return ipcRenderer.invoke("spellcheck:paste");
    },
  },

  /** App version and auto-update controls. */
  app: {
    /** Read the running app version (from package.json at build time). */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke("app:get-version");
    },
    /** Get the most recent update status without triggering a new check. */
    getUpdateStatus(): Promise<unknown> {
      return ipcRenderer.invoke("app:get-update-status");
    },
    /** Manually trigger a check for updates. Resolves with the resulting status. */
    checkForUpdates(): Promise<unknown> {
      return ipcRenderer.invoke("app:check-for-updates");
    },
    /** Quit and install a downloaded update. No-op if nothing is downloaded. */
    installUpdate(): Promise<void> {
      return ipcRenderer.invoke("app:install-update");
    },
    /** Subscribe to push updates of update-status. Returns the listener for cleanup. */
    onUpdateStatus(callback: (status: unknown) => void) {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("app:update-status", listener);
      return listener;
    },
    /** Remove a previously registered update-status listener. */
    offUpdateStatus(listener: (...args: unknown[]) => void) {
      ipcRenderer.removeListener("app:update-status", listener);
    },
  },

  /**
   * Embedded thread preview (Electron BrowserView). No-op channels in web builds
   * without this namespace; the renderer checks `desktopBridge?.preview` before use.
   */
  preview: {
    sync(payload: {
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number } | null;
      threadId?: string | null;
      resumeUrlHint?: string | null;
      workspaceId?: string | null;
    }): Promise<void> {
      return ipcRenderer.invoke("preview:sync", payload);
    },
    navigate(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
      return ipcRenderer.invoke("preview:navigate", url);
    },
    goBack(): Promise<boolean> {
      return ipcRenderer.invoke("preview:go-back");
    },
    goForward(): Promise<boolean> {
      return ipcRenderer.invoke("preview:go-forward");
    },
    reload(): Promise<void> {
      return ipcRenderer.invoke("preview:reload");
    },
    openExternal(): Promise<void> {
      return ipcRenderer.invoke("preview:open-external");
    },
    getNavigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
      return ipcRenderer.invoke("preview:get-navigation-state");
    },
    /** Capture the visible preview viewport as a PNG for attaching to the composer. */
    capturePictureReference(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-reference");
    },
    /** Drag to select a region; captures that part of the preview as PNG. */
    capturePictureReferenceRegion(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-region");
    },
    /** Hover to highlight, then click an element; captures its bounds as PNG with DOM context. */
    capturePictureReferenceElementPick(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-element-pick");
    },
    /** Structured page context for the composer fence without capturing a PNG. */
    capturePageContext(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-context-reference");
    },
    releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void> {
      return ipcRenderer.invoke("preview:release-browser-capture-spill", [...paths]);
    },
    onDidNavigate(callback: (payload: { url: string; title: string }) => void) {
      const listener = (_event: unknown, payload: { url: string; title: string }) =>
        callback(payload);
      ipcRenderer.on("preview:did-navigate", listener);
      return () => ipcRenderer.removeListener("preview:did-navigate", listener);
    },
    /** Subscribe to guest webContents loading spin (did-start / did-stop loading). */
    onLoadingState(callback: (payload: { loading: boolean }) => void) {
      const listener = (_event: unknown, payload: { loading: boolean }) => callback(payload);
      ipcRenderer.on("preview:loading-state", listener);
      return () => ipcRenderer.removeListener("preview:loading-state", listener);
    },
  },

  /** IPC push transport relayed from the main process. */
  ipc: {
    /** Listen for push messages forwarded by the main process IPC relay. */
    onPush(callback: (data: unknown) => void) {
      ipcRenderer.on("ipc-push-message", (_event: unknown, data: unknown) => callback(data));
    },
    /** Listen for IPC connection close events. */
    onDisconnect(callback: () => void) {
      ipcRenderer.on("ipc-push-disconnect", () => callback());
    },
    /** Remove all IPC push listeners. */
    off() {
      ipcRenderer.removeAllListeners("ipc-push-message");
      ipcRenderer.removeAllListeners("ipc-push-disconnect");
    },
  },
});
