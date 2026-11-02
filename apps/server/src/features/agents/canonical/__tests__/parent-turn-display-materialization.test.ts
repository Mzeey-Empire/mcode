import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderEventDraft } from "@mcode/providers";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalExecutionSemanticWriter } from "../canonical-execution-semantic-writer.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand } from "../../execution/execution-worker-handler.js";
import { ToolCallRecordStore } from "../../tools/persistence/tool-call-record-store.js";
import { ThoughtSegmentStore } from "../../conversation/narrative/persistence/thought-segment-store.js";
import { HookExecutionStore } from "../../events/persistence/hook-execution-store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = "thread-1";

interface TurnPlan {
  turnId: string;
  executionId: string;
  userMessageId: string;
  sequence: number;
  withAnswer: boolean;
}

async function writeTurn(db: Database, plan: TurnPlan): Promise<void> {
  const execution = { threadId: THREAD_ID, turnId: plan.turnId, executionId: plan.executionId };
  const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: `lease-${plan.turnId}` };
  const semanticWriter = new CanonicalExecutionSemanticWriter(db, () => undefined);
  const handler = new ExecutionWorkerHandler({ transact: (operation) => semanticWriter.transact(operation) });
  let ordinal = 0;
  const send = async (command: ExecutionWorkCommand) => {
    ordinal += 1;
    const reply = await handler.handle({ requestId: ordinal, execution, lease, ordinal, command });
    expect(["committed", "accepted"]).toContain(reply.result.kind);
  };
  let sourceSequence = 0;
  const draft = (type: AgentEvent["type"], fields: Record<string, unknown> = {}): ProviderEventDraft => {
    sourceSequence += 1;
    const event = AgentEventSchema().parse({ type, threadId: THREAD_ID, turnExecutionId: plan.executionId, ...fields });
    const itemId = `${plan.turnId}-item-${sourceSequence}`;
    return {
      eventId: `${plan.turnId}-event-${sourceSequence}`,
      routing: { ...execution, itemId },
      sourceProviderId: "codex",
      sourceIdentities: [],
      sourceSequence,
      payload: {
        type: "item.recorded",
        item: {
          id: itemId, threadId: THREAD_ID, turnId: plan.turnId, kind: "system", providerIdentities: [],
          payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } },
          createdAt: NOW, updatedAt: NOW,
        },
      },
    };
  };
  const event = (type: AgentEvent["type"], fields: Record<string, unknown> = {}) => send({
    kind: "event", phase: "running", nativeCursor: null, events: [draft(type, fields)],
  });
  await send({
    kind: "start",
    providerId: "codex",
    parentLive: { planFeature: "none", precedingMessageId: plan.userMessageId },
    input: {
      thread: { id: THREAD_ID, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
      turnId: plan.turnId,
      executionId: plan.executionId,
      permissionMode: "supervised",
      approvalReviewMode: "manual",
      approvalReviewReason: "manual-requested",
      providerIdentities: [],
      userMessage: { kind: "create", messageId: plan.userMessageId, content: "Question", sequence: plan.sequence },
    },
  });
  await event("turnStarted");
  for (let index = 0; index < 2; index++) {
    await event("toolUse", {
      toolCallId: `${plan.turnId}-tool-${index}`, toolName: "Read", toolInput: { file_path: `src/f${index}.ts` },
    });
    await event("toolResult", { toolCallId: `${plan.turnId}-tool-${index}`, output: "ok", isError: false });
  }
  await event("reasoningDelta", { delta: `${plan.turnId} thought`, reasoningItemId: `${plan.turnId}-thought` });
  await event("hookStarted", { hookName: "PreToolUse", toolName: "Read", hookType: "permission" });
  await event("hookCompleted", { hookName: "PreToolUse", exitCode: 0, durationMs: 1, didBlock: false });
  if (plan.withAnswer) {
    await event("textDelta", { delta: "Answer", isFinalResponse: true });
    await event("message", { content: "Answer", tokens: null, provider: "codex" });
  }
  await send({
    kind: "event", phase: "running", nativeCursor: null,
    events: [draft("turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 })],
    terminalInput: {
      ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" },
    },
  });
}

function expectDisplayRows(db: Database, turnId: string): void {
  const assistantMessages = db.query<{ id: string }, [string]>(`
    SELECT DISTINCT m.id FROM canonical_agent_items i
    JOIN canonical_conversation_display_mappings mapping ON mapping.source_item_id = i.id
    JOIN messages m ON mapping.target_kind = 'message' AND mapping.target_id = m.id
    WHERE i.turn_id = ? AND m.role = 'assistant'
  `).all(turnId);
  expect(assistantMessages).toHaveLength(1);
  const messageId = assistantMessages[0]!.id;
  expect(new ToolCallRecordStore(db).listByMessage(messageId).map((tool) => tool.id).sort())
    .toEqual([`${turnId}-tool-0`, `${turnId}-tool-1`]);
  expect(new ThoughtSegmentStore(db).listByMessage(messageId).map((thought) => thought.text))
    .toEqual([`${turnId} thought`]);
  expect(new HookExecutionStore(db).listByMessage(messageId).map((hook) => ({
    name: hook.hook_name, durationMs: hook.duration_ms,
  }))).toEqual([{ name: "PreToolUse", durationMs: 1 }]);
  const items = db.query<{ id: string }, [string]>(`
    SELECT id FROM canonical_agent_items WHERE turn_id = ?
      AND json_extract(payload_json, '$.projection') NOT IN ('providerRuntimeEvent', 'narrativeRecoveryDiscarded')
  `).all(turnId);
  for (const item of items) {
    const mappings = db.query<{ target_kind: string; target_id: string }, [string]>(`
      SELECT target_kind, target_id FROM canonical_conversation_display_mappings WHERE source_item_id = ?
    `).all(item.id);
    expect(mappings).toHaveLength(1);
    const mapping = mappings[0]!;
    const targets = db.query<{ id: string }, [string, string, string, string, string, string, string, string]>(`
      SELECT id FROM messages WHERE ? = 'message' AND id = ?
      UNION ALL SELECT id FROM tool_call_records WHERE ? = 'toolCall' AND id = ?
      UNION ALL SELECT id FROM thought_segments WHERE ? = 'narrationSegment' AND id = ?
      UNION ALL SELECT id FROM hook_executions WHERE ? = 'hook' AND id = ?
    `).all(mapping.target_kind, mapping.target_id, mapping.target_kind, mapping.target_id,
      mapping.target_kind, mapping.target_id, mapping.target_kind, mapping.target_id);
    expect(targets).toEqual([{ id: mapping.target_id }]);
  }
}

describe("parent turn inline display materialization", () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDatabase();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace-1", "Workspace", "C:/fixture", NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(THREAD_ID, "workspace-1", "Thread", "main", NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it("materializes turns with and without answer text without a startup pass", async () => {
    await writeTurn(db, {
      turnId: "turn-answer", executionId: "00000000-0000-4000-8000-000000000001",
      userMessageId: "user-1", sequence: 1, withAnswer: true,
    });
    await writeTurn(db, {
      turnId: "turn-no-answer", executionId: "00000000-0000-4000-8000-000000000002",
      userMessageId: "user-2", sequence: 3, withAnswer: false,
    });

    expectDisplayRows(db, "turn-answer");
    expectDisplayRows(db, "turn-no-answer");
  });
});
