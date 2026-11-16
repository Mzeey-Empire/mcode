import { BrowserWindow, ipcMain, nativeTheme, type BrowserWindow as BrowserWindowType } from "electron";

import { ThemeSchema, type Theme } from "@mcode/contracts/models/settings";
import { logger } from "@mcode/shared";

import {
  attachCloseGuard,
  type CloseGuardDependencies,
} from "./lifecycle/close-guard.js";
import {
  createWindow,
  type DesktopWindowLifecycleHooks,
} from "./lifecycle/create-window.js";
import {
  readWindowThemeHint,
  WINDOW_THEME_CHANNEL,
  windowBackgroundColor,
  writeWindowThemeHint,
} from "./lifecycle/window-theme.js";
import { configureApplicationMenu } from "./menu/application-menu.js";
import { registerDesktopWindowActionHandler } from "./actions/handlers.js";
import { installMainWindowNavigationPolicy } from "./navigation/main-window-policy.js";
import { registerThreadNotificationHandler } from "./notifications/handler.js";

/** Dependencies for the Desktop Window feature entry point. */
export interface DesktopWindowFeatureDependencies {
  /** Platform selected by the Electron composition root. */
  readonly platform: NodeJS.Platform;
  /** Product name for this build, such as "Mcode (Dev)". */
  readonly displayName: string;
  /** Return whether the desktop runs in development mode. */
  readonly isDesktopDev: () => boolean;
  /** Per-window Preview, Spellcheck, and Server Runtime operations. */
  readonly lifecycleHooks: DesktopWindowLifecycleHooks;
  /** Active-agent close confirmation dependencies. */
  readonly closeGuard: CloseGuardDependencies;
  /** Theme preference file the main process reads before the renderer can read localStorage. */
  readonly windowThemeHintPath: string;
}

/** The public operations provided by the Desktop Window feature. */
export interface DesktopWindowFeature {
  /** Return the live main window, or null once it has closed. */
  readonly getMainWindow: () => BrowserWindowType | null;
  /** Create and install one main window. */
  readonly createWindow: () => BrowserWindowType;
  /** Recreate the main window only when no window exists. */
  readonly recreateWindowIfNeeded: () => BrowserWindowType | null;
}

/** Return the icon path owned by the Desktop Window feature. */
export { getWindowIconPath } from "./lifecycle/icon-path.js";

/** Create the Desktop Window feature and register its native capabilities. */
export function createDesktopWindowFeature(
  dependencies: DesktopWindowFeatureDependencies,
): DesktopWindowFeature {
  let mainWindow: BrowserWindowType | null = null;

  configureApplicationMenu({
    platform: dependencies.platform,
    displayName: dependencies.displayName,
    getMainWindow: () => mainWindow,
  });
  registerDesktopWindowActionHandler();
  registerThreadNotificationHandler(() => mainWindow);
  // Held in memory so a window re-created before the hint write lands still opens in the latest theme.
  let theme: Theme | null = null;
  // The preference the hint file holds once queued writes land, or null when the latest write failed.
  let savedTheme: Theme | null = null;
  let latestWrite = 0;
  const currentTheme = (): Theme => {
    if (theme === null) theme = savedTheme = readWindowThemeHint(dependencies.windowThemeHintPath);
    return theme;
  };
  const currentBackground = (): string =>
    windowBackgroundColor(currentTheme(), nativeTheme.shouldUseDarkColors);

  ipcMain.on(WINDOW_THEME_CHANNEL, (event, reported: unknown) => {
    const parsed = ThemeSchema.safeParse(reported);
    if (!mainWindow || event.sender !== mainWindow.webContents || !parsed.success) return;
    // Loads savedTheme from the hint file before the report is compared with it.
    currentTheme();
    theme = parsed.data;
    mainWindow.setBackgroundColor(currentBackground());
    if (parsed.data === savedTheme) return;
    savedTheme = parsed.data;
    const write = ++latestWrite;
    writeWindowThemeHint(dependencies.windowThemeHintPath, parsed.data).catch((error: unknown) => {
      // Writes run in order, so a newer queued write still decides what the file holds.
      if (write === latestWrite) savedTheme = null;
      logger.warn("Window theme hint write failed", { error: String(error) });
    });
  });
  nativeTheme.on("updated", () => {
    if (currentTheme() === "system") mainWindow?.setBackgroundColor(currentBackground());
  });

  const create = (): BrowserWindowType => {
    const window = createWindow({
      platform: dependencies.platform,
      displayName: dependencies.displayName,
      isDesktopDev: dependencies.isDesktopDev,
      backgroundColor: currentBackground(),
      hooks: dependencies.lifecycleHooks,
    });
    installMainWindowNavigationPolicy(window);
    attachCloseGuard(window, dependencies.closeGuard);
    mainWindow = window;
    window.once("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    return window;
  };

  return {
    getMainWindow: () => mainWindow,
    createWindow: create,
    recreateWindowIfNeeded: () => {
      if (BrowserWindow.getAllWindows().length > 0) return null;
      return create();
    },
  };
}

export {
  openExternalUrl,
  registerExternalUrlHandler,
} from "./navigation/external-url.js";
export type {
  WorkspacePreviewUrlResolution,
  WorkspacePreviewUrlResolver,
} from "./navigation/external-url.js";
export { installMainWindowNavigationPolicy } from "./navigation/main-window-policy.js";
export {
  DESKTOP_WINDOW_ACTIONS,
  performDesktopWindowAction,
} from "./actions/window-actions.js";
export type { DesktopWindowAction } from "./actions/window-actions.js";
export { registerDesktopWindowActionHandler } from "./actions/handlers.js";
export { configureApplicationMenu } from "./menu/application-menu.js";
export type {
  ApplicationMenuApi,
  ApplicationMenuOptions,
} from "./menu/application-menu.js";
export { sendDesktopRendererCommand } from "./menu/renderer-commands.js";
export type {
  DesktopRendererCommand,
  RendererCommandWindowLookup,
} from "./menu/renderer-commands.js";
export type {
  CloseGuardDependencies,
  CloseGuardMessageBoxOptions,
} from "./lifecycle/close-guard.js";
export { attachCloseGuard } from "./lifecycle/close-guard.js";
export { createWindow } from "./lifecycle/create-window.js";
export type {
  CreateWindowDependencies,
  DesktopWindowLifecycleHooks,
} from "./lifecycle/create-window.js";
