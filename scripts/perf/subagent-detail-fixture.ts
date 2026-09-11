import "../../apps/server/node_modules/reflect-metadata/Reflect.js";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { CanonicalAgentEventSink } from "../../apps/server/src/features/agents/canonical/canonical-agent-event-sink.js";
import { MessageRepo } from "../../apps/server/src/features/agents/conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../apps/server/src/features/agents/tools/persistence/tool-call-record-repo.js";
import { WorkspaceRepo } from "../../apps/server/src/features/projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../apps/server/src/features/thread-control/persistence/thread-repo.js";
import { openDatabase } from "../../apps/server/src/runtime/persistence/sqlite/database.js";

const MARKER = "__mcode_perf_subagent_detail__";
const IDENTITY = "Fixture Performance Child";
const PROMPT = "Measure the child transcript with 250 completed tool calls and two active tool calls.";
const COMPLETED_TOOL_COUNT = 250;
const ACTIVE_TOOL_COUNT = 2;
const DESCRIPTOR_FILE = "subagent-detail-fixture.json";
const ELECTRON_DESCRIPTOR_FILE = "subagent-detail-fixture-electron.json";

interface Descriptor {
  marker: string;
  workspaceId: string;
  workspaceName: string;
  parentThreadId: string;
  childThreadId: string;
  identity: string;
  prompt: string;
  completedToolCount: number;
  activeToolCount: number;
  firstToolCallId: string;
  lastToolCallId: string;
  errorToolCallId: string;
  activeToolCommands: readonly string[];
}

