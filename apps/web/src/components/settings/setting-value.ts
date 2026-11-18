import type { Settings } from "@mcode/contracts/models/settings";
import type { TerminalProfileReference } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate, TerminalSettings } from "@mcode/contracts/models/terminal-settings";
import { getCatalogEntry } from "@mcode/contracts/providers/catalog";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { useSettingsStore, type SettingsPatch } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalSettingsStore, type TerminalWorkspaceOverride } from "@/features/terminal/settings/terminalSettingsStore";

/** Project default profile for the active project; profileId null means "inherits the global default". */
export interface ProjectDefaultSource {
  readonly workspaceId: string | null;
  readonly profileId: TerminalProfileReference | null;
}

/** Everything a setting's value can be read from. Built from three stores; immutable references, so keeping one is cheap. */
export interface RevertSource {
  readonly settings: Settings;
  readonly projectDefault: ProjectDefaultSource;
}

/**
 * One write that puts a value back. Each sink is one existing store action, and each of those actions runs inside
 * trackLocalSettingsWrite; a new sink needs the same, or the visit cannot see its writes.
 */
export type RestoreStep =
  | {
      readonly sink: "settings";
      readonly patch: SettingsPatch;
      /** Reason the merged result must not be written (last enabled provider, default provider), or null. */
      readonly blockedBy?: (next: Settings) => string | null;
    }
  | { readonly sink: "terminalPreferences"; readonly patch: TerminalPreferencesUpdate }
  | { readonly sink: "terminalGlobalDefault"; readonly profileId: TerminalProfileReference }
  // Null workspace: the value was read with no project open, so there is no project to write it to.
  | { readonly sink: "terminalProjectDefault"; readonly workspaceId: string | null; readonly profileId: TerminalProfileReference | null };

/** How Revert reads and restores one setting. `read` returns plain data compared structurally. */
export interface RevertibleValue {
  readonly kind: "revertible";
  read(source: RevertSource): unknown;
  /** The write that makes read(current) equal read(before). */
  restore(before: RevertSource, current: RevertSource): RestoreStep;
}

/** A row Revert never touches, with the reason kept beside the definition. */
export interface NotRevertible {
  readonly kind: "notRevertible";
  readonly reason: string;
}

/** How Revert treats one setting row. */
export type SettingValue = RevertibleValue | NotRevertible;

/** A main-settings value. `read` and `patch` must address the same fields; the round-trip test checks it. */
export function settingsValue<V>(
  read: (settings: Settings) => V,
  patch: (value: V) => SettingsPatch,
  blockedBy?: (next: Settings) => string | null,
): RevertibleValue {
  return {
    kind: "revertible",
    read: (source) => read(source.settings),
    restore: (before) => ({ sink: "settings", patch: patch(read(before.settings)), ...(blockedBy && { blockedBy }) }),
  };
}

/** A Terminal preference (presentation, behaviour, accessibility), written through updatePreferences. */
export function terminalPreferenceValue<V>(
  read: (terminal: TerminalSettings) => V,
  patch: (value: V) => TerminalPreferencesUpdate,
): RevertibleValue {
  return {
    kind: "revertible",
    read: (source) => read(source.settings.terminal),
    restore: (before) => ({ sink: "terminalPreferences", patch: patch(read(before.settings.terminal)) }),
  };
}

/** Global default profile: reads settings.terminal.defaultProfileId, restores through setGlobalDefault. */
export function terminalGlobalDefaultValue(): RevertibleValue {
  return {
    kind: "revertible",
    read: (source) => source.settings.terminal.defaultProfileId,
    restore: (before) => ({ sink: "terminalGlobalDefault", profileId: before.settings.terminal.defaultProfileId }),
  };
}

/** Shared definition for the Terminal page's global default profile row. */
export const TERMINAL_GLOBAL_DEFAULT = terminalGlobalDefaultValue();

/** Project default profile: restores through setWorkspaceDefault, or resetWorkspaceDefault for null, on the workspace it was read from. */
export function terminalProjectDefaultValue(): RevertibleValue {
  return {
    kind: "revertible",
    read: (source) => source.projectDefault.profileId,
    restore: (before) => ({ sink: "terminalProjectDefault", ...before.projectDefault }),
  };
}

/** Shared definition for the Terminal page's project default profile row. */
export const TERMINAL_PROJECT_DEFAULT = terminalProjectDefaultValue();

function providerEnabledBlock(next: Settings): string | null {
  const adapterBacked = useProviderAvailabilityStore.getState().providers.filter((row) => row.hasAdapter);
  if (adapterBacked.length > 0 && !adapterBacked.some((row) => next.provider.enabled[row.id])) {
    return "at least one provider must stay on.";
  }
  for (const id of [next.model.defaults.provider, next.model.utility.provider]) {
    if (id !== "" && !next.provider.enabled[id]) return `${getCatalogEntry(id).name} is a default provider.`;
  }
  return null;
}

/** Provider enable flag; blockedBy refuses a result with no adapter-backed provider on, or with a default provider off. */
export function providerEnabledValue(id: ProviderId): RevertibleValue {
  return settingsValue((s) => s.provider.enabled[id], (value) => ({ provider: { enabled: { [id]: value } } }), providerEnabledBlock);
}

/** Marks a row Revert never touches. */
export function notRevertible(reason: string): NotRevertible {
  return { kind: "notRevertible", reason };
}

/** Builds a source from the three store values it depends on. */
export function revertSourceOf(
  settings: Settings,
  activeWorkspaceId: string | null,
  override: TerminalWorkspaceOverride | null,
): RevertSource {
  const profileId = override !== null && override.workspaceId === activeWorkspaceId ? override.defaultProfileId : null;
  return { settings, projectDefault: { workspaceId: activeWorkspaceId, profileId } };
}

/** Current source from the settings, terminal settings and workspace stores. */
export function readRevertSource(): RevertSource {
  return revertSourceOf(
    useSettingsStore.getState().settings,
    useWorkspaceStore.getState().activeWorkspaceId,
    useTerminalSettingsStore.getState().workspaceOverride,
  );
}
