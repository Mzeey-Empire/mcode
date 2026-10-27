import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import type { AgentItem, CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { SUBAGENT_REPORTING } from "@mcode/contracts/providers/interfaces";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ToolCallRecordStore, type CreateToolCallRecordInput } from "../../tools/persistence/tool-call-record-store.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { ProviderRegistry } from "../../../providers/composition/provider-registry.js";
import { SubagentRosterService } from "../../collaboration/subagent-roster-service.js";
import { subagentStatusFrom } from "../../collaboration/subagent-roster-projection.js";
import type { SubagentLifecycleDurability } from "../../collaboration/subagent-lifecycle-durability.js";
import type { CanonicalChildRow } from "../../canonical/canonical-child-roster.js";
import * as push from "../../../../application/transport/push.js";

const NOW = "2026-10-10T10:00:00.000Z";
const request = { owningParentThreadId: "parent" };

function message(db: Database, id: string, provider: ProviderId | null, outcome: string | null = null): void {
  db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, provider, outcome) VALUES (?, 'parent', 'assistant', '', ?, (SELECT count(*) FROM messages), ?, ?)")
    .run(id, NOW, provider, outcome);
}

function harness(provider: ProviderId = "claude", reporting = SUBAGENT_REPORTING) {
  const db = openAgentStorageTestDatabase();
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('workspace', 'Fixture', '.dev/fixture-repo', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES ('parent', 'workspace', 'Fixture', 'main', ?, ?, ?)").run(provider, NOW, NOW);
  const writer = agentStorageTestWriter(db);
  const narrative = new NarrativeStore(new MessageRepo(db, writer), new ToolCallRecordRepo(db, writer),
    new ThoughtSegmentRepo(db, writer), new HookExecutionRepo(db, writer), db);
  const children: CanonicalChildRow[] = [];
  const durability: SubagentLifecycleDurability = {
    loadSubagentRoster: () => ({ owningParentThreadId: "parent", rosterRevision: 0, active: children, done: [] }),
    loadSubagentStopTarget: () => null,
    loadActiveSubagentStopTargets: () => [],
    interruptSubagentTurns: async () => undefined,
    finishSubagentTurn: async () => ({ status: "Interrupted" }),
  };
  const service = new SubagentRosterService(durability, new ProviderRegistry([]), narrative, db, reporting);
  const records = new ToolCallRecordStore(db);
  const call = (id: string, messageId: string, options: Partial<CreateToolCallRecordInput> = {}) => records.create({
    toolCallId: id, messageId, toolName: "Agent", displayName: "Inspect", inputSummary: "Inspect the build",
    outputSummary: "", status: "running", startedAt: NOW, sortOrder: 0, ...options,
  });
  return { db, narrative, service, children, call, durability };
}

function child(sourceItemId?: string): CanonicalChildRow {
  return {
    id: "child-1", provider: "codex", stepCount: 0, parentThreadId: "parent", rootThreadId: "parent",
    owningParentThreadId: "parent", lineage: ["parent", "child-1"], activityState: "Active",
    latestTurnStatus: "Running", startedAt: NOW, updatedAt: NOW, endedAt: null, terminalOutcome: null,
    sourceItemId, task: "Inspect", providerIdentities: [], sourceProviderIdentities: [], hasActiveDescendant: false, canStop: false,
  };
}

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await closeAgentStorageTestDatabases(); });

