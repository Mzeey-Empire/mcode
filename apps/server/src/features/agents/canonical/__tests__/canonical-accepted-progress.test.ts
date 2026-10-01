import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventSchema, CanonicalAgentProgressFrameSchema, ProviderRuntimeExtensionSchema, encodeCanonicalSubagentDetailTarget, type ProviderRuntimeExtension, type AgentEvent, type CanonicalAgentProgressFrame,
  type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand, type ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient, CanonicalWriterAcknowledgementCapacity } from "../canonical-agent-writer-client.js";
import { CanonicalAcceptedProgress } from "../canonical-accepted-progress.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createDevinAcpTurnState, mapDevinAcpSessionNotification } from "../../../../../../../packages/providers/src/private/devin/devin-acp-event-mapper.js";

const pushes = vi.hoisted(() => ({ frames: [] as unknown[] }));
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: (channel: string, frame: unknown) => {
  if (channel === "agent.canonical") pushes.frames.push(frame);
}, subscribedThreadIds: () => new Set<string>() }));
const NOW = "2026-09-30T10:00:00.000Z";
const execution = { threadId: "live-thread", turnId: "live-turn", executionId: "00000000-0000-4000-8000-000000000123" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "live-lease" };

function start(providerId: string, identity = execution): Extract<ExecutionWorkCommand, { kind: "start" }> {
  return { kind: "start", providerId, publishParentStart: true,
    parentLive: { planFeature: "none", precedingMessageId: `${identity.turnId}:user` },
    input: { thread: { id: identity.threadId, workspaceId: "workspace", providerId, createdAt: NOW },
      turnId: identity.turnId, executionId: identity.executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: `${identity.turnId}:user`, content: "Task", sequence: 1 } } };
}

function draft(providerId: string, sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}, identity = execution) {
  const event = AgentEventSchema().parse({ type, threadId: identity.threadId, turnExecutionId: identity.executionId,
    ...(type === "turnComplete" ? { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } : {}), ...fields });
  const itemId = `${identity.executionId}:raw:${sequence}`;
  return { eventId: itemId, routing: { ...identity, itemId }, sourceProviderId: providerId,
    sourceIdentities: [], sourceSequence: sequence, payload: { type: "item.recorded" as const,
      item: { id: itemId, threadId: identity.threadId, turnId: identity.turnId, kind: "system" as const,
        providerIdentities: [], payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: NOW, updatedAt: NOW } } };
}

function completedTool(index: number): ParentNarrativeRecoveryItem {
  return { kind: "toolCall", record: { id: `tool-${index}`, message_id: "", parent_tool_call_id: null,
    tool_name: "Read", display_name: null, provider_agent_key: null, subagent_identity_key: null,
    subagent_provider_name: null, subagent_prompt: null, subagent_type: null, subagent_agent_id: null,
    subagent_duration_ms: null, model: null, reasoning_effort: null, input_summary: "file.txt", output_summary: "Done",
    output_total_bytes: null, output_artifact_path: null, exit_code: null, status: "completed",
    started_at: NOW, completed_at: NOW, sort_order: index } };
}

function familyDraft(sequence: number, type: AgentEvent["type"], fields: Record<string, unknown>,
  extension: Omit<ProviderRuntimeExtension, "kind" | "providerId">) {
  const value = draft("codex", sequence, type, fields);
  return { ...value, payload: { ...value.payload, item: { ...value.payload.item,
    payload: { ...value.payload.item.payload, runtimeEvent: { ...value.payload.item.payload.runtimeEvent,
      extension: ProviderRuntimeExtensionSchema().parse({ kind: "codex-collaboration", providerId: "codex", ...extension }) } } } } };
}

