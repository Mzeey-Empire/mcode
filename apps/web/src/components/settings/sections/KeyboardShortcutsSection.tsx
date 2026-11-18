import { useMemo } from "react";
import { SettingsGroup } from "../SettingsGroup";
import { Setting } from "../Setting";
import { settingsPage } from "../setting-def";
import { notRevertible } from "../setting-value";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { useToastStore } from "@/stores/toastStore";
import { isMac, isWindows } from "@/lib/platform";

const KEYBINDINGS_PATH = isWindows ? "%USERPROFILE%\\.mcode\\keybindings.json" : "~/.mcode/keybindings.json";

function openKeybindingsFile() {
  if (!window.desktopBridge) {
    useToastStore
      .getState()
      .show({
        kind: "failed",
        title: "Desktop integration unavailable",
        meta: "Keybindings cannot be opened in this environment",
      });
    return;
  }
  window.desktopBridge.openKeybindingsFile().catch((err) => {
    useToastStore
      .getState()
      .show({
        kind: "failed",
        title: "Could not open keybindings file",
        meta: String(err?.message ?? err),
      });
  });
}

function CustomKeybindingsControl() {
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen);
  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        size="compact"
        disabled={!window.desktopBridge}
        onClick={openKeybindingsFile}
      >
        Edit keybindings.json
      </Button>
      <Button
        variant="outline"
        size="compact"
        onClick={() => setShortcutHelpOpen(true)}
      >
        View All Shortcuts
      </Button>
    </div>
  );
}

/** Settings on the Keyboard shortcuts page. Individual shortcuts are not settings; the command palette finds those. */
export const KEYBOARD = settingsPage("keyboard", {
  custom: {
    label: "Custom keybindings",
    hint: `Override default shortcuts by editing ${KEYBINDINGS_PATH}.`,
    synonyms: "keybindings json keyboard shortcuts hotkeys remap",
    value: notRevertible("Lives in keybindings.json, edited outside Mcode."),
    Control: CustomKeybindingsControl,
  },
});

/** Settings section showing keyboard shortcuts and the path to the user override file. */
export function KeyboardShortcutsSection() {
  const boundCommands = useMemo(() => {
    const commands = getAllCommands().filter((c) => c.id !== "escape.handle");
    return commands.filter((c) => getKeybindingForCommand(c.id));
  }, []);

  return (
    <div>
      <SettingsGroup>
        <Setting def={KEYBOARD.custom} />
      </SettingsGroup>

      <div className="mt-8 space-y-1">
        {boundCommands.map((cmd) => {
          const binding = getKeybindingForCommand(cmd.id)!;
          return (
            <div
              key={cmd.id}
              className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm"
            >
              <span className="text-ink/80">{cmd.title}</span>
              <kbd className="rounded bg-hover px-2 py-0.5 text-xs font-medium text-muted">
                {formatKeybinding(binding.key, isMac)}
              </kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
}
