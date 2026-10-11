import { create } from "zustand";
import type { UpdateStatus } from "@/transport/desktop-bridge";

interface UpdateState {
  /** App version reported by the Electron main process. Empty until hydrated. */
  version: string;
  /** Most recent auto-updater status pushed from the main process. */
  status: UpdateStatus;
  /**
   * Version of the update in flight. The downloading status carries no version,
   * so the button remembers it from the last available or downloaded status.
   */
  pendingVersion: string | null;
  /** Replace the version string. Called once at startup. */
  setVersion: (version: string) => void;
  /** Replace the current update status. Called by the IPC listener. */
  setStatus: (status: UpdateStatus) => void;
}

function pendingVersionFor(status: UpdateStatus, previous: string | null): string | null {
  switch (status.state) {
    case "available":
    case "downloaded":
      return status.version;
    case "downloading":
    case "error":
      return previous;
    default:
      return null;
  }
}

/**
 * Zustand store tracking the running app version and the auto-updater
 * lifecycle. Hydrated from the Electron preload bridge on startup; updated
 * via push events on the `app:update-status` IPC channel.
 */
export const useUpdateStore = create<UpdateState>((set) => ({
  version: "",
  status: { state: "idle" },
  pendingVersion: null,
  setVersion: (version) => set({ version }),
  setStatus: (status) => set((state) => ({ status, pendingVersion: pendingVersionFor(status, state.pendingVersion) })),
}));
