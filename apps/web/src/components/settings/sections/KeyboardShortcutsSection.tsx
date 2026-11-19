import { useMemo } from "react";
import { SettingsGroup } from "../SettingsGroup";
import { Setting, SettingRowFrame } from "../Setting";
import { settingsPage, type SettingRowProps } from "../setting-def";
import { notRevertible } from "../setting-value";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
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
        View all shortcuts
      </Button>
    </div>
  );
}

/** The path sits on its own line so the long file name reads as one unit instead of wrapping mid-sentence. */
function CustomKeybindingsRow({ def, variant }: SettingRowProps) {
  const hint = (
    <>
      Override default shortcuts by editing
      <span className="block font-mono text-fade">{KEYBINDINGS_PATH}</span>
    </>
  );
  return (
    <SettingRowFrame def={def} variant={variant} hint={hint}>
      <CustomKeybindingsControl />
    </SettingRowFrame>
  );
}

/** Settings on the Keyboard shortcuts page. Individual shortcuts are not settings; the command palette finds those. */
export const KEYBOARD = settingsPage("keyboard", {
  custom: {
    label: "Custom keybindings",
    hint: `Override default shortcuts by editing ${KEYBINDINGS_PATH}.`,
    synonyms: "keybindings json keyboard shortcuts hotkeys remap",
    value: notRevertible("Lives in keybindings.json, edited outside Mcode."),
    Row: CustomKeybindingsRow,
  },
});

/** One keycap per key, in the monospace face so a column of shortcuts lines up. */
function Keycaps({ keys }: { readonly keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((key, index) => (
        <kbd
          key={`${index}-${key}`}
          className="inline-grid h-6 min-w-6 place-items-center rounded-sm bg-ink/9 px-[0.7rem] font-mono text-compact leading-[1.6rem] text-ink/88 [font-variant-ligatures:none]"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** Settings section showing keyboard shortcuts and the path to the user override file. */
export function KeyboardShortcutsSection() {
  const boundCommands = useMemo(() => {
    const commands = getAllCommands().filter((c) => c.id !== "escape.handle");
    return commands.flatMap((command) => {
      const binding = getKeybindingForCommand(command.id);
      return binding ? [{ command, keys: keybindingKeycaps(binding.key, isMac) }] : [];
    });
  }, []);

  return (
    <div className="space-y-8">
      <SettingsGroup>
        <Setting def={KEYBOARD.custom} />
      </SettingsGroup>
      <section aria-label="Shortcuts" className="rounded-lg bg-panel inset-ring inset-ring-border">
        {boundCommands.map(({ command, keys }) => (
          <div key={command.id} className="flex h-9 items-center justify-between gap-6 px-4 text-body-small text-ink">
            <span className="min-w-0 text-fade">{command.title}</span>
            <Keycaps keys={keys} />
          </div>
        ))}
      </section>
    </div>
  );
}