describe("SubagentRosterService", () => {
  it("projects one Copilot row with child steps and its task summary", () => {
    const { db, call, service } = harness("copilot");
    message(db, "message", "copilot");
    call("task", "message", { subagentPrompt: "Inspect the implementation", subagentType: "explore", status: "completed", outputSummary: "Found the export" });
    call("read", "message", { toolName: "Read", parentToolCallId: "task", status: "completed", sortOrder: 1 });
    call("grep", "message", { toolName: "Grep", parentToolCallId: "task", status: "completed", sortOrder: 2 });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.provider, row.tier, row.stepCount, row.status, row.prompt, row.subagentType])).toEqual([
      ["call:task", "copilot", "steps", 2, "done", "Inspect the implementation", "explore"],
    ]);
    const detail = service.loadDetail({ ...request, entryId: "call:task" });
    expect(detail.steps.map((step) => [step.toolCallId, step.status])).toEqual([["read", "done"], ["grep", "done"]]);
    expect(detail.summary).toBe("Found the export");
  });

  it("reads a snake_case task name as words in the title and keeps prose titles as written", () => {
    const { db, call, service } = harness("copilot");
    message(db, "message", "copilot");
    call("named", "message", { inputSummary: "verify_ui_child", status: "completed" });
    call("prose", "message", { inputSummary: "Inspect the build_log", status: "completed", sortOrder: 1 });
    expect(service.loadRoster(request).entries.map((row) => row.title)).toEqual(["Verify ui child", "Inspect the build_log"]);
  });

  it("reports the model and reasoning effort as separate fields", () => {
    const { db, call, service } = harness("copilot");
    message(db, "message", "copilot");
    call("tuned", "message", { model: "gpt-5.6-sol", reasoningEffort: "high", status: "completed" });
    call("plain", "message", { status: "completed", sortOrder: 1 });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.model, row.reasoningEffort]).sort()).toEqual([
      ["call:plain", null, null], ["call:tuned", "gpt-5.6-sol", "high"],
    ]);
  });

  it.each([true, false])("uses OpenCode childSteps=%s only when there are no recorded steps", (childSteps) => {
    const { db, call, service } = harness("opencode", { ...SUBAGENT_REPORTING, opencode: { childTranscript: false, childSteps } });
    message(db, "message", "opencode");
    call("task", "message");
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.tier, row.stepCount])).toEqual([
      ["call:task", childSteps ? "steps" : "meta", 0],
    ]);
    if (!childSteps) expect(() => service.loadDetail({ ...request, entryId: "call:task" })).toThrow();
    call("read", "message", { toolName: "Read", parentToolCallId: "task", status: "completed" });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.tier, row.stepCount])).toEqual([["call:task", "steps", 1]]);
  });

  it("falls back to the thread provider for legacy message providers", () => {
    const { db, call, service } = harness("claude");
    message(db, "legacy", null);
    message(db, "known", "codex");
    db.prepare("UPDATE messages SET provider = ? WHERE id = ?").run("retired-provider", "legacy");
    call("legacy-call", "legacy");
    call("known-call", "known");
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.provider, row.tier])).toEqual([
      ["call:known-call", "codex", "meta"], ["call:legacy-call", "claude", "steps"],
    ]);
    expect(service.loadDetail({ ...request, entryId: "call:legacy-call" })).toEqual({
      entryId: "call:legacy-call", totalSteps: 0, steps: [], summary: null,
    });
  });

  it("reports a missing parent without leaking a schema validation error", () => {
    const { service } = harness();
    expect(() => service.loadRoster({ owningParentThreadId: "missing" })).toThrow(/parent thread not found/i);
  });

  it("keeps unknown persisted statuses out of the active count", () => {
    const { db, call, service } = harness();
    message(db, "message", "claude");
    call("unknown", "message");
    db.prepare("UPDATE tool_call_records SET status = ? WHERE id = ?").run("legacy-status", "unknown");
    expect(service.loadRoster(request).entries.map((row) => row.status)).toEqual(["failed"]);
    db.prepare("UPDATE messages SET outcome = 'cancelled' WHERE id = ?").run("message");
    expect(service.loadRoster(request).entries.map((row) => row.status)).toEqual(["stopped"]);
  });

  it("invalidates on turn completion without hydrating historical calls", () => {
    const { db, call, narrative, service } = harness();
    message(db, "message", "claude");
    call("unrelated", "message", { toolName: "Read" });
    const load = vi.spyOn(narrative, "loadSubagentCalls");
    service.turnFinished("parent");
    expect(load).not.toHaveBeenCalled();
    expect(service.loadRoster(request).revision).toBe(0);
    call("agent", "message");
    load.mockClear();
    service.turnFinished("parent");
    expect(load).not.toHaveBeenCalled();
    expect(service.loadRoster(request).revision).toBe(1);
  });

  it("releases stop markers after persistence while retaining unsaved stops", async () => {
    const { db, call, narrative, service } = harness();
    message(db, "message", "claude");
    call("saved", "message");
    narrative.beginTurn("parent");
    narrative.bufferToolCall("parent", { toolCallId: "unsaved", toolName: "Agent", toolInput: {} });
    await service.stopDescendants("parent");
    expect(service.loadRoster(request).entries.map((row) => row.status)).toEqual(["stopped", "stopped"]);
    db.prepare("UPDATE tool_call_records SET status = 'completed' WHERE id = ?").run("saved");
    service.turnFinished("parent");
    expect(service["stoppedCalls"].get("parent")).toEqual(new Set(["unsaved"]));
    call("unsaved", "message", { status: "failed" });
    db.prepare("UPDATE messages SET outcome = 'cancelled' WHERE id = ?").run("message");
    narrative.clearTurn("parent");
    service.turnFinished("parent");
    expect(service["stoppedCalls"].size).toBe(0);
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status])).toEqual([
      ["call:saved", "done"], ["call:unsaved", "stopped"],
    ]);
  });

  it("merges mixed providers, dedupes exact source calls, and preserves identity through enrichment", () => {
    const { db, call, children, service } = harness("codex");
    message(db, "claude-message", "claude");
    message(db, "codex-message", "codex");
    call("claude-call", "claude-message");
    call("spawn-1", "codex-message");
    expect(service.loadRoster(request).entries.map((row) => row.prompt)).toEqual([null, null]);
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.provider, row.tier])).toEqual([
      ["call:claude-call", "claude", "steps"], ["call:spawn-1", "codex", "meta"],
    ]);
    children.push(child("toolCall:spawn-1"));
    const after = service.loadRoster(request);
    expect(after.entries.map((row) => [row.id, row.provider, row.tier, row.childThreadId])).toEqual([
      ["call:claude-call", "claude", "steps", null], ["call:spawn-1", "codex", "transcript", "child-1"],
    ]);
    expect(service.loadRoster(request)).toEqual(after);
  });

  it("does not dedupe equal names and uses child identity when no source call exists", () => {
    const { db, call, children, service } = harness();
    message(db, "message", null);
    call("one", "message"); call("two", "message"); children.push(child());
    expect(service.loadRoster(request).entries.map((row) => row.id)).toEqual(["call:one", "call:two", "child:child-1"]);
  });

  it("collapses old Devin double calls and excludes Agent markers from steps without trusting fake nativeThreadId", () => {
    const { db, call, service } = harness("devin");
    message(db, "message", "devin");
    call("root", "message", { subagentIdentityKey: "canonical-alias:fake-native", subagentPrompt: "Inspect this" });
    call("lifecycle", "message", { parentToolCallId: "root", subagentIdentityKey: "canonical-alias:fake-native" });
    call("read", "message", { toolName: "Read", parentToolCallId: "lifecycle", status: "completed", inputSummary: "README.md" });
    expect(service.loadRoster(request).entries.map((row) => ({
      id: row.id, tier: row.tier, child: row.childThreadId, steps: row.stepCount,
    }))).toEqual([{ id: "call:root", tier: "steps", child: null, steps: 1 }]);
    expect(service.loadDetail({ ...request, entryId: "call:root" })).toEqual({
      entryId: "call:root", totalSteps: 1, summary: null,
      steps: [{ toolCallId: "read", toolName: "Read", label: "Inspect", status: "done" }],
    });
  });

  it("uses only persisted evidence for Copilot tiers and denies other parents' details", () => {
    const { db, call, children, service } = harness("copilot");
    message(db, "message", "copilot");
    call("empty", "message"); call("with-steps", "message");
    call("read", "message", { toolName: "Read", parentToolCallId: "with-steps" });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.tier, row.childThreadId])).toEqual([
      ["call:empty", "meta", null], ["call:with-steps", "steps", null],
    ]);
    expect(() => service.loadDetail({ ...request, entryId: "call:empty" })).toThrow();
    expect(() => service.loadDetail({ ...request, entryId: "call:foreign" })).toThrow();
    call("TOOL_6", "message", { subagentPrompt: "AGENT_9" });
    children.push({ ...child("toolCall:TOOL_6"), provider: "copilot" });
    expect(service.loadRoster(request).entries.find((row) => row.id === "call:TOOL_6"))
      .toMatchObject({ id: "call:TOOL_6", provider: "copilot", tier: "transcript", childThreadId: "child-1", prompt: "AGENT_9", canStop: false });
  });

  it("returns the last 32 steps in order and the root result summary", () => {
    const { db, call, service } = harness();
    message(db, "message", "claude");
    call("root", "message", { status: "completed", outputSummary: "Build repaired" });
    for (let index = 1; index <= 35; index++) call(`step-${index}`, "message", {
      toolName: "Read", parentToolCallId: "root", sortOrder: index, status: "completed",
    });
    const detail = service.loadDetail({ ...request, entryId: "call:root" });
    expect(detail.totalSteps).toBe(35);
    expect(detail.steps.map((step) => step.toolCallId)).toEqual([
      "step-4", "step-5", "step-6", "step-7", "step-8", "step-9", "step-10", "step-11",
      "step-12", "step-13", "step-14", "step-15", "step-16", "step-17", "step-18", "step-19",
      "step-20", "step-21", "step-22", "step-23", "step-24", "step-25", "step-26", "step-27",
      "step-28", "step-29", "step-30", "step-31", "step-32", "step-33", "step-34", "step-35",
    ]);
    expect(detail.summary).toBe("Build repaired");
  });

  it("marks unfinished work stopped after cancellation or parent stop, preserving completed work", async () => {
    const { db, call, service } = harness();
    message(db, "cancelled-message", "claude", "cancelled");
    message(db, "active-message", "claude");
    call("cancelled", "cancelled-message"); call("finished", "cancelled-message", { status: "completed" });
    call("active", "active-message");
    await service.stopDescendants("parent");
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status])).toEqual([
      ["call:active", "stopped"], ["call:cancelled", "stopped"], ["call:finished", "done"],
    ]);
  });

  it("orders running first and caps the final merged list at 256", () => {
    const { db, call, service } = harness();
    message(db, "message", "claude");
    for (let index = 0; index < 257; index++) call(String(index), "message", {
      startedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      status: index === 0 ? "running" : "completed",
    });
    const roster = service.loadRoster(request);
    expect(roster.entries).toHaveLength(256);
    expect(roster.entries.slice(0, 3).map((row) => row.id)).toEqual(["call:0", "call:256", "call:255"]);
    expect(roster.entries.at(-1)?.id).toBe("call:2");
    expect(roster.truncated).toBe(true);
  });

  it("bumps for Agent descendants, ignores unrelated calls, and leaves reads pure", () => {
    const { db, call, service } = harness();
    message(db, "message", "claude");
    call("root", "message"); call("read", "message", { toolName: "Read", parentToolCallId: "root" });
    call("unrelated", "message", { toolName: "Read" });
    service.toolChanged("parent", "unrelated");
    expect(service.loadRoster(request).revision).toBe(0);
    service.toolChanged("parent", "read");
    service.toolChanged("parent", "root");
    expect(service.loadRoster(request).revision).toBe(2);
    expect(service.loadRoster(request).revision).toBe(2);
  });

  it("bumps from saved narrative Agent calls and their steps, ignoring other committed items", () => {
    const { service } = harness();
    let deliver: ((events: readonly CanonicalAgentEventEnvelope[]) => void) | undefined;
    const stop = service.observeCommittedEvents((listener) => {
      deliver = listener;
      return () => { deliver = undefined; };
    });
    const saved = (threadId: string, item: Partial<AgentItem>): CanonicalAgentEventEnvelope => ({
      eventId: `event-${item.id}`, routing: { threadId, turnId: "turn", executionId: "execution" },
      sourceProviderId: "claude", sourceIdentities: [], acceptedSequence: 1, durableRevision: 1,
      serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
      payload: { type: "item.recorded", item: { id: "item", threadId, turnId: "turn", kind: "tool-call",
        providerIdentities: [], payload: {}, createdAt: NOW, updatedAt: NOW, ...item } },
    });
    const narrative = (toolName: string) => ({ projection: "narrativeRecovery", narrative: { kind: "toolCall", record: { tool_name: toolName } } });
    deliver?.([
      saved("parent", { id: "toolCall:read", payload: narrative("Read") }),
      saved("parent", { id: "toolCall:canonical", parentItemId: "toolCall:x", payload: { projection: "toolCall" } }),
      saved("parent", { id: "reasoning:thought", kind: "reasoning", parentItemId: "toolCall:x", payload: narrative("Agent") }),
    ]);
    expect(service.loadRoster(request).revision).toBe(0);
    deliver?.([
      saved("parent", { id: "toolCall:root", payload: narrative("Agent") }),
      saved("parent", { id: "toolCall:step", parentItemId: "toolCall:root", payload: narrative("Read") }),
    ]);
    expect(service.loadRoster(request).revision).toBe(1);
    deliver?.([saved("parent", { id: "toolCall:step", parentItemId: "toolCall:root", payload: narrative("Read") })]);
    expect(service.loadRoster(request).revision).toBe(2);
    stop();
    expect(deliver).toBeUndefined();
  });

  it("refreshes when a worker-owned turn's saved ending lands its Agent rows after the accepted release", () => {
    const { db, call, service } = harness();
    let deliver: ((events: readonly CanonicalAgentEventEnvelope[]) => void) | undefined;
    service.observeCommittedEvents((listener) => { deliver = listener; return () => undefined; });
    const committed = (payload: CanonicalAgentEventEnvelope["payload"]): CanonicalAgentEventEnvelope => ({
      eventId: `event-${payload.type}`, routing: { threadId: "parent", turnId: "turn", executionId: "execution" },
      sourceProviderId: "claude", sourceIdentities: [], acceptedSequence: 1, durableRevision: 1,
      serverTimestamps: { acceptedAt: NOW, persistedAt: NOW }, payload,
    });
    service.turnFinished("parent");
    expect(service.loadRoster(request).revision).toBe(0);
    message(db, "message", "claude");
    call("background", "message");
    deliver?.([committed({ type: "turn.started", startedAt: NOW })]);
    expect(service.loadRoster(request).revision).toBe(0);
    deliver?.([committed({ type: "turn.completed", endedAt: NOW })]);
    expect(service.loadRoster(request)).toMatchObject({ revision: 1, entries: [{ sourceToolCallId: "background", status: "running" }] });
    const late = (toolName: string): CanonicalAgentEventEnvelope => committed({ type: "item.recorded", item: {
      id: "toolCall:background", threadId: "parent", turnId: "turn", kind: "tool-call", providerIdentities: [],
      payload: { projection: "toolCall", record: { id: "background", tool_name: toolName } }, createdAt: NOW, updatedAt: NOW,
    } });
    deliver?.([late("Read")]);
    expect(service.loadRoster(request).revision).toBe(1);
    deliver?.([late("Agent")]);
    expect(service.loadRoster(request).revision).toBe(2);
  });

  it("coalesces narrative and canonical invalidations into one push after 250 ms", () => {
    const { db, call, service, durability } = harness();
    message(db, "message", "claude");
    call("root", "message");
    let canonicalChanged: ((threadId: string, revision: number) => void) | undefined;
    service.bindAcceptedProgress({
      ...durability,
      finishSubagentTurn: async () => ({ status: "Interrupted" }),
      interruptSubagentTurns: () => true,
      onSubagentRosterChange: (listener) => { canonicalChanged = listener; },
    });
    const broadcast = vi.spyOn(push, "broadcast");
    vi.useFakeTimers();
    canonicalChanged?.("parent", 0);
    service.toolChanged("parent", "root");
    canonicalChanged?.("parent", 1);
    canonicalChanged?.("parent", 1);
    expect(service.loadRoster(request).revision).toBe(2);
    vi.advanceTimersByTime(249);
    expect(broadcast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(broadcast.mock.calls).toEqual([["subagents.changed", {
      threadId: "parent", epoch: service.loadRoster(request).epoch, revision: 2,
    }]]);
    vi.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("keeps an old Devin marker running while its nested lifecycle call is active", () => {
    const { db, call, service } = harness("devin");
    message(db, "message", "devin");
    call("marker", "message", { status: "completed", outputSummary: "Started native-worker", completedAt: "2026-10-10T10:00:01.000Z" });
    call("lifecycle", "message", { parentToolCallId: "marker", sortOrder: 1, startedAt: "2026-10-10T10:00:02.000Z" });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status, row.tier])).toEqual([
      ["call:marker", "running", "steps"],
    ]);
    db.prepare("UPDATE tool_call_records SET status = 'completed', output_summary = 'Found the cause', completed_at = '2026-10-10T10:00:03.000Z' WHERE id = 'lifecycle'").run();
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status])).toEqual([["call:marker", "done"]]);
    expect(service.loadDetail({ ...request, entryId: "call:marker" }).summary).toBe("Found the cause");
  });

  it("keeps a Cursor Task entry's id and bumps the revision when cursor/task metadata lands", () => {
    const { narrative, service } = harness("cursor");
    narrative.beginTurn("parent");
    narrative.bufferToolCall("parent", { toolCallId: "task-1", toolName: "Agent",
      toolInput: { description: "Subagent task", subagentProviderName: "Cursor" } });
    service.toolChanged("parent", "task-1");
    const provisional = service.loadRoster(request);
    narrative.bufferToolCall("parent", { toolCallId: "task-1", toolName: "Agent", toolInput: {
      description: "Read the docs", prompt: "Read docs/README.md", model: "composer-2.5-fast", subagentProviderName: "Cursor",
    } });
    service.toolChanged("parent", "task-1");
    const enriched = service.loadRoster(request);
    expect(provisional.entries.map((row) => [row.id, row.prompt, row.model])).toEqual([["call:task-1", null, null]]);
    expect(enriched.entries.map((row) => [row.id, row.prompt, row.model])).toEqual([
      ["call:task-1", "Read docs/README.md", "composer-2.5-fast"],
    ]);
    expect([provisional.revision, enriched.revision]).toEqual([1, 2]);
  });

  it("reads a Claude Agent call left running at a user stop as stopped from its cancelled status", async () => {
    const { db, narrative, service } = harness("claude");
    message(db, "message", "claude");
    narrative.beginTurn("parent");
    narrative.bufferToolCall("parent", { toolCallId: "agent-1", toolName: "Agent", toolInput: { description: "Survey repo" } });
    await narrative.persistNarrative("parent", "message", "", "cancelled", { strict: true });
    narrative.clearTurn("parent");
    expect(db.prepare("SELECT status FROM tool_call_records WHERE id = ?").get("agent-1")).toEqual({ status: "cancelled" });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status])).toEqual([["call:agent-1", "stopped"]]);
  });

  it("preserves a successful root result after an earlier nested Agent failure", () => {
    const { db, call, service } = harness();
    message(db, "message", "claude");
    call("root", "message", { status: "completed", outputSummary: "Recovered successfully", completedAt: "2026-10-10T10:00:05.000Z" });
    call("nested", "message", { parentToolCallId: "root", status: "failed", sortOrder: 1,
      startedAt: "2026-10-10T10:00:01.000Z", completedAt: "2026-10-10T10:00:03.000Z", outputSummary: "Attempt failed" });
    expect(service.loadRoster(request).entries.map((row) => [row.id, row.status])).toEqual([["call:root", "done"]]);
    expect(service.loadDetail({ ...request, entryId: "call:root" }).summary).toBe("Recovered successfully");
  });
});

describe("subagentStatusFrom", () => {
  it.each([
    ["Running", "running"], ["Completed", "done"], ["Errored", "failed"],
    ["Cancelled", "stopped"], ["Interrupted", "stopped"], ["cancelled", "stopped"],
    ["completed", "done"], ["failed", "failed"],
    ["Active", "running"], ["legacy-status", "failed"], [null, "failed"],
    ["Pending", "running"], ["Starting", "running"],
    ["Idle", "done"], ["Closed", "stopped"], ["Unavailable", "failed"],
    ["constructor", "failed"], ["__proto__", "failed"],
  ])("normalizes %s to %s", (input, expected) => expect(subagentStatusFrom(input)).toBe(expected));
  it("normalizes parent cancellation without changing an already successful result", () => {
    expect(subagentStatusFrom("running", true)).toBe("stopped");
    expect(subagentStatusFrom("failed", true)).toBe("stopped");
    expect(subagentStatusFrom("completed", true)).toBe("done");
  });
});
