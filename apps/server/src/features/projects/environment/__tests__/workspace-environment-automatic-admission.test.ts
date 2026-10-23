import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import type { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import type { WorkspaceEnvironmentService, WorkspaceEnvironmentServiceOptions } from "../workspace-environment-service.js";
import { WorkspaceEnvironmentAutomaticRepository } from "../workspace-environment-automatic-repository.js";
import type { TerminalCommandCloseResult, TerminalCommandCompletion, TerminalCommandPreparation } from "../../../terminal/commands/terminal-command-service.js";
import type { Database } from "bun:sqlite";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TurnRuntimeRegistry } from "../../../agents/turns/turn-runtime.js";
import { ThreadStartupFetchDecisions } from "../../../thread-startup/thread-startup-fetch-decisions.js";
import { routeThreadStartupRpc } from "../../../thread-startup/transport/thread-startup-rpc.js";

import { startupEnvironmentFixture } from "../testing/startup-environment-fixture.js";

const roots: string[] = [];
const services = new Set<WorkspaceEnvironmentService>();
const attachedThreadId = "00000000-0000-4000-8000-0000000000a1";
const siblingThreadId = "00000000-0000-4000-8000-0000000000a2";
const ownedDatabases = new Map<Database, OwnedTestDatabase>();
const readers = new Map<Database, Database>();
function openOwnedDatabase(): Database { const owned = createOwnedTestDatabase(); ownedDatabases.set(owned.db, owned); return owned.db; }
function databaseWriter(db: Database): ApplicationDatabaseWriter { const writer = ownedDatabases.get(db)?.writer; if (!writer) throw new Error("Missing test database owner"); return writer; }
function databaseReader(db: Database): Database {
  let reader = readers.get(db);
  if (!reader) { reader = openReadOnlyDatabase(db.filename); readers.set(db, reader); }
  return reader;
}

afterEach(async () => {
  for (const service of services) await service.dispose();
  services.clear();
  for (const reader of readers.values()) reader.close(true);
  readers.clear();
  for (const owned of ownedDatabases.values()) await owned.close();
  ownedDatabases.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 1 });
}

async function automaticHarness({ setup = true, prepareFailure = false, attachmentStorage, threadStartups, threadIds = ["thread-1"], managed = true }: {
  readonly setup?: boolean;
  readonly managed?: boolean;
  readonly prepareFailure?: boolean;
  readonly attachmentStorage?: WorkspaceEnvironmentServiceOptions["attachmentStorage"];
  readonly threadStartups?: WorkspaceEnvironmentServiceOptions["threadStartups"]
    | ((database: Database, writer: ApplicationDatabaseWriter) => NonNullable<WorkspaceEnvironmentServiceOptions["threadStartups"]>);
  readonly threadIds?: readonly string[];
} = {}) {
  const fixture = NodePath.resolve("../..", ".dev/fixture-repo");
  await NodeFSPromises.mkdir(fixture, { recursive: true });
  const root = await NodeFSPromises.mkdtemp(NodePath.join(fixture, "mcode-automatic-setup-"));
  roots.push(root);
  const db = openOwnedDatabase();
  let milliseconds = Date.parse("2026-08-24T12:00:00.000Z");
  db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES ('workspace-1', 'Project', '/project', '{}')").run();
  for (const threadId of threadIds) {
    db.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, worktree_path, provider) VALUES (?, 'workspace-1', 'First Turn', 'worktree', 'main', ?, ?, 'claude')").run(threadId, Number(managed), `/project/.worktrees/${threadId}`);
  }
  const completion = deferred<TerminalCommandCompletion>();
  const start = vi.fn(() => completion.promise);
  const close = vi.fn(async (): Promise<TerminalCommandCloseResult> => ({ kind: "contained" }));
  const prepare = vi.fn(async (_input?: unknown): Promise<TerminalCommandPreparation> => {
    if (prepareFailure) throw new Error("terminal preparation failed");
    return {
      kind: "ready" as const,
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    };
  });
  const terminalCommands = {
    prepare,
  };
  const threads = new ThreadRepo(databaseReader(db), databaseWriter(db));
  const runtimes = new TurnRuntimeRegistry();
  const startups = new ThreadStartupService(new ThreadStartupRepo(databaseReader(db), databaseWriter(db)), databaseWriter(db));
  const service = startupEnvironmentFixture({
    mcodeDir: root,
    database: databaseReader(db),
    databaseWriter: databaseWriter(db),
    threads,
    runtimePhase: (id) => runtimes.snapshot(id)?.phase,
    terminalCommands,
    attachmentStorage,
    threadStartups: typeof threadStartups === "function" ? threadStartups(databaseReader(db), databaseWriter(db)) : threadStartups ?? startups,
    platform: "linux",
    now: () => new Date(milliseconds++),
  });
  services.add(service);
  if (setup) {
    await service.save({
      workspaceId: "workspace-1",
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { default: "bun run setup" }, runOnStartup: true }] },
    });
  }
  const repository = new WorkspaceEnvironmentAutomaticRepository(databaseReader(db), () => new Date(milliseconds++).toISOString(), databaseWriter(db));
  return { root, db, service, repository, completion, start, close, prepare, terminalCommands, threads, startups, runtimes };
}

