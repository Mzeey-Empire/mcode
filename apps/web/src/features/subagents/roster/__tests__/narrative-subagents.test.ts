import { describe, expect, it } from "vitest";
import type { CanonicalSubagentRosterRow } from "@mcode/contracts";
import type { ToolCallRecord } from "@/transport/types";
import {
  dedupeNarrativeRoster,
  narrativeRowStatus,
  resolveNarrativeSubagentSelection,
} from "../narrative-subagents";
import { projectSubagents } from "../subagent-projection";

function record(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, "id">): ToolCallRecord {
  return {
    message_id: "message-1",
    parent_tool_call_id: null,
    tool_name: "Agent",
    input_summary: "Delegate the task",
    output_summary: "Task finished",
    status: "completed",
    started_at: "2026-07-22T10:00:00.000Z",
    completed_at: "2026-07-22T10:01:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

function canonicalRow(
  overrides: Partial<CanonicalSubagentRosterRow> = {},
): CanonicalSubagentRosterRow {
  return {
    id: "canonical-child",
    parentThreadId: "thread-1",
    rootThreadId: "thread-1",
    owningParentThreadId: "thread-1",
    lineage: ["thread-1", "canonical-child"],
    activityState: "Idle",
    latestTurnStatus: "Completed",
    startedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:01:00.000Z",
    endedAt: "2026-07-22T10:01:00.000Z",
    terminalOutcome: "Completed",
    task: "Canonical task",
    identity: "Canonical worker",
    model: undefined,
    reasoning: undefined,
    providerIdentities: [],
    sourceProviderIdentities: [],
    hasActiveDescendant: false,
    canStop: false,
    ...overrides,
  };
}

function narrativeRoster(records: ToolCallRecord[]) {
  return projectSubagents([], [records]);
}

describe("dedupeNarrativeRoster", () => {
  it("keeps rows with no canonical representation", () => {
    const roster = narrativeRoster([
      record({ id: "agent-1", subagent_identity_key: "mcode:subagent:v1:alias:agent-1" }),
      record({ id: "child-1", parent_tool_call_id: "agent-1", tool_name: "Read", sort_order: 1 }),
    ]);

    const deduped = dedupeNarrativeRoster(roster, []);

    expect(deduped.finished.map((row) => row.id)).toEqual(["agent-1"]);
  });

  it("suppresses a row whose canonical-child target resolves in the roster", () => {
    const roster = narrativeRoster([
      record({
        id: "spawn-1",
        subagent_identity_key: "mcode:subagent:v1:child:canonical-child",
      }),
    ]);
    const canonicalRows = [canonicalRow({ id: "canonical-child" })];

    const deduped = dedupeNarrativeRoster(roster, canonicalRows);

    expect(deduped.finished).toEqual([]);
  });

  it("suppresses a row whose provider alias matches a canonical identity", () => {
    const roster = narrativeRoster([
      record({
        id: "spawn-2",
        subagent_identity_key: "mcode:subagent:v1:alias:native-worker",
      }),
    ]);
    const canonicalRows = [canonicalRow({
      id: "canonical-2",
      providerIdentities: [{ providerId: "codex", scope: "thread", value: "native-worker", provenance: "native" }],
    })];

    const deduped = dedupeNarrativeRoster(roster, canonicalRows);

    expect(deduped.finished).toEqual([]);
  });

  it("suppresses a row sourced by a canonical row's toolCall sourceItemId", () => {
    const roster = narrativeRoster([record({ id: "spawn-3" })]);
    const canonicalRows = [canonicalRow({ id: "canonical-3", sourceItemId: "toolCall:spawn-3" })];

    const deduped = dedupeNarrativeRoster(roster, canonicalRows);

    expect(deduped.finished).toEqual([]);
  });

  it("keeps a row when its canonical target is absent from the roster", () => {
    const roster = narrativeRoster([
      record({
        id: "spawn-4",
        subagent_identity_key: "mcode:subagent:v1:child:missing-child",
      }),
    ]);

    const deduped = dedupeNarrativeRoster(roster, []);

    expect(deduped.finished.map((row) => row.id)).toEqual(["spawn-4"]);
  });
});

describe("resolveNarrativeSubagentSelection", () => {
  it("resolves by row id", () => {
    const roster = narrativeRoster([record({ id: "agent-9" })]);

    expect(resolveNarrativeSubagentSelection("agent-9", roster)?.id).toBe("agent-9");
  });

  it("resolves by decoded alias identity", () => {
    const roster = narrativeRoster([
      record({ id: "agent-10", subagent_identity_key: "mcode:subagent:v1:alias:agent-10" }),
    ]);

    expect(resolveNarrativeSubagentSelection("agent-10", roster)?.id).toBe("agent-10");
  });

  it("returns undefined for an unknown selection", () => {
    const roster = narrativeRoster([record({ id: "agent-11" })]);

    expect(resolveNarrativeSubagentSelection("unknown", roster)).toBeUndefined();
  });
});

describe("narrativeRowStatus", () => {
  it("maps settled statuses to canonical labels", () => {
    expect(narrativeRowStatus(
      narrativeRoster([record({ id: "a", status: "failed" })]).finished[0]!,
    )).toBe("Failed");
    expect(narrativeRowStatus(
      narrativeRoster([record({ id: "b" })]).finished[0]!,
    )).toBe("Completed");
  });

  it("labels unfinished rows as active", () => {
    const roster = projectSubagents([
      { id: "live-agent", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
    ], []);

    expect(narrativeRowStatus(roster.active[0]!)).toBe("Active");
  });
});