function arg(name: string): string {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function descriptorPath(repoRoot: string): string {
  const requested = NodePath.resolve(repoRoot, arg("--descriptor"));
  const expected = [DESCRIPTOR_FILE, ELECTRON_DESCRIPTOR_FILE]
    .map((name) => NodePath.join(repoRoot, ".dev", "verification", "performance", name));
  if (!expected.includes(requested)) throw new Error(`--descriptor must name a supported performance fixture descriptor.`);
  return requested;
}

function databasePath(repoRoot: string): string {
  const requested = process.argv.includes("--db-path")
    ? NodePath.resolve(repoRoot, arg("--db-path"))
    : NodePath.join(repoRoot, ".dev", "db", "app.sqlite");
  const defaultPath = NodePath.join(repoRoot, ".dev", "db", "app.sqlite");
  const electronPath = NodePath.relative(NodePath.join(repoRoot, ".dev"), requested).replaceAll("\\", "/");
  if (requested !== defaultPath && !/^electron-performance-(production|profiling)\/runtime\/db\/app\.sqlite$/.test(electronPath)) {
    throw new Error("--db-path must name the worktree runtime database or the managed Electron performance database.");
  }
  return requested;
}

function recordCompletedBashCalls(sink: CanonicalAgentEventSink, childThreadId: string, nativeTurnId: string): void {
  for (let index = 0; index < COMPLETED_TOOL_COUNT; index += 1) {
    const nativeItemId = `fixture-completed-${index}`;
    const isError = index === 124;
    const suffix = String(index).padStart(3, "0");
    sink.recordCodexChildItem({ childThreadId, nativeTurnId, nativeItemId, eventKey: "started", kind: "tool-call", payload: { projection: "codexChildToolCall", toolName: "Bash", toolInput: { command: `printf fixture-completed-${suffix}` } } });
    sink.recordCodexChildItem({ childThreadId, nativeTurnId, nativeItemId, eventKey: "completed", kind: "tool-result", payload: { projection: "codexChildToolResult", output: isError ? `fixture command ${suffix} failed` : `fixture command ${suffix} completed`, isError } });
  }
}

function recordActiveBashCalls(sink: CanonicalAgentEventSink, childThreadId: string, nativeTurnId: string): void {
  for (let index = 0; index < ACTIVE_TOOL_COUNT; index += 1) {
    sink.recordCodexChildItem({ childThreadId, nativeTurnId, nativeItemId: `fixture-active-${index}`, eventKey: "started", kind: "tool-call", payload: { projection: "codexChildToolCall", toolName: "Bash", toolInput: { command: `printf fixture-active-${index}` } } });
  }
}

function verifyFixtureRecovery(sink: CanonicalAgentEventSink, parentThreadId: string, childThreadId: string): void {
  const recovery = sink.recoverThread(childThreadId, { conversationRevision: 0, rosterRevision: 0 });
  const canonicalItems = recovery.mode === "snapshot" ? Object.values(recovery.snapshot.state.items) : [];
  const narrativeItemCount = canonicalItems.filter((item) => item.kind !== "message").length;
  const completedResults = canonicalItems.filter((item) => item.payload.projection === "codexChildToolResult");
  if (narrativeItemCount !== COMPLETED_TOOL_COUNT * 2 + ACTIVE_TOOL_COUNT
    || completedResults.length !== COMPLETED_TOOL_COUNT
    || completedResults.filter((item) => item.payload.isError === true).length !== 1) throw new Error("Recovery source preflight did not retain 250 completed Bash calls with one error and two active calls.");
  const roster = sink.loadSubagentRoster({ owningParentThreadId: parentThreadId, limit: 100 });
  if (roster.active.length !== 1 || roster.active[0]?.id !== childThreadId) throw new Error("Fixture seed did not create one active child roster row.");
}

function createDescriptor(workspace: { id: string; name: string }, parentThreadId: string, childThreadId: string): Descriptor {
  return { marker: MARKER, workspaceId: workspace.id, workspaceName: workspace.name, parentThreadId, childThreadId, identity: IDENTITY, prompt: PROMPT, completedToolCount: COMPLETED_TOOL_COUNT, activeToolCount: ACTIVE_TOOL_COUNT, firstToolCallId: "fixture-completed-0", lastToolCallId: `fixture-completed-${COMPLETED_TOOL_COUNT - 1}`, errorToolCallId: "fixture-completed-124", activeToolCommands: ["printf fixture-active-0", "printf fixture-active-1"] };
}

function cleanupOwnedFixtureRows(repoRoot: string, db: ReturnType<typeof openDatabase>): void {
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.findByPath(NodePath.join(repoRoot, ".dev", "fixture-repo"));
  if (!workspace) return;
  const threads = new ThreadRepo(db);
  const ownedParents = threads.listAllByWorkspace(workspace.id)
    .filter((thread) => thread.title === MARKER);
  for (const parent of ownedParents) {
    if (!threads.hardDelete(parent.id)) throw new Error("Fixture cleanup could not delete an owned parent thread.");
  }
  if (threads.listAllByWorkspace(workspace.id).some((thread) => thread.title === MARKER)) {
    throw new Error("Fixture cleanup left owned parent threads behind.");
  }
}

function removeDescriptor(path: string): void {
  NodeFS.rmSync(path, { force: true });
}

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

function seed(repoRoot: string, path: string, dbPath: string): Descriptor {
  cleanup(repoRoot, path, dbPath);
  const db = openDatabase({ dbPath });
  try {
    const workspaces = new WorkspaceRepo(db);
    const threads = new ThreadRepo(db);
    const messages = new MessageRepo(db);
    const toolCalls = new ToolCallRecordRepo(db);
    const fixturePath = NodePath.join(repoRoot, ".dev", "fixture-repo");
    const workspace = workspaces.findByPath(fixturePath) ?? workspaces.create("fixture-repo", fixturePath);
    const parent = threads.create(workspace.id, MARKER, "local", "main", false, "codex");
    const sink = new CanonicalAgentEventSink(db, () => {});
    const parentTurnId = crypto.randomUUID();
    const parentExecutionId = crypto.randomUUID();
    const parentItemId = "toolCall:fixture-subagent";
    const nativeChildThreadId = crypto.randomUUID();
    const nativeChildTurnId = crypto.randomUUID();
    sink.startParentTurn({
      thread: { id: parent.id, workspaceId: workspace.id, providerId: "codex", createdAt: parent.created_at },
      turnId: parentTurnId,
      executionId: parentExecutionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(parent.id, "user", "Open the fixture subagent.", 1),
    });
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: parent.id,
      parentTurnId,
      parentExecutionId,
      parentItemId,
      receiverThreadIds: [nativeChildThreadId],
      prompt: PROMPT,
      identity: IDENTITY,
      providerIdentities: [],
    });
    const parentAssistant = messages.create(parent.id, "assistant", "Delegating to fixture subagent.", 2);
    toolCalls.create({
      toolCallId: parentItemId,
      messageId: parentAssistant.id,
      toolName: "Agent",
      displayName: IDENTITY,
      providerAgentKey: nativeChildThreadId,
      subagentIdentityKey: nativeChildThreadId,
      subagentProviderName: "codex",
      subagentPrompt: PROMPT,
      inputSummary: PROMPT,
      outputSummary: "",
      status: "running",
      startedAt: parent.created_at,
      sortOrder: 0,
    });
    sink.startCodexChildTurn({
      parentThreadId: parent.id,
      parentTurnId,
      parentExecutionId,
      parentItemId,
      nativeThreadId: nativeChildThreadId,
      nativeTurnId: nativeChildTurnId,
      prompt: PROMPT,
    });
    recordCompletedBashCalls(sink, delegation.childThread.id, nativeChildTurnId);
    recordActiveBashCalls(sink, delegation.childThread.id, nativeChildTurnId);
    verifyFixtureRecovery(sink, parent.id, delegation.childThread.id);
    const descriptor = createDescriptor(workspace, parent.id, delegation.childThread.id);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    return descriptor;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      cleanupOwnedFixtureRows(repoRoot, db);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      removeDescriptor(path);
    } catch (descriptorError) {
      failures.push(descriptorError);
    }
    throwCleanupFailures(failures, "Fixture seed failed and rollback was incomplete.");
    throw error;
  } finally { db.close(true); }
}

function cleanup(repoRoot: string, path: string, dbPath: string): void {
  const failures: unknown[] = [];
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase({ dbPath });
    cleanupOwnedFixtureRows(repoRoot, db);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      db?.close(true);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    removeDescriptor(path);
  } catch (error) {
    failures.push(error);
  }
  throwCleanupFailures(failures, "Fixture cleanup was incomplete.");
}

const action = arg("--action");
if (action !== "seed" && action !== "cleanup") throw new Error("--action must be seed or cleanup.");
const repoRoot = process.cwd();
const path = descriptorPath(repoRoot);
const dbPath = databasePath(repoRoot);
if (action === "seed") process.stdout.write(`${JSON.stringify(seed(repoRoot, path, dbPath))}\n`);
else cleanup(repoRoot, path, dbPath);
