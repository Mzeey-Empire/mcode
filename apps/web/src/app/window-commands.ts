import { registerCommand } from "@/lib/command-registry";
import type { SettingsSection } from "@/components/settings/settings-nav";
import type { DesktopWindowAction } from "@/transport/desktop-bridge";

type DesktopWindowBridge = NonNullable<Window["desktopBridge"]>["window"];

interface WindowCommand {
  readonly id: string;
  readonly title: string;
  readonly action: DesktopWindowAction;
  readonly developmentOnly?: boolean;
}

/** Palette commands that drive the native window through the desktop bridge. */
export const WINDOW_COMMANDS: readonly WindowCommand[] = [
  { id: "window.zoomIn", title: "Zoom In", action: "zoomIn" },
  { id: "window.zoomOut", title: "Zoom Out", action: "zoomOut" },
  { id: "window.zoomReset", title: "Actual Size", action: "zoomReset" },
  { id: "window.toggleFullScreen", title: "Toggle Full Screen", action: "toggleFullScreen" },
  // The main process ignores these outside development, so listing them in a
  // packaged build would offer commands that silently do nothing.
  { id: "window.reload", title: "Reload Window", action: "reload", developmentOnly: true },
  {
    id: "window.toggleDevTools",
    title: "Toggle Developer Tools",
    action: "toggleDevTools",
    developmentOnly: true,
  },
];

const SETTINGS_COMMANDS: readonly { id: string; title: string; section: SettingsSection }[] = [
  { id: "settings.keyboard", title: "Keyboard Settings", section: "keyboard" },
  { id: "settings.about", title: "About Mcode", section: "about" },
];

/** Register the native window commands. Desktop only; returns disposers. */
export function registerWindowCommands(
  desktopWindow: DesktopWindowBridge,
): (() => void)[] {
  return WINDOW_COMMANDS.filter(
    (command) => !command.developmentOnly || desktopWindow.isDevelopment,
  ).map((command) =>
    registerCommand({
      id: command.id,
      title: command.title,
      category: "View",
      handler: () => void desktopWindow.perform(command.action),
    }),
  );
}

/** Register palette shortcuts into specific Settings sections; returns disposers. */
export function registerSettingsSectionCommands(): (() => void)[] {
  return SETTINGS_COMMANDS.map((command) =>
    registerCommand({
      id: command.id,
      title: command.title,
      category: "General",
      handler: () =>
        window.dispatchEvent(
          new CustomEvent("mcode:open-settings", { detail: { section: command.section } }),
        ),
    }),
  );
}
