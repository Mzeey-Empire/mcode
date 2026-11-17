import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { createMockMessage } from "@mcode/contracts/testing";
import type { BackgroundCallKind } from "@mcode/contracts/models/tool-call-record";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalAgentStore } from "../../canonical/canonical-agent-store.js";
import { notifyCommittedCanonicalEvents } from "../../canonical/committed-canonical-events.js";
import { AgentWorkloadService } from "../agent-workload.js";
import { syntheticThreadExecutionId } from "../../canonical/canonical-thread-execution.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";

const NOW = "2026-11-17T12:00:00.000Z";
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function harness() {
  const db = openMemoryDatabase();
  disposers.push(() => db.close());
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('w', 'w', 'C:/fixture', ?, ?)").run(NOW, NOW);
  const store = new CanonicalAgentStore(db, notifyCommittedCanonicalEvents);
  const active = new Set<string>();
  const workload = new AgentWorkloadService({ activeTurnThreadIds: () => [...active] }, store);
  disposers.push(workload.observeCommittedEvents());
  function hold(threadId: string, kind?: BackgroundCallKind, id = threadId) {
    if (!store.loadTurn(threadId)) {
      db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, 'w', 'test', 'main', 'claude', ?, ?)").run(threadId, NOW, NOW);
      store.startParentTurn({ thread: { id: threadId, workspaceId: "w", providerId: "claude", createdAt: NOW },
        turnId: threadId, executionId: syntheticThreadExecutionId(threadId), permissionMode: "supervised", providerIdentities: [],
        approvalReviewMode: "manual", approvalReviewReason: "manual-requested",
        projectUserMessage: () => createMockMessage({ id: `user-${threadId}`, thread_id: threadId, role: "user" }) });
    }
    const message = new MessageStore(db).create(threadId, "assistant", "Background work", 2);
    const record = { id, message_id: message.id, parent_tool_call_id: null, tool_name: "Any provider tool",
      input_summary: "", output_summary: "", status: "running" as const, background: true, background_kind: kind,
      background_label: "Investigate", started_at: NOW, completed_at: null, sort_order: 0 };
    store.commit({ threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId), phase: "completed", events: [{ eventId: `held-${id}`, routing: { threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId), itemId: `toolCall:${id}` }, sourceProviderId: "claude", sourceIdentities: [],
      payload: { type: "item.recorded", item: { id: `toolCall:${id}`, threadId, turnId: threadId, kind: "tool-call", providerIdentities: [],
        payload: { projection: "toolCall", record }, createdAt: NOW, updatedAt: NOW } } },
      { eventId: `ended-${id}`, routing: { threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId) }, sourceProviderId: "claude", sourceIdentities: [],
        payload: { type: "turn.completed", endedAt: NOW } }] });
    return record;
  }
  return { store, workload, active, hold };
}

describe("AgentWorkload", () => {
  it("unions running turns and background subagents by thread", () => {
    const { workload, active, hold, store } = harness();
    active.add("first");
    expect(workload.count()).toBe(1);
    hold("first", "subagent");
    expect(workload.count()).toBe(1);
    active.clear();
    expect(workload.count()).toBe(1);
    hold("second", "subagent");
    expect(workload.count()).toBe(2);
    expect(store.listHeldBackgroundToolCalls({ threadId: "second" })).toEqual([
      { threadId: "second", executionId: syntheticThreadExecutionId("second"), toolCallId: "second", kind: "subagent", label: "Investigate" },
    ]);
  });

  it("ignores commands and unclassified legacy calls", () => {
    const { workload, hold } = harness();
    hold("command", "command");
    hold("legacy");
    expect(workload.count()).toBe(0);
    expect(workload.hasBackgroundSubagent("legacy")).toBe(false);
  });

  it("notifies only first and last subagent transitions, including late saved results", () => {
    const { workload, hold, store } = harness();
    const changes: string[] = [];
    const unsubscribe = workload.onSubagentChange((threadId) => changes.push(threadId));
    const first = hold("first", "subagent", "a");
    const second = hold("first", "subagent", "b");
    function settle(record: typeof first) {
      store.commit({ threadId: "first", turnId: "first", executionId: syntheticThreadExecutionId("first"), phase: "completed", events: [{ eventId: `settled-${record.id}`, routing: { threadId: "first", turnId: "first", executionId: syntheticThreadExecutionId("first"), itemId: `toolCall:${record.id}` }, sourceProviderId: "claude", sourceIdentities: [],
        payload: { type: "item.recorded", item: { id: `toolCall:${record.id}`, threadId: "first", turnId: "first", kind: "tool-call", providerIdentities: [],
          payload: { projection: "toolCall", record: { ...record, status: "completed", completed_at: NOW } }, createdAt: NOW, updatedAt: NOW } } }] });
    }
    expect(changes).toEqual(["first"]);
    settle(first);
    expect(workload.count()).toBe(1);
    expect(changes).toEqual(["first"]);
    settle(second);
    expect(workload.count()).toBe(0);
    expect(changes).toEqual(["first", "first"]);
    unsubscribe();
    hold("second", "subagent");
    expect(changes).toEqual(["first", "first"]);
  });
});