async function startAttached(startups: ThreadStartupService, threadId = "thread-1", startupId = "00000000-0000-4000-8000-000000000001") {
  await startups.start({ startupId, workspaceId: "workspace-1", kind: "attached-worktree" });
  await startups.advance(startupId, "thread");
  await startups.bindThread(startupId, threadId);
  await startups.advance(startupId, "worktree");
  await startups.advance(startupId, "setup");
  return startupId;
}

function queuedInput(index = 1, threadId = "thread-1") {
  const messageId = `message-${index}`;
  const content = index === 1 ? "Build the feature" : `Build the feature ${index}`;
  return {
    threadId,
    messageId,
    content,
    attachments: [],
    mentions: [],
    submission: {
      threadId,
      messageId,
      content,
      displayContent: content,
      model: "claude-sonnet-4-6",
      permissionMode: "default" as const,
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    },
  };
}

describe("startup action gate admission and recovery", () => {
  it("allows stopping an attached worktree before automatic admission", async () => {
    const { service, start, close } = await automaticHarness({ managed: false });
    expect(await service.stopAutomaticSetup({ threadId: "thread-1" })).toEqual({
      gate: "not-required", attempt: null, queuedTurns: [],
    });
    expect(start).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("queues an attached first prompt until Setup passes", async () => {
    const { service, startups, completion, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId] });
    await startAttached(startups, attachedThreadId);
    const dispatched: string[] = [];
    service.setAutomaticSetupDispatcher({ dispatch: async (submission) => {
      dispatched.push(submission.content);
      return { completion: Promise.resolve() };
    } });
    expect(await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId))).toMatchObject({
      gate: "blocked", queuedTurns: [{ state: "queued", messageId: "message-1" }],
    });
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    expect(dispatched).toEqual([]);
    expect(startups.findByThreadId(attachedThreadId)).toMatchObject({ state: "running", phase: "setup" });
    completion.resolve({ kind: "exited", exitCode: 0, output: "ready", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({
      gate: "released-by-pass", queuedTurns: [{ state: "dispatched" }],
    }));
    expect(dispatched).toEqual(["Build the feature"]);
  });

  it.each(["running", "finalizing", "starting-agent"] as const)("skips Setup for a %s sibling in the same worktree", async (phase) => {
    const { service, threads, startups, runtimes, prepare } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `\\project\\.worktrees\\${attachedThreadId}\\`);
    await startAttached(startups, attachedThreadId);
    if (phase === "starting-agent") {
      const startupId = await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
      await startups.advance(startupId, "agent");
    }
    else runtimes.hydrate([{ threadId: siblingThreadId, turnExecutionId: "execution", phase }]);
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({
      gate: "not-required", queuedTurns: [{ state: "released" }],
    }));
    expect(startups.findByThreadId(attachedThreadId)?.steps[2]).toMatchObject({
      state: "skipped", detail: { phase: "setup", skipReason: "thread-running-here" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serializes starts in one worktree through command preparation", async () => {
    const { service, threads, startups, prepare, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}/`);
    await startAttached(startups, attachedThreadId);
    const preparation = deferred<void>();
    const executor = prepare.getMockImplementation();
    if (!executor) throw new Error("Missing terminal executor");
    prepare.mockImplementation(async () => { await preparation.promise; return executor(); });
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
    await service.queueAutomaticFirstTurn(queuedInput(2, siblingThreadId));
    preparation.resolve();
    await eventually(() => expect(service.getAutomaticSetup({ threadId: siblingThreadId }).gate).toBe("not-required"));
    expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "blocked", attempt: { state: "running" } });
    expect(startups.findByThreadId(siblingThreadId)?.steps[2].detail).toEqual({ phase: "setup", skipReason: "thread-running-here" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("runs Setup once when two starts reach Setup before either is admitted", async () => {
    const { service, threads, startups, prepare, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}`);
    await startAttached(startups, attachedThreadId);
    await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
    await Promise.all([
      service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId)),
      service.queueAutomaticFirstTurn(queuedInput(2, siblingThreadId)),
    ]);
    await eventually(() => expect(service.getAutomaticSetup({ threadId: siblingThreadId }).gate).toBe("not-required"));
    expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "blocked", attempt: { state: "running" } });
    expect(startups.findByThreadId(siblingThreadId)?.steps[2].detail).toEqual({ phase: "setup", skipReason: "thread-running-here" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("runs Setup for the first start when a sibling startup has not reached admission", async () => {
    const { service, threads, startups, prepare, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}`);
    await startAttached(startups, attachedThreadId);
    await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "blocked", attempt: { state: "running" } }));
    await service.queueAutomaticFirstTurn(queuedInput(2, siblingThreadId));
    await eventually(() => expect(service.getAutomaticSetup({ threadId: siblingThreadId }).gate).toBe("not-required"));
    expect(startups.findByThreadId(siblingThreadId)?.steps[2].detail).toEqual({ phase: "setup", skipReason: "thread-running-here" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("skips Setup while a sibling whose Setup passed has not started its agent", async () => {
    const { service, threads, startups, completion, prepare } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}`);
    await startAttached(startups, attachedThreadId);
    await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    completion.resolve({ kind: "exited", exitCode: 0, output: "ready", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: attachedThreadId }).attempt?.state).toBe("passed"));
    expect(startups.findByThreadId(attachedThreadId)).toMatchObject({ state: "running", phase: "setup" });
    await service.queueAutomaticFirstTurn(queuedInput(2, siblingThreadId));
    await eventually(() => expect(service.getAutomaticSetup({ threadId: siblingThreadId }).gate).toBe("not-required"));
    expect(startups.findByThreadId(siblingThreadId)?.steps[2].detail).toEqual({ phase: "setup", skipReason: "thread-running-here" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("matches Windows path casing when checking live siblings", async () => {
    const { service, threads, runtimes, prepare } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    vi.spyOn(service, "platform").mockReturnValue("windows");
    await threads.updateWorktreePath(attachedThreadId, "C:\\Project\\Worktree");
    await threads.updateWorktreePath(siblingThreadId, "c:/project/worktree/");
    runtimes.start(siblingThreadId);
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "not-required", queuedTurns: [{ state: "released" }] }));
    expect(prepare).not.toHaveBeenCalled();
  });

  it("releases the worktree lock after a failed sibling lookup", async () => {
    const { service, threads, startups, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}`);
    const firstStartupId = await startAttached(startups, attachedThreadId);
    vi.spyOn(threads, "listAllByWorkspace").mockImplementationOnce(() => { throw new Error("Database read unavailable"); });
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(startups.get(firstStartupId)).toMatchObject({ state: "blocked", block: { code: "SETUP_PERSISTENCE_FAILED" } }));
    expect(start).not.toHaveBeenCalled();
    await startups.markCancelled(firstStartupId);
    await startAttached(startups, siblingThreadId, "00000000-0000-4000-8000-000000000002");
    await service.queueAutomaticFirstTurn(queuedInput(2, siblingThreadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    expect(service.getAutomaticSetup({ threadId: siblingThreadId })).toMatchObject({ gate: "blocked", attempt: { state: "running" } });
  });

  it.each(["deleted", "idle", "finished-startup", "different-path"])("runs Setup when the sibling is %s", async (state) => {
    const { service, db, threads, startups, runtimes, start } = await automaticHarness({ managed: false, threadIds: [attachedThreadId, siblingThreadId] });
    if (state !== "different-path") await threads.updateWorktreePath(siblingThreadId, `/project/.worktrees/${attachedThreadId}`);
    if (state === "deleted") db.prepare("UPDATE threads SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), siblingThreadId);
    if (state === "deleted" || state === "different-path") runtimes.start(siblingThreadId);
    if (state === "finished-startup") {
      const startupId = await startAttached(startups, siblingThreadId);
      await startups.advance(startupId, "agent");
      await startups.complete(startupId);
    }
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "blocked", attempt: { state: "running" } });
  });

  it("cancels attached startup and contains its Setup command", async () => {
    const { service, startups, start, close } = await automaticHarness({ managed: false, threadIds: [attachedThreadId] });
    const startupId = await startAttached(startups, attachedThreadId);
    await service.queueAutomaticFirstTurn(queuedInput(1, attachedThreadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    await routeThreadStartupRpc("thread.startup.cancel", { startupId }, {
      threadStartupService: startups,
      threadStartupFetchDecisions: new ThreadStartupFetchDecisions(),
      workspaceEnvironmentService: service,
      agentService: { stopSession: async () => { throw new Error("Provider must not have started"); } },
    });
    expect(startups.get(startupId)).toMatchObject({ state: "cancelled", phase: "setup", cancellation: "requested" });
    expect(service.getAutomaticSetup({ threadId: attachedThreadId })).toMatchObject({ gate: "not-required", queuedTurns: [{ state: "cancelled" }] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("persists the visible first Turn before Setup, then commits pass and release before dispatch", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatch = vi.fn(async () => {
      expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
        gate: "released-by-pass",
        attempt: { state: "passed" },
        queuedTurns: [{ state: "dispatching" }],
      });
      return { completion: Promise.resolve() };
    });
    service.setAutomaticSetupDispatcher({ dispatch });

    expect(await service.queueAutomaticFirstTurn(queuedInput())).toMatchObject({
      gate: "blocked",
      attempt: { state: "queued" },
      queuedTurns: [{ state: "queued", messageId: "message-1" }],
    });
    expect((db.prepare("SELECT content FROM messages WHERE id = 'message-1'").get() as { content: string }).content).toBe("Build the feature");

    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await eventually(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" })));

    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]?.state).toBe("dispatched"));
    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "released-by-pass",
      attempt: {
        state: "passed",
        failedActionId: null,
      },
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
  });

  it("persists selected-text comments unchanged while automatic Setup queues the Turn", async () => {
    const { db, service } = await automaticHarness();
    const selectedTextComments = [{
      id: "76da3c6e-6b42-4c01-aaf2-3ad0b29a4756",
      displayNumber: 1 as const,
      source: {
        threadId: "thread-1",
        messageId: "assistant-1",
        sourceRole: "assistant" as const,
        start: 0,
        end: 11,
        quote: "Select this",
      },
      note: "Explain this.",
      mentions: [],
    }];
    const input = queuedInput();

    await service.queueAutomaticFirstTurn({
      ...input,
      submission: { ...input.submission, selectedTextComments },
    });

    expect(JSON.parse((db.prepare(
      "SELECT selected_text_comments FROM messages WHERE id = 'message-1'",
    ).get() as { selected_text_comments: string }).selected_text_comments)).toEqual(selectedTextComments);
    expect(JSON.parse((db.prepare(
      "SELECT submission_json FROM workspace_environment_queued_turns WHERE message_id = 'message-1'",
    ).get() as { submission_json: string }).submission_json).selectedTextComments).toEqual(selectedTextComments);
  });

  it("releases a managed New worktree without Setup and dispatches without launching Terminal Setup", async () => {
    const { service, start, prepare } = await automaticHarness({ setup: false });
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });

    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" })));

    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]?.state).toBe("dispatched"));
    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
  });

  it("rejects the next active queued Turn at the per-Thread capacity boundary", async () => {
    const { service } = await automaticHarness();

    for (let index = 1; index <= 64; index += 1) await service.queueAutomaticFirstTurn(queuedInput(index));

    let error: unknown;
    try {
      await service.queueAutomaticFirstTurn(queuedInput(65));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY" });
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toHaveLength(64);
  });

  it("stores Fast under the key older builds parse and reads either key back", async () => {
    const { db, service, repository } = await automaticHarness();
    const input = queuedInput();
    await service.queueAutomaticFirstTurn({ ...input, submission: { ...input.submission, fastMode: true } });
    await service.queueAutomaticFirstTurn(queuedInput(2));
    const stored = JSON.parse((db.prepare(
      "SELECT submission_json FROM workspace_environment_queued_turns WHERE message_id = 'message-1'",
    ).get() as { submission_json: string }).submission_json) as Record<string, unknown>;
    expect(stored).toMatchObject({ codexFastMode: true });
    expect(stored).not.toHaveProperty("fastMode");
    // A row written by an older build.
    db.prepare("UPDATE workspace_environment_queued_turns SET submission_json = ? WHERE message_id = 'message-2'")
      .run(JSON.stringify({ ...queuedInput(2).submission, codexFastMode: false }));

    await repository.releaseWithoutSetup("thread-1");
    const first = await repository.claimReleasedTurn("thread-1");
    if (!first) throw new Error("Expected a released Turn");
    expect(first.submission.fastMode).toBe(true);
    await repository.markDispatched(first.id);
    expect((await repository.claimReleasedTurn("thread-1"))?.submission.fastMode).toBe(false);
  });

  it("retains only the latest terminal queued Turns without pruning active rows", async () => {
    const { service, repository } = await automaticHarness();
    for (let index = 1; index <= 34; index += 1) await service.queueAutomaticFirstTurn(queuedInput(index));

    await repository.releaseWithoutSetup("thread-1");
    for (let index = 1; index <= 33; index += 1) {
      const claimed = await repository.claimReleasedTurn("thread-1");
      if (!claimed) throw new Error("Expected a released Turn");
      expect(claimed.submission.messageId).toBe(`message-${index}`);
      expect(await repository.markDispatched(claimed.id)).toBe(true);
    }

    const snapshot = service.getAutomaticSetup({ threadId: "thread-1" });
    expect(snapshot.queuedTurns.map(({ messageId, state }) => ({ messageId, state }))).toEqual([
      ...Array.from({ length: 32 }, (_, index) => ({ messageId: `message-${index + 2}`, state: "dispatched" })),
      { messageId: "message-34", state: "released" },
    ]);
  });

  it("keeps a failed Setup gate blocked and never dispatches its first Turn", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: {
        state: "failed",
        reason: "setup_failed",
        failedActionId: "setup",
      },
      queuedTurns: [{ state: "queued" }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists multiple blocked Turns and releases them FIFO exactly once", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });

    await service.queueAutomaticFirstTurn(queuedInput());
    await service.queueAutomaticFirstTurn(queuedInput(2));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    await Promise.all([
      service.continueAutomaticSetup({ threadId: "thread-1" }),
      service.continueAutomaticSetup({ threadId: "thread-1" }),
    ]);

    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([submission]) => submission.messageId)).toEqual(["message-1", "message-2"]);
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
  });

  it("serializes released Turns until the prior provider Turn completes without blocking duplicate Continue calls", async () => {
    const { service, start, completion } = await automaticHarness();
    const firstCompletion = deferred<void>();
    const dispatchedMessages: string[] = [];
    const dispatch = vi.fn(async (submission: { readonly messageId: string }) => {
      dispatchedMessages.push(submission.messageId);
      return { completion: submission.messageId === "message-1" ? firstCompletion.promise : Promise.resolve() };
    });
    service.setAutomaticSetupDispatcher({ dispatch });
    await service.queueAutomaticFirstTurn(queuedInput());
    await service.queueAutomaticFirstTurn(queuedInput(2));
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    await Promise.all([
      service.continueAutomaticSetup({ threadId: "thread-1" }),
      service.continueAutomaticSetup({ threadId: "thread-1" }),
    ]);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatchedMessages).toEqual(["message-1"]);
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toMatchObject([
      { messageId: "message-1", state: "dispatched" },
      { messageId: "message-2", state: "released" },
    ]);

    firstCompletion.resolve();
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatchedMessages).toEqual(["message-1", "message-2"]);
  });

  it("dispatches equal-timestamp queued Turns in durable admission order", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatched: string[] = [];
    service.setAutomaticSetupDispatcher({
      dispatch: vi.fn(async (submission) => {
        dispatched.push(submission.messageId);
        return { completion: Promise.resolve() };
      }),
    });
    await service.queueAutomaticFirstTurn(queuedInput());
    await service.queueAutomaticFirstTurn(queuedInput(2));
    await service.queueAutomaticFirstTurn(queuedInput(3));
    db.prepare("UPDATE workspace_environment_queued_turns SET created_at = ? WHERE thread_id = ?")
      .run("2026-08-24T12:00:00.000Z", "thread-1");
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    await service.continueAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(dispatched).toHaveLength(3));

    expect(dispatched).toEqual(["message-1", "message-2", "message-3"]);
  });

  it("joins delayed automatic preparation and closes the late command before Thread deletion returns", async () => {
    const { service, prepare } = await automaticHarness();
    const pending = deferred<TerminalCommandPreparation>();
    const start = vi.fn(() => new Promise<TerminalCommandCompletion>(() => undefined));
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    prepare.mockImplementation(() => pending.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginThreadDeletion("thread-1");
    const deleting = service.cancelSetupForThread("thread-1");
    let returned = false;
    void deleting.then(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);

    pending.resolve({
      kind: "ready",
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    });

    await deleting;
    expect(close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    releaseDeletion();
  });

  it("joins delayed automatic preparation and closes the late command before workspace deletion returns", async () => {
    const { service, prepare } = await automaticHarness();
    const pending = deferred<TerminalCommandPreparation>();
    const start = vi.fn(() => new Promise<TerminalCommandCompletion>(() => undefined));
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    prepare.mockImplementation(() => pending.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginWorkspaceDeletion("workspace-1");
    const deleting = service.cancelSetupForWorkspace("workspace-1");
    pending.resolve({
      kind: "ready",
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    });

    await deleting;
    expect(close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    releaseDeletion();
  });

  it("prevents a delayed automatic environment read from launching Setup while disposal joins it", async () => {
    const { service, prepare } = await automaticHarness();
    const pendingRead = deferred<Awaited<ReturnType<WorkspaceEnvironmentService["read"]>>>();
    vi.spyOn(service, "read").mockReturnValue(pendingRead.promise);
    await service.queueAutomaticFirstTurn(queuedInput());

    const disposing = service.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    pendingRead.resolve({
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
      revision: "current",
      status: "present",
    });

    await disposing;
    expect(prepare).not.toHaveBeenCalled();
  });

  it("closes a running automatic command before Thread deletion cleanup returns", async () => {
    const { service, close, start } = await automaticHarness();
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginThreadDeletion("thread-1");
    await service.cancelSetupForThread("thread-1");

    expect(close).toHaveBeenCalledOnce();
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("interrupted");
    releaseDeletion();
  });

  it("settles Continue and reconciliation when a released queued submission is malformed", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatch = vi.fn();
    service.setAutomaticSetupDispatcher({ dispatch });
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    db.prepare("UPDATE workspace_environment_queued_turns SET submission_json = ? WHERE thread_id = ?")
      .run("{", "thread-1");

    await expect(service.continueAutomaticSetup({ threadId: "thread-1" })).resolves.toMatchObject({
      gate: "released-by-continue",
      queuedTurns: [{ state: "released" }],
    });
    await expect(service.reconcileAutomaticSetup()).resolves.toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toMatchObject([{ state: "released" }]);
  });

  it("keeps a failed dispatcher claim stable across restart without redispatching", async () => {
    const { root, db, service, completion, start, terminalCommands } = await automaticHarness();
    const failedDispatch = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    service.setAutomaticSetupDispatcher({ dispatch: failedDispatch });
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await eventually(() => expect(failedDispatch).toHaveBeenCalledOnce());
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]).toMatchObject({ state: "dispatching", dispatchedAt: null });

    const reloaded = startupEnvironmentFixture({
      mcodeDir: root,
      database: databaseReader(db),
    databaseWriter: databaseWriter(db),
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true, worktree_path: "/project/.worktrees/first" } : null },
      terminalCommands,
      platform: "linux",
    });
    const redispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    reloaded.setAutomaticSetupDispatcher({ dispatch: redispatch });
    await reloaded.reconcileAutomaticSetup();

    expect(redispatch).not.toHaveBeenCalled();
    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]).toMatchObject({ state: "dispatching", dispatchedAt: null });
  });

  it("stops a normal closeable automatic Setup command without releasing its queued Turns", async () => {
    const { service, close, start } = await automaticHarness();
    const containment = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await containment.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    let resolved = false;
    void stopping.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    containment.resolve({ kind: "contained" });
    const stopped = await stopping;

    expect(close).toHaveBeenCalledOnce();
    expect(stopped).toMatchObject({
      gate: "blocked",
      attempt: { state: "interrupted", reason: "setup_interrupted" },
      queuedTurns: [{ state: "queued", messageId: "message-1" }],
    });
  });

  it("waits for Stop to close the prior automatic Setup command before Retry prepares another", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prepare).toHaveBeenCalledOnce();
    closeCompletion.resolve({ kind: "contained" });
    await Promise.all([stopping, retrying]);
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(2));
  });

  it("does not let a Retry requested before Stop prepare a replacement while Stop closes the active command", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());

    expect(prepare).toHaveBeenCalledOnce();
    closeCompletion.resolve({ kind: "contained" });
    const [, retried] = await Promise.all([stopping, retrying]);

    expect(retried).toMatchObject({ gate: "blocked", attempt: { state: "interrupted" } });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("keeps automatic Setup ownership after containment failure and rejects Retry and disposal", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    close.mockResolvedValue({ kind: "containment_failure" });
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await expect(service.stopAutomaticSetup({ threadId: "thread-1" })).rejects.toThrow(Error);
    await expect(service.retryAutomaticSetup({ threadId: "thread-1" })).rejects.toThrow(Error);
    await expect(service.dispose()).rejects.toThrow(Error);
    services.delete(service);

    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("joins a pending Stop close before Thread deletion, workspace deletion, or disposal returns", async () => {
    const actions = [
      async (service: WorkspaceEnvironmentService) => {
        const release = service.beginThreadDeletion("thread-1");
        try {
          await service.cancelSetupForThread("thread-1");
        } finally {
          release();
        }
      },
      async (service: WorkspaceEnvironmentService) => {
        const release = service.beginWorkspaceDeletion("workspace-1");
        try {
          await service.cancelSetupForWorkspace("workspace-1");
        } finally {
          release();
        }
      },
      async (service: WorkspaceEnvironmentService) => await service.dispose(),
    ];

    for (const action of actions) {
      const { service, close, start } = await automaticHarness();
      const closeCompletion = deferred<{ readonly kind: "contained" }>();
      close.mockImplementationOnce(async () => await closeCompletion.promise);
      await service.queueAutomaticFirstTurn(queuedInput());
      await eventually(() => expect(start).toHaveBeenCalledOnce());

      const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
      await eventually(() => expect(close).toHaveBeenCalledOnce());
      const cancelling = action(service);
      let returned = false;
      void cancelling.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);

      closeCompletion.resolve({ kind: "contained" });
      await Promise.all([stopping, cancelling]);
    }
  });

  it("rejects Continue after concurrent deletion and joins its accepted drain before cleanup returns", async () => {
    const { service, completion, start } = await automaticHarness();
    const accepted = deferred<{ readonly completion: Promise<void> }>();
    const firstTurnCompletion = deferred<void>();
    const dispatch = vi.fn(async () => await accepted.promise);
    service.setAutomaticSetupDispatcher({ dispatch });
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    const continuing = service.continueAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce());
    const releaseDeletion = service.beginThreadDeletion("thread-1");
    const deleting = service.cancelSetupForThread("thread-1");
    accepted.resolve({ completion: firstTurnCompletion.promise });

    await expect(continuing).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });
    let deleted = false;
    void deleting.then(() => { deleted = true; });
    await Promise.resolve();
    expect(deleted).toBe(false);

    firstTurnCompletion.resolve();
    await deleting;
    releaseDeletion();
  });

  it("rejects Retry after its pending Stop close completes during Thread deletion", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    const releaseDeletion = service.beginThreadDeletion("thread-1");
    closeCompletion.resolve({ kind: "contained" });

    await stopping;
    await expect(retrying).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });
    expect(prepare).toHaveBeenCalledOnce();
    releaseDeletion();
  });

  it("preserves a Continue release without recording Setup as passed", async () => {
    const { root, db, service, start, completion, terminalCommands } = await automaticHarness();
    await service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    await service.continueAutomaticSetup({ threadId: "thread-1" });

    const reloaded = startupEnvironmentFixture({
      mcodeDir: root,
      database: databaseReader(db),
    databaseWriter: databaseWriter(db),
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true, worktree_path: "/project/.worktrees/first" } : null },
      terminalCommands,
      platform: "linux",
    });
    await reloaded.reconcileAutomaticSetup();

    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "released-by-continue",
      attempt: { state: "failed", reason: "setup_failed" },
      queuedTurns: [{ state: "released", dispatchedAt: null }],
    });
  });

  it("resumes an interrupted startup into its agent phase and dispatches the queued Turn on Continue", async () => {
    let startups!: ThreadStartupService;
    const startupId = "00000000-0000-4000-8000-0000000000aa";
    const threadId = "00000000-0000-4000-8000-0000000000a1";
    const { service, start } = await automaticHarness({
      threadIds: [threadId],
      threadStartups: (database, writer) => {
        startups = new ThreadStartupService(new ThreadStartupRepo(database, writer), writer, () => new Date());
        return startups;
      },
    });
    await startups.start({ startupId, workspaceId: "workspace-1", kind: "managed-worktree" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, threadId);
    await startups.advance(startupId, "worktree");
    await startups.advance(startupId, "setup");
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });

    await service.queueAutomaticFirstTurn(queuedInput(1, threadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await startups.interruptNonterminalOnStartup();
    await service.reconcileAutomaticSetup();
    expect(startups.findByThreadId(threadId)?.state).toBe("interrupted");

    const snapshot = await service.continueAutomaticSetup({ threadId });

    expect(snapshot.gate).toBe("released-by-continue");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(startups.findByThreadId(threadId)).toMatchObject({ state: "running", phase: "agent" });
    expect(startups.findByThreadId(threadId)?.steps[2].detail).toMatchObject({ phase: "setup", skipReason: "user-skipped", actions: [{ actionId: "setup", outcome: "running" }] });
  });

  async function failedAgentStartup() {
    let startups!: ThreadStartupService;
    const startupId = "00000000-0000-4000-8000-0000000000bb";
    const threadId = "00000000-0000-4000-8000-0000000000b1";
    const harness = await automaticHarness({
      setup: false,
      threadIds: [threadId],
      threadStartups: (database, writer) => {
        startups = new ThreadStartupService(new ThreadStartupRepo(database, writer), writer, () => new Date());
        return startups;
      },
    });
    await startups.start({ startupId, workspaceId: "workspace-1", kind: "managed-worktree" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, threadId);
    await startups.advance(startupId, "worktree");
    await startups.advance(startupId, "setup");
    const dispatch = vi.fn(async () => {
      await startups.advance(startupId, "agent");
      await startups.fail(startupId, { code: "AGENT_START_FAILED", message: "Agent startup failed", retryable: true });
      throw new Error("provider unavailable");
    });
    harness.service.setAutomaticSetupDispatcher({ dispatch });
    await harness.service.queueAutomaticFirstTurn(queuedInput(1, threadId));
    await eventually(() => expect(startups.findByThreadId(threadId)?.state).toBe("failed"));
    return { ...harness, startups, threadId, dispatch };
  }

  it("sends the unsent first message again when the agent failed before taking it", async () => {
    const { service, startups, threadId, dispatch } = await failedAgentStartup();
    expect(service.getAutomaticSetup({ threadId }).queuedTurns[0]).toMatchObject({ state: "dispatching" });
    dispatch.mockImplementationOnce(async () => ({ completion: Promise.resolve() }));

    await service.retryAutomaticAgentStart({ threadId });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]).toEqual(dispatch.mock.calls[0]);
    expect(service.getAutomaticSetup({ threadId }).queuedTurns).toMatchObject([{ messageId: "message-1", state: "dispatched" }]);
    expect(startups.findByThreadId(threadId)).toMatchObject({ state: "running", phase: "agent" });
    expect(startups.findByThreadId(threadId)).not.toHaveProperty("error");
  });

  it("fails the agent again when the resent first message cannot be dispatched", async () => {
    const { service, startups, threadId, dispatch } = await failedAgentStartup();

    await service.retryAutomaticAgentStart({ threadId });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(service.getAutomaticSetup({ threadId }).queuedTurns[0]).toMatchObject({ state: "dispatching" });
    expect(startups.findByThreadId(threadId)).toMatchObject({ state: "failed", phase: "agent", error: { code: "AGENT_START_FAILED" } });
  });

  it("refuses to resend once the first message reached the runtime", async () => {
    const { service, repository, startups, threadId } = await failedAgentStartup();
    const [claim] = service.getAutomaticSetup({ threadId }).queuedTurns;
    await repository.markDispatched(claim!.id);

    await expect(service.retryAutomaticAgentStart({ threadId })).rejects.toThrow("This thread has no unsent first message to retry");
    expect(startups.findByThreadId(threadId)).toMatchObject({ state: "failed", phase: "agent" });
  });

  it("settles an interrupted startup whose gate can no longer offer recovery", async () => {
    let startups!: ThreadStartupService;
    const startupId = "00000000-0000-4000-8000-0000000000cc";
    const threadId = "00000000-0000-4000-8000-0000000000c1";
    const { service } = await automaticHarness({
      threadIds: [threadId],
      threadStartups: (database, writer) => {
        startups = new ThreadStartupService(new ThreadStartupRepo(database, writer), writer, () => new Date());
        return startups;
      },
    });
    await startups.start({ startupId, workspaceId: "workspace-1", kind: "direct" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, threadId);
    await startups.interruptNonterminalOnStartup();
    expect(startups.findByThreadId(threadId)?.state).toBe("interrupted");

    await service.reconcileAutomaticSetup();

    expect(startups.findByThreadId(threadId)?.state).toBe("completed");
  });

  it("keeps an interrupted startup when its interrupted attempt still offers recovery", async () => {
    let startups!: ThreadStartupService;
    const startupId = "00000000-0000-4000-8000-0000000000dd";
    const threadId = "00000000-0000-4000-8000-0000000000d1";
    const { service, start } = await automaticHarness({
      threadIds: [threadId],
      threadStartups: (database, writer) => {
        startups = new ThreadStartupService(new ThreadStartupRepo(database, writer), writer, () => new Date());
        return startups;
      },
    });
    await startups.start({ startupId, workspaceId: "workspace-1", kind: "managed-worktree" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, threadId);
    await startups.advance(startupId, "worktree");
    await startups.advance(startupId, "setup");

    await service.queueAutomaticFirstTurn(queuedInput(1, threadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await startups.interruptNonterminalOnStartup();
    await service.reconcileAutomaticSetup();

    expect(service.getAutomaticSetup({ threadId }).attempt?.state).toBe("interrupted");
    expect(startups.findByThreadId(threadId)?.state).toBe("interrupted");
  });

  it("settles an interrupted startup once the released gate shows the user already continued", async () => {
    let startups!: ThreadStartupService;
    const startupId = "00000000-0000-4000-8000-0000000000ee";
    const threadId = "00000000-0000-4000-8000-0000000000e1";
    const { service, start, completion } = await automaticHarness({
      threadIds: [threadId],
      threadStartups: (database, writer) => {
        startups = new ThreadStartupService(new ThreadStartupRepo(database, writer), writer, () => new Date());
        return startups;
      },
    });
    await startups.start({ startupId, workspaceId: "workspace-1", kind: "managed-worktree" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, threadId);
    await startups.advance(startupId, "worktree");
    await startups.advance(startupId, "setup");

    await service.queueAutomaticFirstTurn(queuedInput(1, threadId));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId }).attempt?.state).toBe("failed"));

    await service.continueAutomaticSetup({ threadId });
    expect(service.getAutomaticSetup({ threadId }).gate).toBe("released-by-continue");
    expect(startups.findByThreadId(threadId)?.state).toBe("running");

    await startups.interruptNonterminalOnStartup();
    expect(startups.findByThreadId(threadId)?.state).toBe("interrupted");
    await service.reconcileAutomaticSetup();

    expect(startups.findByThreadId(threadId)?.state).toBe("completed");
  });
});
