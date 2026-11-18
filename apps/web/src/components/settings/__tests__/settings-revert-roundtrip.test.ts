// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import type { SettingsPatch } from "@/stores/settingsStore";
import { SETTINGS_INDEX } from "../settings-nav";
import { revertSourceOf, type RestoreStep, type RevertSource } from "../setting-value";
import { mergeSettings } from "./settings-fixtures";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const cliPaths = Object.fromEntries(Object.keys(getDefaultSettings().provider.cli).map((id) => [id, `/opt/${id}`]));
const flipped = Object.fromEntries(Object.entries(getDefaultSettings().provider.enabled).map(([id, on]) => [id, !on]));

/** Every stored value a Settings row reads, changed from its default. A row this misses fails the first assertion. */
const ALTERED: SettingsPatch = {
  appearance: { theme: "dark" },
  notifications: { enabled: false },
  externalApps: { defaultEditor: "vscode" },
  diagnostics: { recording: false },
  graphics: { hardwareAcceleration: true },
  updates: { channel: "nightly", checkInterval: "1day", autoDownload: false, autoInstallOnQuit: false, providerCliChecks: false },
  model: { defaults: { provider: "codex", id: "gpt-5", reasoning: "low", thinking: true }, utility: { provider: "claude", id: "claude-haiku-4-5" } },
  agent: { defaults: { mode: "plan", permission: "supervised" } },
  thread: { olderAfterDays: 30, completion: { completeOnPrMerge: false, retentionDays: 30 } },
  provider: { enabled: flipped, cli: cliPaths, claude: { fastMode: true }, codex: { fastMode: true }, opencode: { serveUrl: "http://127.0.0.1:4096" } },
  terminal: {
    defaultProfileId: "certified:windows-cmd",
    presentation: { fontFamily: "Iosevka", fontSize: "xl", lineHeight: "relaxed", cursorStyle: "bar", cursorBlink: true, ligatures: true },
    behavior: { scrollback: 4000, sessionLimit: 2, confirmOnKill: "always", copyOnSelect: true, confirmMultilinePaste: false },
    accessibility: { screenReaderMode: "on" },
  },
};

function applyStep(source: RevertSource, step: RestoreStep): RevertSource {
  switch (step.sink) {
    case "settings":
      return { ...source, settings: mergeSettings(source.settings, step.patch) };
    case "terminalPreferences":
      return { ...source, settings: mergeSettings(source.settings, { terminal: step.patch }) };
    case "terminalGlobalDefault":
      return { ...source, settings: mergeSettings(source.settings, { terminal: { defaultProfileId: step.profileId } }) };
    case "terminalProjectDefault":
      return { ...source, projectDefault: { workspaceId: step.workspaceId, profileId: step.profileId } };
  }
}

describe("every revertible setting round-trips", () => {
  const a = revertSourceOf(getDefaultSettings(), "workspace-1", null);
  const b = revertSourceOf(mergeSettings(getDefaultSettings(), ALTERED), "workspace-1", { workspaceId: "workspace-1", defaultProfileId: "automatic" });
  const defs = SETTINGS_INDEX.map((entry) => entry.def).flatMap((def) => (def.value.kind === "revertible" ? [{ def, value: def.value }] : []));

  it.each(defs.map(({ def, value }) => [def.id, value] as const))("%s", (_id, value) => {
    expect(value.read(b)).not.toEqual(value.read(a));
    expect(value.read(applyStep(b, value.restore(a, b)))).toEqual(value.read(a));
  });
});
