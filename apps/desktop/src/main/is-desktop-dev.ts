import { app } from "electron";

/**
 * True when the desktop app is running the dev orchestration flow
 * (`bun run dev:desktop`), which sets `ELECTRON_RENDERER_URL` to the Vite dev
 * server. Packaged installs and local `bun run prod` never set that variable.
 */
export function isDesktopDev(): boolean {
  return !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
}
