// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings, type Settings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSettingsStore, type SettingsPatch } from "@/stores/settingsStore";
import { isLocalSettingsWriteInFlight, type LocalWriteScope } from "@/stores/settings-write-origin";
import { useTerminalSettingsStore } from "@/features/terminal/settings/terminalSettingsStore";
import { GENERAL } from "../sections/GeneralSection";
import { THREADS } from "../sections/ThreadsSection";
import { PROVIDERS } from "../sections/ProviderSection";
import { revertSourceOf, type RevertSource } from "../setting-value";
import { changedEntries, journalTransition, planRevert, type JournalEntry, type RevertibleDef } from "../settings-visit";
import type { SettingDef, SettingId } from "../setting-def";
import { mergeSettings, seedProviderAvailability } from "./settings-fixtures";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function revertible(def: SettingDef): RevertibleDef {
  if (def.value.kind !== "revertible") throw new Error(`${def.id} is not revertible`);
  return { ...def, value: def.value };
}

const THEME = revertible(GENERAL.theme);
const NOTIFICATIONS = revertible(GENERAL.notifications);
const MODEL = revertible(THREADS.model);
const REASONING = revertible(THREADS.reasoning);
const FAST = revertible(THREADS.fastMode);
const CLAUDE_ON = revertible(PROVIDERS["claude.enabled"]);
const CODEX_ON = revertible(PROVIDERS["codex.enabled"]);
const DEFS = [THEME, NOTIFICATIONS, MODEL, REASONING, FAST, CLAUDE_ON, CODEX_ON];

function source(patch: SettingsPatch = {}, base: Settings = getDefaultSettings()): RevertSource {
  return revertSourceOf(mergeSettings(base, patch), "workspace-1", null);
}

const EMPTY: ReadonlyMap<SettingId, JournalEntry> = new Map();
const OUTSIDE: readonly LocalWriteScope[] = [];

/** The in-flight local writes during a transition: one settings write of `patch`. */
function wrote(patch: SettingsPatch): readonly LocalWriteScope[] {
  return [{ sink: "settings", patch }];
}

describe("journalTransition", () => {
  it("records the source before the first local write and keeps it across later writes", () => {
    const a = source();
    const b = source({ appearance: { theme: "dark" } });
    const c = source({ appearance: { theme: "light" } });
    const once = journalTransition(EMPTY, DEFS, a, b, wrote({ appearance: { theme: "dark" } }));
    const twice = journalTransition(once, DEFS, b, c, wrote({ appearance: { theme: "light" } }));
    expect([...twice.keys()]).toEqual([THEME.id]);
    expect(twice.get(THEME.id)?.before).toBe(a);
  });

  it("drops a row an outside write changed and never adds one", () => {
    const a = source();
    const b = source({ appearance: { theme: "dark" } });
    const journal = journalTransition(EMPTY, DEFS, a, b, wrote({ appearance: { theme: "dark" } }));
    const pushed = source({ appearance: { theme: "light" }, notifications: { enabled: false } });
    expect(journalTransition(journal, DEFS, b, pushed, OUTSIDE).size).toBe(0);
  });

  it("keeps a claimed row that a local write changes again", () => {
    const a = source();
    const journal = journalTransition(EMPTY, DEFS, a, source({ appearance: { theme: "dark" } }), wrote({ appearance: { theme: "dark" } }));
    expect(journalTransition(journal, DEFS, source({ appearance: { theme: "dark" } }), a, wrote({ appearance: { theme: "system" } }))).toBe(journal);
  });

  it("releases a claimed row an outside write changed while a local write to another row is in flight", () => {
    const a = source();
    const dark = source({ appearance: { theme: "dark" } });
    const journal = journalTransition(EMPTY, DEFS, a, dark, wrote({ appearance: { theme: "dark" } }));
    const pushed = source({ appearance: { theme: "light" } });
    expect(journalTransition(journal, DEFS, dark, pushed, wrote({ notifications: { enabled: false } })).size).toBe(0);
  });

  it("claims a row its own local write changed while another local write is in flight", () => {
    const a = source();
    const dark = source({ appearance: { theme: "dark" } });
    const scopes = [...wrote({ notifications: { enabled: false } }), ...wrote({ appearance: { theme: "dark" } })];
    expect([...journalTransition(EMPTY, DEFS, a, dark, scopes).keys()]).toEqual([THEME.id]);
  });
});

describe("changedEntries", () => {
  it("leaves out a row the user changed back by hand", () => {
    const a = source();
    const journal = journalTransition(EMPTY, DEFS, a, source({ appearance: { theme: "dark" } }), wrote({ appearance: { theme: "dark" } }));
    expect(changedEntries(journal, a)).toEqual([]);
  });
});