describe("accepted parent progress with the actual SQLite writer", () => {
  let directory: string;
  let db: Database;
  let writer: CanonicalAgentWriterClient;
  let progress: CanonicalAcceptedProgress;
  let port: CanonicalExecutionWriterPort;
  let handler: ExecutionWorkerHandler;
  let release: (() => void) | undefined;

  beforeEach(() => {
    pushes.frames.length = 0;
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-live-progress-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace", "Workspace", directory, NOW, NOW);
    insertThread(execution.threadId);
    writer = new CanonicalAgentWriterClient(dbPath);
    progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, () => {}), writer);
    port = new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress);
    handler = new ExecutionWorkerHandler(port);
  });

  afterEach(async () => {
    release?.();
    release = undefined;
    await progress.close();
    await writer.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function insertThread(threadId: string) {
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, "workspace", "Thread", "main", "codex", NOW, NOW);
  }
  const send = (ordinal: number, command: ExecutionWorkCommand, identity = execution, activeLease = lease) =>
    handler.handle({ requestId: ordinal, execution: identity, lease: activeLease, ordinal, command });
  function holdWrites() {
    const append = writer.appendAccepted.bind(writer);
    const held = new Promise<void>((resolve) => { release = resolve; });
    const heldAppend: typeof writer.appendAccepted = async (...args) => { await held; return append(...args); };
    vi.spyOn(writer, "appendAccepted").mockImplementation(heldAppend);
    return heldAppend;
  }
  function recovery(identity = execution) {
    return progress.recover(identity.threadId, { conversationRevision: 0, rosterRevision: 0 });
  }
  function frames(): CanonicalAgentProgressFrame[] {
    return pushes.frames.map((frame) => CanonicalAgentProgressFrameSchema().parse(frame));
  }

  it("preserves the durable child roster revision across a parent follow-up and fresh recovery owner", async () => {
    await send(1, start("codex"));
    expect(recovery().durable).toMatchObject({ mode: "snapshot", snapshot: { revision: { rosterRevision: 0 } } });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })] });
    const child = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "turnComplete", {}, { child })] });
    await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 4, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect((await send(6, { kind: "release" })).result.kind).toBe("released");
    const previous = recovery();
    if (previous.durable.mode !== "snapshot") throw new Error("Expected saved parent snapshot");
    const before = previous.durable.snapshot;
    expect(before.revision.rosterRevision).toBe(1);
    const childThread = Object.values(before.state.threads).find((thread) => thread.owningParentThreadId === execution.threadId);
    if (!childThread) throw new Error("Expected existing native child");
    expect(progress.loadSubagentRoster({ owningParentThreadId: execution.threadId })?.done.map((thread) => thread.id)).toContain(childThread.id);
    const frameOffset = pushes.frames.length;
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000126" };
    const nextLease = { ...lease, ownerEpoch: 2, leaseId: "next-lease" };
    expect((await send(1, start("codex", next), next, nextLease)).result.kind).toBe("committed");
    const after = recovery(next);
    if (after.durable.mode !== "snapshot") throw new Error("Expected follow-up snapshot");
    expect(after.durable.snapshot.revision.rosterRevision).toBe(before.revision.rosterRevision);
    expect(after.durable.snapshot.revision.conversationRevision).toBeGreaterThan(before.revision.conversationRevision);
    expect(after.durable.snapshot.state.threads[childThread.id]).toEqual(childThread);
    const starts = frames().slice(frameOffset).filter((frame) => frame.phase === "saved" && frame.through === 0);
    expect(starts).toHaveLength(2);
    for (const frame of starts) {
      if (frame.phase !== "saved") throw new Error("Expected saved startup frame");
      expect(frame.revision.rosterRevision).toBe(before.revision.rosterRevision);
    }
    const recordedParent = starts.flatMap((frame) => frame.phase === "saved" ? frame.events : [])
      .find((event) => event.payload.type === "thread.recorded");
    expect(recordedParent?.payload).toMatchObject({ thread: { rosterRevision: before.revision.rosterRevision } });
    const restarted = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, () => {}), writer);
    try {
      const restored = restarted.recover(execution.threadId, before.revision);
      if (restored.durable.mode !== "snapshot") throw new Error("Expected restarted snapshot");
      expect(restored.durable.snapshot.revision).toEqual(after.durable.snapshot.revision);
      expect(restored.durable.snapshot.state.threads[childThread.id]).toEqual(childThread);
      expect(restored.durable.snapshot.state.threads[execution.threadId]?.rosterRevision).toBe(before.revision.rosterRevision);
    } finally {
      await restarted.close();
    }
  });

  it("retains a child roster, transcript and exact Stop without consuming the parent's next ordinal", async () => {
    await send(1, start("codex"));
    holdWrites();
    const spawn = familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
      { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } });
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [spawn] })).result.kind).toBe("accepted");
    const evidence = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: evidence })] })).result.kind).toBe("accepted");
    const roster = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId });
    const childId = roster?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child roster");
    expect(() => progress.assertThreadDeletionSupported(childId)).toThrow("Provider-owned child");
    expect(() => progress.assertThreadDeletionSupported(execution.threadId)).not.toThrow();
    expect(progress.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ nativeThreadId: "native-child", nativeTurnId: "native-turn", latestTurn: { status: "Running" } });
    expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(childId)).toBeNull();
    expect((await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "system", { subtype: "provider.notice.warning", message: "Child provider warning",
        systemNotice: { kind: "warning", presentation: "timeline", scope: "session", sessionId: "child-session" } },
      { child: evidence })] })).result.kind).toBe("accepted");
    const childTurn = progress.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId })?.latestTurn;
    const childNotice = recovery().retained.find((envelope) => envelope.payload.type === "publication.recorded"
      && envelope.payload.event.type === "system" && envelope.payload.event.message === "Child provider warning");
    expect(childNotice).toMatchObject({ payload: { event: { threadId: childId, turnExecutionId: childTurn?.executionId } } });
    expect((await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(4, "textDelta", { delta: "Child answer" }, { child: { ...evidence,
        nativeItemId: "child-message", itemEventKey: "delta" } })] })).result.kind).toBe("accepted");
    const beforeStop = progress.recover(childId, { conversationRevision: 0, rosterRevision: 0 });
    expect(beforeStop.ownerThreadId).toBe(execution.threadId);
    expect(beforeStop.retained.some((event) => event.payload.type === "collaboration.observed"
      && event.payload.changes.some((change) => change.kind === "item-recorded" && change.item.threadId === childId
        && JSON.stringify(change.item.payload).includes("Child answer")))).toBe(true);
    expect(progress.finishSubagentTurn({ childThreadId: childId, nativeTurnId: "native-turn",
      outcome: "interrupted", error: "Interrupted by user" })?.status).toBe("Interrupted");
    expect((await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 5, "textDelta", { delta: "Parent continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    expect((await send(7, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 6, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(childId)).toEqual({ id: childId });
    expect(progress.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ latestTurn: { status: "Interrupted" } });
    const saved = new CanonicalAgentBoundary(db, () => {});
    expect(saved.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ latestTurn: { status: "Interrupted" } });
    expect(saved.loadTurn(execution.turnId)?.status).toBe("Completed");
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content))
      .toEqual(["Child task", "Child answer"]);
    expect(db.prepare("SELECT role, content FROM messages WHERE thread_id = ? AND role <> 'system' ORDER BY sequence").all(childId))
      .toEqual([{ role: "user", content: "Child task" }, { role: "assistant", content: "Child answer" }]);
    const childPublication = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
      .get(`${lease.leaseId}:4:publication:0`);
    expect(childPublication).toBeTruthy();
    expect(saved.loadAcceptedFeatureSeed(execution.threadId).noticeSessionId).not.toBe("child-session");
    expect(progress.recover(childId, { conversationRevision: 0, rosterRevision: 0 }).retained).toEqual([]);
  });

  it("materializes a native child completion before the parent finishes without a child writer checkpoint", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })] });
    const evidence = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: evidence })] });
    const childId = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId })?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child roster");
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "textDelta", { delta: "Child answer" }, { child: { ...evidence,
        nativeItemId: "child-message", itemEventKey: "delta" } })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = new CanonicalAgentBoundary(db, () => {});
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content)).toEqual(["Child task"]);
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant'").all(childId)).toEqual([]);
    await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(4, "turnComplete", {}, { child: evidence })] });
    await expect.poll(() => progress.depth().pending).toBe(0);

    expect(saved.loadLatestTurn(childId)?.status).toBe("Completed");
    expect(saved.loadTurn(execution.turnId)?.status).toBe("Running");
    expect(db.prepare("SELECT turn_id FROM canonical_agent_ingest_checkpoints WHERE thread_id = ?").all(childId)).toEqual([]);
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content))
      .toEqual(["Child task", "Child answer"]);
    expect(db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY sequence").all(childId))
      .toEqual([{ role: "user", content: "Child task" }, { role: "assistant", content: "Child answer" }]);

    await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 5, "toolResult", { toolCallId: "spawn", output: "Child answer", isError: false })] });
    await send(7, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 6, "textDelta", { delta: "Parent answer", isFinalResponse: true })] });
    await send(8, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 7, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const detailTarget = encodeCanonicalSubagentDetailTarget(childId);
    expect(saved.loadItem("toolCall:spawn")?.payload).toMatchObject({
      childThreadId: childId, record: { subagent_identity_key: detailTarget },
    });
    expect(db.prepare("SELECT subagent_identity_key FROM tool_call_records WHERE id = 'spawn'").get())
      .toEqual({ subagent_identity_key: detailTarget });
    const parentPage = saved.loadConversationProjection(execution.threadId, 20);
    expect(Object.values(parentPage.narrativeByMessage).flatMap((batch) => batch.tools).find((tool) => tool.id === "spawn"))
      .toMatchObject({ subagent_identity_key: detailTarget });
  });

  it("saves native ACP thought and unknown assistant channels as distinct narration before the next thought", async () => {
    await send(1, start("devin"));
    const append = vi.spyOn(writer, "appendAccepted");
    const state = createDevinAcpTurnState();
    const notifications: SessionNotification[] = [
      { sessionId: "devin-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT" } } },
      { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "UNKNOWN" } } },
      { sessionId: "devin-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "NEXT" } } },
    ];
    let ordinal = 1;
    let sequence = 0;
    for (const notification of notifications) {
      for (const event of mapDevinAcpSessionNotification(notification, execution.threadId, state)) {
        const { type, ...fields } = event;
        expect((await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
          events: [draft("devin", ++sequence, type, fields)] })).result.kind).toBe("accepted");
      }
    }
    await expect.poll(() => append.mock.results.length).toBeGreaterThanOrEqual(3);
    await expect(append.mock.results[2]?.value).resolves.toHaveProperty("receipt");
    await expect.poll(() => progress.depth().pending).toBe(0);
    const canonical = new CanonicalAgentBoundary(db, () => {});
    expect(canonical.loadParentNarrativeForBinding(execution.threadId, execution.turnId)
      .flatMap((item) => item.kind === "narrationSegment" ? [item.record.text] : [])).toEqual(["THOUGHT", "UNKNOWN", "NEXT"]);
    expect(db.prepare("SELECT retained_bytes FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toBeNull();
    await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", ++sequence, "turnComplete")], terminalInput: { ...execution,
        providerId: "devin", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(canonical.loadTurn(execution.turnId)?.status).toBe("Completed");
  });

  it("accepts the native Devin final-prefix, later unknown narration and final completion sequence while saving is held", async () => {
    await send(1, start("devin"));
    let ordinal = 1;
    let sequence = 0;
    const event = async (type: AgentEvent["type"], fields: Record<string, unknown> = {}) => {
      const value = draft("devin", ++sequence, type, fields);
      const terminalInput = type === "turnComplete" ? { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed" as const, projection: { kind: "writer-staged" as const } } : undefined;
      expect((await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [value],
        ...(terminalInput ? { terminalInput } : {}) })).result.kind).toBe("accepted");
    };
    await event("textDelta", { delta: "INITIAL_THOUGHT", isFinalResponse: false });
    await event("toolUse", { toolCallId: "prefix", toolName: "Read", toolInput: {} });
    await event("toolResult", { toolCallId: "prefix", output: "Done", isError: false });
    await event("textDelta", { delta: "PREFIX\n", isFinalResponse: true });
    await expect.poll(() => progress.depth().pending).toBe(0);
    holdWrites();
    await event("assistantMessageBoundary", { isFinalResponse: true });
    await event("toolUse", { toolCallId: "later", toolName: "Read", toolInput: {} });
    await event("textDelta", { delta: "AFTER_TOOL\n" });
    await event("toolResult", { toolCallId: "later", output: "Done", isError: false });
    await event("assistantMessageBoundary", { isFinalResponse: false });
    await event("textDelta", { delta: "COMPLETE", isFinalResponse: true });
    await event("message", { content: "PREFIX\nCOMPLETE", tokens: null });
    await event("turnComplete");
    expect(progress.latestAssistantMessage(execution.threadId)?.content).toBe("PREFIX\nCOMPLETE");
    const before = recovery().retained.map((value) => ({ id: value.eventId, position: value.progressPosition }));
    const reclassification = recovery().retained.filter((value) => value.payload.type === "item.recorded"
      && value.payload.item.payload.projection === "narrativeRecovery");
    expect(JSON.stringify(reclassification)).toContain("AFTER_TOOL");
    expect(JSON.stringify(reclassification)).not.toContain("PREFIX");
    expect(recovery().retained.some((value) => value.payload.type === "turn.completed")).toBe(true);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(new CanonicalAgentBoundary(db, () => {}).loadTerminalProjection(execution.turnId).message?.content).toBe("PREFIX\nCOMPLETE");
    const saved = frames().flatMap((frame) => frame.phase === "saved" ? frame.events : [])
      .filter((value) => before.some((event) => event.id === value.eventId));
    expect(saved.map((value) => ({ id: value.eventId, position: value.progressPosition }))).toEqual(before);
  });

  it("orders synthesized observations behind a held provider suffix without consuming its next ordinal", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Held", isFinalResponse: true })] });
    const boundary = new CanonicalAgentBoundary(db, () => {});
    boundary.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
    const observed = boundary.recordSynthesizedPublications(execution.threadId, [{ type: "system", threadId: execution.threadId,
      subtype: "goal.paused", message: "Paused" }]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.routing.executionId).toBe(execution.executionId);
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: " continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    const before = recovery();
    expect(before.retained.map((event) => event.progressPosition.sequence)).toEqual(
      Array.from({ length: before.retained.length }, (_, index) => index + 1));
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().savedThrough).toBe(before.acceptedThrough);
  });

  it("admits an external late hook behind its unsaved terminal and preserves that original correlation on a later turn", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Original answer", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    const original = progress.latestAssistantMessage(execution.threadId);
    if (!original) throw new Error("Expected original accepted assistant");
    const hook = { id: "external-hook", hookName: "Stop", toolName: null, phase: "stop", payload: "{}", durationMs: 12,
      didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 9 };
    progress.acceptLateHook(execution.threadId, execution.executionId, hook);
    const acceptedCount = recovery().acceptedThrough;
    progress.acceptLateHook(execution.threadId, execution.executionId, hook);
    expect(recovery().acceptedThrough).toBe(acceptedCount);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = ?").get(hook.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    await send(1, start("codex", next), next, { ...lease, leaseId: "next-lease" });
    progress.acceptLateHook(execution.threadId, execution.executionId, { ...hook, id: "later-external-hook" });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT message_id FROM hook_executions WHERE id = ?").get("later-external-hook")).toEqual({ message_id: original.id });
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toEqual({ status: "Running" });
  });

  it("assigns live plan, task and notice projections before storage and persists those same identities", async () => {
    const admission = start("codex");
    await send(1, { ...admission, parentLive: { ...admission.parentLive, precedingMessageId: `${execution.turnId}:user`, planFeature: "output" } });
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "toolUse", {
      toolCallId: "tasks", toolName: "TodoWrite", toolInput: { todos: [{ content: "Build", status: "in_progress", activeForm: "Building" }] } })] });
    expect(progress.getTasks(execution.threadId)).toMatchObject([{ content: "Build", status: "in_progress" }]);
    const content = '```plan-output\n{"title":"Plan","sections":[{"id":"build","title":"Build","level":1,"content":"Build it"}]}\n```';
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "textDelta", { delta: content, isFinalResponse: true })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "message", { content, tokens: null })] });
    const plan = progress.listPlans(execution.threadId)?.[0];
    if (!plan) throw new Error("Expected accepted plan before saving");
    expect(progress.updatePlanStatus(plan.id, "accepted")).toBe(true);
    await send(5, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 4, "system", {
      subtype: "provider.notice.test", message: "Notice", systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "turn", sessionId: "session" } })] });
    const notice = frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : []).find((value) => value.payload.type === "item.recorded"
      && value.payload.item.payload.projection === "message" && value.payload.item.payload.message.role === "system");
    if (!notice || notice.payload.type !== "item.recorded") throw new Error("Expected accepted notice");
    expect(db.prepare("SELECT id FROM plans WHERE id = ?").get(plan.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id, message_id, version, status, created_at FROM plans WHERE id = ?").get(plan.id))
      .toEqual({ id: plan.id, message_id: plan.messageId, version: plan.version, status: "accepted", created_at: plan.createdAt });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(notice.payload.item.payload.message.id))
      .toEqual({ id: notice.payload.item.payload.message.id });
    expect(progress.getTasks(execution.threadId)).toEqual(new (await import("../../orchestration/persistence/task-repo.js")).TaskRepo(db).get(execution.threadId));
  });

  it("retains a rejected older late hook and interrupts only the currently active execution sharing its blocked owner", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Original", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    const nextLease = { ...lease, leaseId: "next-lease" };
    await send(1, start("codex", next), next, nextLease);
    db.run("CREATE TRIGGER fail_late_hook BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id = 'late-hook:blocked-hook' BEGIN SELECT RAISE(ABORT, 'late hook save unavailable'); END");
    const affected: string[] = [];
    progress.bindPermanentFailure(async (active, error) => {
      affected.push(active.executionId);
      progress.interruptWorkerLoss({ execution: active, lease: nextLease, reason: error.message, recoveryIncidentId: "old-hook-failure" });
    });
    progress.acceptLateHook(execution.threadId, execution.executionId, { id: "blocked-hook", hookName: "Stop", toolName: null,
      phase: "stop", payload: "{}", durationMs: 10, didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 1 });
    await expect.poll(() => affected).toEqual([next.executionId]);
    expect(recovery().retained.some((event) => event.payload.type === "turn.interrupted" && event.routing.executionId === next.executionId)).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    db.run("DROP TRIGGER fail_late_hook");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = 'blocked-hook'").get()).toEqual({ id: "blocked-hook" });
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toEqual({ status: "Interrupted" });
  });

  it("rejects an empty terminal hook without attaching it to a prior assistant response", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(() => progress.acceptLateHook(execution.threadId, execution.executionId, { id: "empty-hook", hookName: "Stop", toolName: null,
      phase: "stop", payload: "{}", durationMs: 0, didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 1 })).toThrow("no assistant message");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = 'empty-hook'").get()).toBeNull();
  });

  it("discards the queued suffix only after the in-flight save settles and releases its retention budget", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "In flight", isFinalResponse: true })] });
    await expect.poll(() => writer.appendAccepted).toHaveBeenCalledTimes(1);
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Discard", isFinalResponse: true })] });
    let disposed = false;
    const deleting = progress.discardThread(execution.threadId).then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release?.();
    await deleting;
    expect(writer.appendAccepted).toHaveBeenCalledTimes(1);
    expect(progress.depth().retained).toMatchObject({ events: 0, bytes: 0 });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id = ?").get(`${execution.executionId}:raw:2`)).toBeNull();
    expect(() => progress.acceptSynthesizedPublications(execution.threadId,
      [{ type: "system", threadId: execution.threadId, subtype: "late" }])).toThrow("deletion is in progress");
    progress.finishThreadDeletion(execution.threadId);
  });

  it("interrupts a fully saved family child on restart even after its parent has completed", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child" } })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: { nativeThreadId: "native-child", nativeTurnId: "native-turn",
        parentCollaborationItemId: "spawn" } })] });
    const childId = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId })?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child");
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const boundary = new CanonicalAgentBoundary(db, () => {});
    expect(boundary.interruptSavedFamilyChildren("Server restarted")).toEqual([childId]);
    expect(boundary.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId })?.latestTurn?.status).toBe("Interrupted");
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(boundary.interruptSavedFamilyChildren("Server restarted")).toEqual([]);
  });

  it.each(["codex", "devin"])("accepts %s text, tools and terminal while storage is held, retaining them after worker release", async (providerId) => {
    expect((await send(1, start(providerId))).result.kind).toBe("committed");
    holdWrites();
    const event = (ordinal: number, sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}) =>
      send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [draft(providerId, sequence, type, fields)] });
    expect((await event(2, 1, "textDelta", { delta: "Checking", isFinalResponse: false })).result.kind).toBe("accepted");
    expect((await event(3, 2, "toolUse", { toolCallId: "read", toolName: "Read", toolInput: { file_path: "file.txt" } })).result.kind).toBe("accepted");
    expect((await event(4, 3, "toolResult", { toolCallId: "read", output: "Done", isError: false })).result.kind).toBe("accepted");
    expect((await event(5, 4, "textDelta", { delta: "Answer", isFinalResponse: true })).result.kind).toBe("accepted");
    expect((await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft(providerId, 5, "turnComplete")], terminalInput: { ...execution, providerId,
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result).toMatchObject({ kind: "accepted" });
    expect((await send(7, { kind: "release" })).result.kind).toBe("released");
    const cut = recovery();
    expect(cut.retained.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(cut.retained.some((event) => event.payload.type === "item.recorded" && event.payload.item.kind === "tool-call")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    const ids = cut.retained.map((event) => event.eventId);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().retained).toHaveLength(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    const savedIds = frames().flatMap((frame) => frame.phase === "saved" ? frame.events.map((event) => event.eventId) : []);
    expect(savedIds.filter((id) => ids.includes(id))).toEqual(ids);
    expect(new Set(savedIds).size).toBe(savedIds.length);
  });

  it("fences a later durable start before it can overtake the previous save acknowledgement", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await send(3, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000124" };
    const nextLease = { ...lease, leaseId: "next-lease" };
    let started = false;
    const pending = send(1, start("codex", next), next, nextLease).then((reply) => { started = true; return reply; });
    await Promise.resolve();
    expect(started).toBe(false);
    expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toBeNull();
    release?.();
    expect((await pending).result.kind).toBe("committed");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Next", isFinalResponse: true }, next)] }, next, nextLease)).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().loss).toBe("none");
  });

  it("replays the original full-port acceptance receipt before and after saving without regenerating identities", async () => {
    await send(1, start("codex"));
    holdWrites();
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:2", execution, lease, ordinal: 2,
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      mutation: { kind: "finish-live-event", outcome: "completed", projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { content: "Stable answer", model: "fixture", attachments: [] }, narrative: [completedTool(0)] },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } } };
    const first = await port.transact(operation);
    const admitted = recovery();
    const acceptedFrames = frames().filter((frame) => frame.phase === "accepted");
    expect(await port.transact(structuredClone(operation))).toEqual(first);
    const conflicting = structuredClone(operation);
    if (conflicting.mutation.kind !== "finish-live-event") throw new Error("Expected terminal operation");
    conflicting.mutation.projection.assistant.content = "Changed answer";
    await expect(port.transact(conflicting)).rejects.toThrow("identity-conflict");
    expect(recovery()).toEqual(admitted);
    expect(frames().filter((frame) => frame.phase === "accepted")).toEqual(acceptedFrames);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 0 });
    expect(await port.transact(structuredClone(operation))).toEqual(first);
    expect(frames().filter((frame) => frame.phase === "accepted")).toEqual(acceptedFrames);
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000126" };
    expect((await port.transact({ operationId: "next-lease:1", execution: next, lease: { ...lease, leaseId: "next-lease" }, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: start("codex", next).input } })).kind).toBe("committed");
    const nextCut = recovery();
    await expect(port.transact(operation)).rejects.toThrow("matching execution lease");
    expect(recovery()).toEqual(nextCut);
  });

  it("keeps a committed prefix durable when receipt cleanup fails, and retires it before the next append", async () => {
    await send(1, start("codex"));
    db.run("CREATE TRIGGER fail_cleanup BEFORE DELETE ON canonical_writer_operation_receipts WHEN OLD.kind = 'append-accepted' BEGIN SELECT RAISE(FAIL, 'receipt cleanup unavailable'); END");
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "First", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(writer.pendingAcknowledgementCount).toBe(1);
    expect(recovery().savedThrough).toBe(recovery().acceptedThrough);
    expect(progress.savingStatuses(execution.threadId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 1 });
    db.run("DROP TRIGGER fail_cleanup");
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Second", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id IN (?, ?)")
      .all(`${execution.executionId}:raw:1`, `${execution.executionId}:raw:2`)).toHaveLength(2);
  });

  it("stops the exact active owner when receipt cleanup cannot fit its bounded retry queue without replaying saved events", async () => {
    await send(1, start("codex"));
    const error = new CanonicalWriterAcknowledgementCapacity("Receipt cleanup retention exhausted");
    vi.spyOn(writer, "acknowledgeOperation").mockRejectedValueOnce(error);
    const failures: string[] = [];
    progress.bindPermanentFailure(async (active, cause) => {
      expect(cause).toBe(error);
      failures.push(active.executionId);
      progress.interruptWorkerLoss({ execution: active, lease, reason: cause.message, recoveryIncidentId: "cleanup-capacity" });
    });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Already saved", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(failures).toEqual([execution.executionId]);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Interrupted" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?")
      .get(`${execution.executionId}:raw:1`)).toEqual({ count: 1 });
  });

  it("rejects all admission while a durable command is fenced or the service is closing", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Question", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const assistant = progress.latestAssistantMessage(execution.threadId);
    if (!assistant) throw new Error("Expected accepted question");
    const before = recovery();
    const publications = frames();
    await progress.beforeDurableCommand(execution.threadId);
    expect(() => progress.markPlanAnswered(execution.threadId, assistant.id)).toThrow("fenced");
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:3", execution, lease, ordinal: 3,
      mutation: { kind: "append-events", phase: "running", nativeCursor: null,
        events: [draft("codex", 2, "textDelta", { delta: "Later", isFinalResponse: true })] } };
    expect(() => progress.accept(operation)).toThrow("fenced");
    progress.cancelDurableCommand(execution.threadId);
    const closing = progress.close();
    expect(() => progress.accept(operation)).toThrow("closed");
    expect(() => progress.markPlanAnswered(execution.threadId, assistant.id)).toThrow("closed");
    await expect(progress.beforeDurableCommand(execution.threadId)).rejects.toThrow("closed");
    await closing;
    expect(() => progress.accept(operation)).toThrow("closed");
    expect(recovery()).toEqual(before);
    expect(frames()).toEqual(publications);
  });

  it("accepts a Devin session cursor and empty native completion through the execution writer", async () => {
    await send(1, start("devin"));
    holdWrites();
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "system", { subtype: "sdk_session_id:devin-native-session" })] })).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 2, "turnComplete")], terminalInput: { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    expect(recovery().retained.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(execution.threadId)).toEqual({ sdk_session_id: "devin-native-session" });
  });

  it("accepts a generic full assistant message after narration and tools before the terminal event", async () => {
    await send(1, start("devin"));
    holdWrites();
    const events = [draft("devin", 1, "textDelta", { delta: "PREFIX" }),
      draft("devin", 2, "assistantMessageBoundary", { isFinalResponse: false }),
      draft("devin", 3, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: { file_path: "file.txt" } }),
      draft("devin", 4, "toolResult", { toolCallId: "tool", output: "Read", isError: false }),
      draft("devin", 5, "textDelta", { delta: "AFTER_TOOL", isFinalResponse: true }),
      draft("devin", 6, "textDelta", { delta: "COMPLETE", isFinalResponse: true }),
      draft("devin", 7, "message", { content: "AFTER_TOOLCOMPLETE", tokens: null })];
    for (const [index, event] of events.entries()) {
      const reply = await send(index + 2, { kind: "event", phase: "running", nativeCursor: null, events: [event] });
      expect(reply.result.kind, JSON.stringify({ index, result: reply.result })).toBe("accepted");
    }
    expect((await send(9, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 8, "turnComplete")], terminalInput: { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
  });

  it("keeps the acknowledged recovery base unchanged when page2 fails, then retries without duplicate reduction or insert", async () => {
    await send(1, start("codex"));
    db.run("CREATE TRIGGER fail_page2 BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id LIKE '%:page:1' BEGIN SELECT RAISE(ABORT, 'page2 unavailable'); END");
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:2", execution, lease, ordinal: 2,
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      mutation: { kind: "finish-live-event", outcome: "completed", projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { content: "Answer", model: "fixture", attachments: [] }, narrative: Array.from({ length: 300 }, (_, i) => completedTool(i)) },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } } };
    const before = recovery();
    expect(progress.accept(operation).kind).toBe("accepted");
    await expect.poll(() => progress.savingStatuses(execution.threadId)[0]?.mode).toBe("saving-failed");
    const failed = recovery();
    expect(failed.savedThrough).toBe(0);
    expect(failed.durable).toEqual(before.durable);
    expect(failed.retained.length).toBeGreaterThan(256);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get()).toEqual({ count: 256 });
    db.run("DROP TRIGGER fail_page2");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = recovery();
    expect(saved.retained).toHaveLength(0);
    expect(saved.savedThrough).toBe(failed.acceptedThrough);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get())
      .toEqual({ count: failed.retained.length });
  });

  it("does not allocate live owners for completed history or report loss after same-runtime saved rehydration", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Saved running turn", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const running = recovery();
    for (let i = 0; i < 12; i += 1) {
      const threadId = `history-${i}`;
      insertThread(threadId);
      const history = progress.recover(threadId, { conversationRevision: 0, rosterRevision: 0 });
      expect(history.retained).toHaveLength(0);
    }
    const restored = progress.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: running.epoch, sequence: running.acceptedThrough });
    expect(restored.loss).toBe("none");
    expect(restored.epoch).toBe(running.epoch);
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "More", isFinalResponse: true })] })).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
  });

  it("accepts an exact worker-loss interruption and releases the worker while its text is still unsaved", async () => {
    await send(1, start("devin"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "textDelta", { delta: "Retained answer", isFinalResponse: true })] });
    const interrupted = progress.interruptWorkerLoss({ execution, lease, reason: "worker unavailable", recoveryIncidentId: "loss" });
    expect(interrupted.kind).toBe("accepted");
    expect((await send(3, { kind: "release", recovery: interrupted })).result.kind).toBe("released");
    const cut = recovery();
    expect(cut.retained.some((event) => event.payload.type === "turn.interrupted")).toBe(true);
    expect(cut.retained.some((event) => event.payload.type === "item.recorded"
      && event.payload.item.payload.projection === "message"
      && event.payload.item.payload.message.content === "Retained answer")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Interrupted" });
  });

  it("waits for accepted save capacity instead of rejecting a long provider stream", async () => {
    await send(1, start("codex"));
    holdWrites();
    let blocked: Promise<Awaited<ReturnType<typeof send>>> | undefined;
    let blockedOrdinal = 0;
    for (let ordinal = 2; ordinal < 2_500; ordinal += 1) {
      const index = ordinal - 2;
      const pair = Math.floor(index / 2);
      const toolCallId = `tool-${pair}`;
      const event = index % 2 === 0
        ? draft("codex", index + 1, "toolUse", { toolCallId, toolName: "Read", toolInput: { file_path: "file.txt" } })
        : draft("codex", index + 1, "toolResult", { toolCallId, output: "Done", isError: false });
      const pending = send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [event] });
      const settled = await Promise.race([pending.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
      if (!settled) {
        blocked = pending;
        blockedOrdinal = ordinal;
        break;
      }
      const reply = await pending;
      expect(reply.result.kind, JSON.stringify(reply.result)).toBe("accepted");
    }
    if (!blocked) throw new Error("Expected retained accepted progress to fill before ordinal 2500");
    expect(progress.depth().retained.bytes).toBeGreaterThan(7 * 1024 * 1024);
    release?.();
    await expect(blocked).resolves.toMatchObject({ result: { kind: "accepted" } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const terminal = await send(blockedOrdinal + 1, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 10_000, "turnComplete")], terminalInput: { ...execution, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(terminal.result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
  }, 30_000);

  it("reports a permanent save failure, interrupts the exact accepted execution and retries the retained batches", async () => {
    await send(1, start("codex"));
    db.run("CREATE TRIGGER fail_progress BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id = 'live-lease:2' BEGIN SELECT RAISE(ABORT, 'disk checkpoint unavailable'); END");
    const failures: string[] = [];
    progress.bindPermanentFailure(async (failed, error) => {
      failures.push(`${failed.executionId}:${error.message}`);
      progress.interruptWorkerLoss({ execution: failed, lease, reason: error.message, recoveryIncidentId: "save-failure" });
    });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Before failed save", isFinalResponse: true })] });
    await expect.poll(() => failures.length).toBe(1);
    expect(failures[0]).toContain(`${execution.executionId}:`);
    expect(failures[0]).toContain("disk checkpoint unavailable");
    expect(recovery().retained.some((event) => event.payload.type === "turn.interrupted")).toBe(true);
    await expect(progress.beforeDurableCommand(execution.threadId)).rejects.toThrow("disk checkpoint unavailable");
    db.run("DROP TRIGGER fail_progress");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Interrupted" });
    expect(failures).toHaveLength(1);
  });

  it("rejects durable command waiters after receipt processing fails without replaying the committed disk write", async () => {
    await send(1, start("codex"));
    const heldAppend = holdWrites();
    vi.spyOn(writer, "appendAccepted").mockImplementation(async (...args) => {
      const saved = await heldAppend(...args);
      return { ...saved, receipt: { ...saved.receipt, contentHash: "0".repeat(64) } };
    });
    const failures: string[] = [];
    progress.bindPermanentFailure(async (failed, error) => { failures.push(`${failed.executionId}:${error.message}`); });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Committed on disk", isFinalResponse: true })] });
    const waiter = progress.beforeDurableCommand(execution.threadId);
    const rejected = expect(waiter).rejects.toThrow("Saved receipt does not match");
    release?.();
    await rejected;
    await expect.poll(() => failures.length).toBe(1);
    expect(recovery().savedThrough).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get();
    expect(count).not.toEqual({ count: 0 });
    vi.restoreAllMocks();
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get()).toEqual(count);
    expect(recovery().retained).toHaveLength(0);
  });

  it("keeps an unsaved plan answer identity internal and publishes the complete terminal body with the same ID", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Question", isFinalResponse: true })] });
    const question = progress.latestAssistantMessage(execution.threadId);
    expect(question?.content).toBe("Question");
    if (!question) throw new Error("Accepted question must have a stable assistant identity");
    expect(progress.markPlanAnswered(execution.threadId, question.id)).toBe(true);
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(question.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT content, is_internal FROM messages WHERE id = ?").get(question.id)).toEqual({ content: "Question", is_internal: 1 });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: " answered", isFinalResponse: true })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT content, is_internal FROM messages WHERE id = ?").get(question.id)).toEqual({ content: "Question answered", is_internal: 0 });
  });

  it("certifies saved old generations across restart and reports only an actual missing accepted suffix", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Saved prefix", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = recovery();
    const restarted = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, () => {}), writer);
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: saved.epoch, sequence: saved.acceptedThrough }).loss).toBe("none");
    holdWrites();
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    const unsaved = recovery();
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: unsaved.epoch, sequence: unsaved.acceptedThrough }).loss).toBe("runtime-restarted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    await send(1, start("codex", next), next, { ...lease, leaseId: "next-lease" });
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: unsaved.epoch, sequence: unsaved.acceptedThrough }).loss).toBe("none");
    await restarted.close();
  });

  it("rejects existing durable command waiters on close while retaining the undispatched suffix", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "First", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Second", isFinalResponse: true })] });
    const waiting = progress.beforeDurableCommand(execution.threadId);
    const rejected = expect(waiting).rejects.toThrow("closing");
    const closing = progress.close();
    await rejected;
    release?.();
    await closing;
    expect(progress.depth().pending).toBe(1);
    expect(recovery().retained.some((event) => event.eventId === `${execution.executionId}:raw:2`)).toBe(true);
    expect(writer.appendAccepted).toHaveBeenCalledTimes(1);
  });
});
