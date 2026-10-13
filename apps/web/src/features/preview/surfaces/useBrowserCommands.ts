import { useContext, useLayoutEffect, useRef } from "react";
import { registerCommand } from "@/lib/command-registry";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import type { BrowserCommandAction, BrowserCommandActions } from "./browserToolbarModel";

interface BrowserCommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly action: BrowserCommandAction;
}

/** Browser commands shared by keyboard bindings and the More menu. */
export const browserCommands = [
  { id: "preview.deviceToolbar.toggle", title: "Device toolbar", action: "deviceToolbar" },
  { id: "preview.guestDevTools.open", title: "Developer tools", action: "developerTools" },
  { id: "preview.forceReload", title: "Force reload", action: "forceReload" },
] as const satisfies readonly BrowserCommandDefinition[];

function enabledCommandKey(actions: BrowserCommandActions): string {
  return browserCommands
    .filter((command) => actions[command.action].kind === "enabled")
    .map((command) => command.id)
    .join(" ");
}

/** Registers enabled commands for the visible, uncovered Browser owner. */
export function useBrowserCommands({
  active,
  actions,
}: {
  /** Whether this owner is the visible, interactive Browser presentation. */
  readonly active: boolean;
  readonly actions: BrowserCommandActions;
}): void {
  const gateOpen = useContext(OverlayGateContext);
  const owns = active && gateOpen;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const enabledKey = owns ? enabledCommandKey(actions) : "";

  useLayoutEffect(() => {
    if (!enabledKey) return undefined;
    const enabledIds = new Set(enabledKey.split(" "));
    const disposers = browserCommands
      .filter((command) => enabledIds.has(command.id))
      .map((command) =>
        registerCommand({
          id: command.id,
          title: command.title,
          category: "Browser",
          handler: () => {
            const action = actionsRef.current[command.action];
            if (action.kind === "enabled") action.run();
          },
        }),
      );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [enabledKey]);
}