describe("planRevert", () => {
  beforeEach(() => seedProviderAvailability());

  it("puts back the value an outside write left, not the value at page open", () => {
    const pushed = source({ appearance: { theme: "light" } });
    const journal = journalTransition(EMPTY, DEFS, pushed, source({ appearance: { theme: "dark" } }), wrote({ appearance: { theme: "dark" } }));
    const current = source({ appearance: { theme: "dark" } });
    const plan = planRevert(changedEntries(journal, current), current);
    expect(plan.batches).toEqual([{ step: { sink: "settings", patch: { appearance: { theme: "light" } } }, ids: [THEME.id] }]);
  });

  it("puts back provider, model, reasoning and Fast in one settings write", () => {
    const before = source({ model: { defaults: { provider: "claude", id: "claude-opus-4-8", reasoning: "high" } }, provider: { claude: { fastMode: true } } });
    const picked = source({ model: { defaults: { provider: "codex", id: "gpt-5", reasoning: "medium" } } }, before.settings);
    const current = source({ provider: { codex: { fastMode: true } } }, picked.settings);
    let journal = journalTransition(EMPTY, DEFS, before, picked, wrote({ model: { defaults: { provider: "codex", id: "gpt-5", reasoning: "medium" } } }));
    journal = journalTransition(journal, DEFS, picked, current, wrote({ provider: { codex: { fastMode: true } } }));
    const plan = planRevert(changedEntries(journal, current), current);
    expect(plan.blocked).toEqual([]);
    expect(plan.batches).toEqual([{
      step: { sink: "settings", patch: {
        model: { defaults: { provider: "claude", id: "claude-opus-4-8", reasoning: "high" } },
        provider: { claude: { fastMode: true }, codex: { fastMode: false } },
      } },
      ids: [MODEL.id, REASONING.id, FAST.id],
    }]);
  });

  it("refuses to turn off the last provider or a default provider and still writes the rest", () => {
    const allOff = Object.fromEntries(Object.keys(getDefaultSettings().provider.enabled).map((id) => [id, false]));
    const before = source({ provider: { enabled: allOff } });
    const current = source({ provider: { enabled: { claude: true } }, appearance: { theme: "dark" } }, before.settings);
    const journal = journalTransition(EMPTY, DEFS, before, current, wrote({ provider: { enabled: { claude: true } }, appearance: { theme: "dark" } }));
    const plan = planRevert(changedEntries(journal, current), current);
    expect(plan.blocked).toEqual([{ id: CLAUDE_ON.id, label: "Claude", reason: "at least one provider must stay on." }]);
    expect(plan.batches).toEqual([{ step: { sink: "settings", patch: { appearance: { theme: "system" } } }, ids: [THEME.id] }]);

    const codexOff = source({ provider: { enabled: { codex: false } } });
    const codexOn = source({ provider: { enabled: { codex: true } } }, codexOff.settings);
    const madeDefault = source({ model: { defaults: { provider: "codex" } } }, codexOn.settings);
    const defaultJournal = journalTransition(EMPTY, DEFS, codexOff, codexOn, wrote({ provider: { enabled: { codex: true } } }));
    expect(planRevert(changedEntries(defaultJournal, madeDefault), madeDefault).blocked).toEqual([
      { id: CODEX_ON.id, label: "Codex", reason: "Codex is a default provider." },
    ]);
  });
});

describe("planRevert default model", () => {
  beforeEach(() => seedProviderAvailability());

  it("refuses to put back a default model whose provider another window turned off", () => {
    const claude = source({ model: { defaults: { provider: "claude", id: "claude-opus-4-8" } } });
    const codex = source({ model: { defaults: { provider: "codex", id: "gpt-5" } } }, claude.settings);
    const journal = journalTransition(EMPTY, DEFS, claude, codex, wrote({ model: { defaults: { provider: "codex", id: "gpt-5" } } }));
    const claudeOff = source({ provider: { enabled: { claude: false } } }, codex.settings);

    const plan = planRevert(changedEntries(journal, claudeOff), claudeOff);
    expect(plan.blocked).toEqual([{ id: MODEL.id, label: "Provider and model", reason: "Claude is a default provider." }]);
    expect(plan.batches).toEqual([]);
  });
});

describe("local write tracking", () => {
  it("reports every settings writer as local while its request is in flight", async () => {
    let release: () => void = () => {};
    const pending = () => new Promise<never>((_, reject) => {
      release = () => reject(new Error("done"));
    });
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce(pending);
    vi.mocked(mockTransport.terminalPreferencesUpdate).mockImplementationOnce(pending);
    vi.mocked(mockTransport.terminalProfileSetDefault).mockImplementationOnce(pending);
    vi.mocked(mockTransport.terminalWorkspacePreferencesUpdate).mockImplementationOnce(pending);
    vi.mocked(mockTransport.terminalWorkspacePreferencesReset).mockImplementationOnce(pending);
    const terminal = useTerminalSettingsStore.getState();
    const writers = [
      () => useSettingsStore.getState().update({ appearance: { theme: "dark" } }),
      () => terminal.updatePreferences({ presentation: { fontSize: "lg" } }),
      () => terminal.setGlobalDefault("automatic"),
      () => terminal.setWorkspaceDefault("workspace-1", "automatic"),
      () => terminal.resetWorkspaceDefault("workspace-1"),
    ];
    for (const write of writers) {
      const done = write();
      expect(isLocalSettingsWriteInFlight()).toBe(true);
      release();
      await done;
      expect(isLocalSettingsWriteInFlight()).toBe(false);
    }
  });
});
