import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRoster, SubagentRosterEntry } from "@mcode/contracts";
import { pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSubagentRosterStore } from "../subagentRosterStore";

const transport = vi.hoisted(() => ({ loadSubagentRoster: vi.fn() }));
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => transport,
}));

function entry(overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return {
    id: "call:spawn-1", provider: "codex", title: "Inspect the build", prompt: null,
    subagentType: null, model: null, stepCount: 0, status: "running",
    startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "meta", canStop: false,
    sourceToolCallId: "spawn-1", childThreadId: null, sourceMessageId: "message-1", parentEntryId: null,
    ...overrides,
  };
}

function roster(revision: number, epoch = "boot-1", entries = [entry()]): SubagentRoster {
  return { owningParentThreadId: "parent", revision, epoch, entries, truncated: false };
}

describe("subagentRosterStore", () => {
  beforeEach(() => {
    transport.loadSubagentRoster.mockReset();
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    useConnectionStore.setState({ status: "connected" });
  });

  it("fetches once, ignores old pushes, and preserves ids through canonical enrichment", async () => {
    transport.loadSubagentRoster.mockResolvedValueOnce(roster(1)).mockResolvedValueOnce(
      roster(2, "boot-1", [entry({ childThreadId: "child-1", tier: "transcript", canStop: true })]),
    );
    const store = useSubagentRosterStore.getState();
    await Promise.all([store.ensure("parent"), store.ensure("parent")]);
    expect(transport.loadSubagentRoster.mock.calls).toEqual([["parent"]]);
    pushEmitter.emit("subagents.changed", { threadId: "parent", epoch: "boot-1", revision: 1 });
    expect(transport.loadSubagentRoster).toHaveBeenCalledTimes(1);
    pushEmitter.emit("subagents.changed", { threadId: "parent", epoch: "boot-1", revision: 2 });
    await store.refresh("parent");
    expect(store.entryForToolCall("parent", "spawn-1")).toEqual(entry({ childThreadId: "child-1", tier: "transcript", canStop: true }));
    expect(useSubagentRosterStore.getState().rosters.get("parent")?.revision).toBe(2);
  });

  it("refreshes on reconnect and accepts revision reset in a new boot", async () => {
    transport.loadSubagentRoster.mockResolvedValueOnce(roster(20)).mockResolvedValueOnce(roster(0, "boot-2"));
    await useSubagentRosterStore.getState().ensure("parent");
    useConnectionStore.setState({ status: "reconnecting" });
    useConnectionStore.setState({ status: "connected" });
    await useSubagentRosterStore.getState().refresh("parent");
    expect(transport.loadSubagentRoster.mock.calls).toEqual([["parent"], ["parent"]]);
    expect(useSubagentRosterStore.getState().rosters.get("parent")).toEqual(roster(0, "boot-2"));
    expect(useSubagentRosterStore.getState().entryForToolCall("parent", "spawn-1")?.id).toBe("call:spawn-1");
    pushEmitter.emit("subagents.changed", { threadId: "parent", epoch: "boot-1", revision: 99 });
    expect(transport.loadSubagentRoster).toHaveBeenCalledTimes(2);
  });

  it("retains the last good roster on failure and retries explicitly", async () => {
    transport.loadSubagentRoster.mockResolvedValueOnce(roster(1, "errors-boot"))
      .mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce(roster(2, "errors-boot"));
    await useSubagentRosterStore.getState().ensure("parent");
    await useSubagentRosterStore.getState().refresh("parent");
    expect(useSubagentRosterStore.getState().rosters.get("parent")).toEqual(roster(1, "errors-boot"));
    expect(useSubagentRosterStore.getState().errors.has("parent")).toBe(true);
    await useSubagentRosterStore.getState().refresh("parent");
    expect(useSubagentRosterStore.getState().errors.has("parent")).toBe(false);
    expect(useSubagentRosterStore.getState().rosters.get("parent")?.revision).toBe(2);
  });

  it("does not lose an invalidation arriving during a fetch", async () => {
    let finish: ((value: SubagentRoster) => void) | undefined;
    transport.loadSubagentRoster.mockReturnValueOnce(new Promise<SubagentRoster>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(roster(4, "race-boot"));
    const pending = useSubagentRosterStore.getState().ensure("parent");
    pushEmitter.emit("subagents.changed", { threadId: "parent", epoch: "race-boot", revision: 4 });
    finish?.(roster(3, "race-boot"));
    await pending;
    expect(transport.loadSubagentRoster).toHaveBeenCalledTimes(2);
    expect(useSubagentRosterStore.getState().rosters.get("parent")?.revision).toBe(4);
  });
});
