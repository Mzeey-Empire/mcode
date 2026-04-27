import { create } from "zustand";
import type { UpdateStatus } from "@/transport/desktop-bridge";

interface UpdateState {
  /** App version reported by the Electron main process. Empty until hydrated. */
  version: string;
  /** Whether the user has dismissed the in-app update banner for this session. */
  bannerDismissed: boolean;
  /** Most recent auto-updater status pushed from the main process. */
  status: UpdateStatus;
  /** Replace the version string. Called once at startup. */
  setVersion: (version: string) => void;
  /** Replace the current update status. Called by the IPC listener. */
  setStatus: (status: UpdateStatus) => void;
  /** Hide the banner for the rest of this session (resets when a new state arrives). */
  dismissBanner: () => void;
}

/**
 * Zustand store tracking the running app version and the auto-updater
 * lifecycle. Hydrated from the Electron preload bridge on startup; updated
 * via push events on the `app:update-status` IPC channel.
 */
export const useUpdateStore = create<UpdateState>((set) => ({
  version: "",
  bannerDismissed: false,
  status: { state: "idle" },
  setVersion: (version) => set({ version }),
  setStatus: (status) => set({ status }),
  dismissBanner: () => set({ bannerDismissed: true }),
}));
