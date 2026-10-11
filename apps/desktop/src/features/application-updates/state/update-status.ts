/** IPC push channel used to broadcast update status to the renderer. */
export const UPDATE_STATUS_CHANNEL = "app:update-status";

/** Discriminated union describing the current state of the update workflow. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string; installWhenIdle: boolean }
  | { state: "error"; message: string; failedOperation: "check" | "download" | "install" };

/** Minimal window contract needed for status delivery and lifecycle focus. */
export interface ApplicationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    send(channel: string, status: UpdateStatus): void;
  };
}

/** Provides the live application windows used by the update feature. */
export interface ApplicationWindowProvider {
  getAllWindows(): readonly ApplicationWindow[];
  getFocusedWindow(): ApplicationWindow | null;
}

/** Owns the current status and its renderer broadcasts for one feature instance. */
export interface UpdateStatusState {
  get(): UpdateStatus;
  publish(status: UpdateStatus): void;
  /** Observe status transitions until the returned unsubscribe function is called. */
  subscribe(listener: (status: UpdateStatus) => void): () => void;
  initialize(): void;
  cleanup(): void;
}

/** Create isolated update status state bound to the supplied window provider. */
export function createUpdateStatusState(
  windows: ApplicationWindowProvider,
): UpdateStatusState {
  let lastStatus: UpdateStatus = { state: "idle" };
  let active = true;
  const listeners = new Set<(status: UpdateStatus) => void>();

  return {
    get: () => lastStatus,
    publish: (status) => {
      if (!active) return;
      lastStatus = status;
      for (const listener of listeners) listener(status);
      for (const win of windows.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(UPDATE_STATUS_CHANNEL, status);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    initialize: () => {
      active = true;
      lastStatus = { state: "idle" };
    },
    cleanup: () => {
      active = false;
    },
  };
}
