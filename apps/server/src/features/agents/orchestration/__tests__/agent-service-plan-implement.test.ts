import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { Database } from "bun:sqlite";
import { container } from "tsyringe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry, PlanImplement, PlanVersion, TurnRequest } from "@mcode/contracts";
import { setupContainer } from "../../../../application/composition/container.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SnapshotRefPins } from "../../../projects/diffs/snapshots/snapshot-ref-pins.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/authority/thread-control-mutation-reservation-service.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanImplementStore } from "../../planning/persistence/plan-implement-store.js";
import { planImplementWriteOperations } from "../../planning/persistence/plan-implement-write-operations.js";
import { PlanFileWriter } from "../../planning/plan-file-writer.js";
import { PlanService, type PlanImplementRuntime } from "../../planning/plan-service.js";
import { ScopedPreGrantService } from "../../permissions/scoped-pre-grant.js";
import { AgentService } from "../agent-service.js";
import { AGENT_TURN_COMMAND_PORT } from "../agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";

const pushes = vi.hoisted(() => ({ versions: [] as Array<{ threadId: string; version: PlanVersion }> }));
vi.mock("../../../../application/transport/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../application/transport/push.js")>();
  return { ...actual, broadcast: (...args: Parameters<typeof actual.broadcast>) => {
    if (args[0] === "plan.versionUpserted") pushes.versions.push(args[1] as { threadId: string; version: PlanVersion });
    actual.broadcast(...args);
  } };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Plan Implement through production worker-owned admission", { timeout: 30_000 }, () => {
  let directory: string;
  let database: Database;
  let writer: ApplicationDatabaseWriter;
  let workers: WorkerOwnedTurnRuntime;
  let agent: AgentService;
  let plans: PlanRepo;
  let service: PlanService;
  let files: PlanFileWriter;
  let runtime: PlanImplementRuntime;
  let provider: IAgentProvider;
  let workspaceId: string;
  let threadId: string;
  let ready: PlanVersion;
  let sent: TurnRequest[];
  let atDispatch: Array<{ text: string; status: string | undefined }>;
  const oldDbPath = process.env.MCODE_DB_PATH;

  beforeAll(async () => {
    container.reset();
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-implement-"));
    process.env.MCODE_DB_PATH = NodePath.join(directory, "app.sqlite");
    await openServiceSet();
    database = new Database(process.env.MCODE_DB_PATH);
    workspaceId = (await container.resolve(WorkspaceRepo).create("Implement fixture", directory, false)).id;
  });

  async function openServiceSet() {
    await setupContainer(directory);
    writer = container.resolve(ApplicationDatabaseWriter);
    workers = container.resolve(WorkerOwnedTurnRuntime);
    await workers.whenReady();
    provider = Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
      supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
      forker: { fork: async () => { throw new Error("No session fork in this fixture"); } },
      sendTurn: async (request: TurnRequest) => {
        sent.push(request);
        atDispatch.push({ text: NodeFS.readFileSync(files.path(threadId), "utf8"), status: plans.getById(ready.id)?.status });
      },
      stopSession: async () => undefined, shutdown: () => undefined, listModels: async () => [],
      setCanonicalTurnEventDeliveryEnabled: () => undefined, setCanonicalTurnDeliveryFailureHandler: () => undefined,
      fenceCanonicalTurnEvents: async () => undefined, retireCanonicalTurnEvents: async () => undefined,
    });
    const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => undefined };
    container.registerInstance("IProviderRegistry", providers);
    vi.spyOn(container.resolve(ProviderAvailabilityService), "assertUsable").mockReturnValue(undefined);
    agent = container.resolve(AgentService);
    const publications = container.resolve(AgentEventPublicationRegistry);
    publications.bind(() => undefined);
    publications.start();
    plans = container.resolve(PlanRepo);
    files = new PlanFileWriter(id => plans.listByThread(id), () => directory);
    runtime = { threads: container.resolve(ThreadRepo), providers,
      reservations: container.resolve(ThreadControlMutationReservationService),
      commands: container.resolve(AGENT_TURN_COMMAND_PORT), grants: container.resolve(ScopedPreGrantService) };
  }

  beforeEach(async () => {
    sent = [];
    atDispatch = [];
    provider.prepareImplement = undefined;
    threadId = (await container.resolve(ThreadRepo).create(workspaceId, "Plan", "direct", "main", false, "codex")).id;
    await container.resolve(ThreadRepo).updateSettings(threadId, { interaction_mode: "plan", model: "gpt-5.6-luna" });
    const message = await container.resolve(MessageRepo).create(threadId, "assistant", "Plan summary", 1);
    ready = await plans.create(threadId, message.id, { title: "Original", contentMd: "# Original\nExact plan text.", captureSource: "fence" }, "codex");
    await files.write(threadId);
    service = new PlanService(writer, workers.progress, files, runtime);
  });

  afterEach(async () => {
    database.run("DROP TRIGGER IF EXISTS fail_implement");
    database.run("DROP TRIGGER IF EXISTS fail_admission");
    await agent.stopSession(threadId, { by: "user" });
  });

  afterAll(async () => {
    await container.resolve(SnapshotRefPins).drain();
    await workers.close();
    await writer.close();
    database.close(true);
    container.resolve<Database>("Database").close(true);
    container.reset();
    if (oldDbPath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = oldDbPath;
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function request(version = ready): PlanImplement {
    return { requestId: NodeCrypto.randomUUID(), threadId, versionId: version.id, expectedRevision: version.revision, target: "thread" };
  }

  function userMessages() {
    return database.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user'").all(threadId);
  }

  function turns() {
    return database.prepare("SELECT status FROM canonical_agent_turns WHERE thread_id = ?").all(threadId);
  }

  function assertUnaccepted() {
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(userMessages()).toEqual([]);
    expect(turns()).toEqual([]);
  }

  async function draft() {
    return service.saveVersion({ threadId, versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id,
      baseRevision: 0, contentMd: "# Edited\nDraft text." });
  }

  function pauseFiles() {
    const entered = deferred();
    const release = deferred();
    provider.prepareImplement = async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "skipped", reason: "unproven" };
    };
    return { entered: entered.promise, release: release.resolve };
  }

  it("joins double presses, replays the receipt and dispatches the exact text after worker acceptance", async () => {
    const input = request();
    const [first, second] = await Promise.all([service.implement(input), service.implement(input)]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "admitted", nativePlanFile: { outcome: "skipped", reason: "no-file" } });
    expect(await new PlanService(writer, workers.progress, files, runtime).implement(input)).toEqual(first);
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toEqual([{ id: first.messageId, content: "Implement plan v1" }]);
    await expect.poll(() => sent.map(turn => turn.message)).toEqual([
      `Implement plan v1: "Original".\n\nThis is the plan the user approved. It supersedes any earlier plan or plan file, including your own. Mcode keeps this text at ${files.path(threadId)}.\n\n# Original\nExact plan text.`,
    ]);
    expect(atDispatch).toEqual([{ text: "# Original\nExact plan text.", status: "accepted" }]);
    expect(runtime.threads.findById(threadId)?.interaction_mode).toBe("build");
    expect((await service.snapshot({ threadId })).versions).toMatchObject([{ id: ready.id, status: "accepted", acceptedMessageId: first.messageId }]);
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "admitted",
      turnId: sent[0]?.turnId, executionId: sent[0]?.turnExecutionId });
  });

  it("refuses an older displayed revision with no row, then implements the newer text on a second press", async () => {
    ready = await plans.create(threadId, ready.messageId!, { title: "Original", contentMd: "# Original", captureSource: "fence" }, "codex");
    let version = await draft();
    for (const contentMd of ["# Rev 2", "# Rev 3", "# Window A"]) {
      version = await service.saveVersion({ threadId, versionId: version.id, baseVersionId: ready.id, baseRevision: version.revision, contentMd });
    }
    const stale = request(version);
    expect(version).toMatchObject({ version: 3, revision: 4 });
    const newer = await service.saveVersion({ threadId, versionId: version.id, baseVersionId: ready.id, baseRevision: 4, contentMd: "# Window B\nRevision five." });
    await expect(service.implement(stale)).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { revision: 5, contentMd: "# Window B\nRevision five." } });
    expect(new PlanImplementStore(database).read(stale.requestId)).toBeNull();
    assertUnaccepted();
    await service.implement(request(newer));
    await expect.poll(() => sent.map(turn => turn.message.endsWith("\n\n# Window B\nRevision five."))).toEqual([true]);
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Window B\nRevision five.");
  });

  it("rolls back a pending fork when expectedRevision differs from the saved revision", async () => {
    const versionId = NodeCrypto.randomUUID();
    const input = { ...request(), versionId, expectedRevision: 2,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Unsaved" } };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { id: ready.id } });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    expect(new PlanImplementStore(database).read(input.requestId)).toBeNull();
    assertUnaccepted();
  });

  it("saves pending text once and accepts that exact revision", async () => {
    const versionId = NodeCrypto.randomUUID();
    const receipt = await service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Unsaved\nLast keystroke." } });
    expect((await service.snapshot({ threadId })).versions.map(v => [v.status, v.revision, v.acceptedMessageId]))
      .toEqual([["superseded", 0, null], ["accepted", 1, receipt.messageId]]);
    await expect.poll(() => sent.map(turn => turn.message.endsWith("\n\n# Unsaved\nLast keystroke."))).toEqual([true]);
  });

  it("passes the newest agent file proof with draft text and durably returns the adapter outcome", async () => {
    const nativePlanFile = { path: NodePath.join(directory, "provider-plan.md"), sessionId: "provider-session", sha256: "a".repeat(64) };
    ready = await plans.create(threadId, ready.messageId!, { title: "Native", contentMd: "# Native", captureSource: "native", nativePlanFile }, "codex");
    const edited = await draft();
    provider.prepareImplement = async input => {
      expect(input).toEqual({ threadId, markdown: "# Edited\nDraft text.", nativePlanFile });
      expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
      return { outcome: "skipped", reason: "changed" };
    };
    const input = request(edited);
    const receipt = await service.implement(input);
    expect(receipt.nativePlanFile).toEqual({ outcome: "skipped", reason: "changed" });
    expect(await service.implement(input)).toEqual(receipt);
    expect(JSON.stringify(await service.snapshot({ threadId }))).not.toContain("provider-plan.md");
  });

  it("rejects a reused request id with another expectedRevision both in flight and after admission", async () => {
    const input = request();
    const paused = pauseFiles();
    const first = service.implement(input);
    await paused.entered;
    await expect(service.implement({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "implement_request_conflict" });
    paused.release();
    await first;
    await expect(service.implement({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "implement_request_conflict" });
    expect(turns()).toEqual([{ status: "Running" }]);
  });

  it("keeps ordinary Send and autosave out while Implement owns the reservation", async () => {
    const paused = pauseFiles();
    const implementing = service.implement(request());
    await paused.entered;
    await expect(agent.sendMessage({ threadId, content: "Ordinary send", provider: "codex" })).rejects.toThrow(/pending mutation/);
    await expect(draft()).rejects.toMatchObject({ code: "plan_busy" });
    paused.release();
    await implementing;
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toHaveLength(1);
  });

  it("refuses Implement when ordinary Send wins admission", async () => {
    await agent.sendMessage({ threadId, content: "Ordinary send", provider: "codex", interactionMode: "build" });
    await expect(service.implement(request())).rejects.toMatchObject({ code: "thread_busy" });
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toMatchObject([{ content: "Ordinary send" }]);
    expect(plans.getById(ready.id)?.status).toBe("ready");
  });

  it("accepts a ready base, supersedes its draft and retains only the accepted message link", async () => {
    await draft();
    const receipt = await service.implement(request());
    expect((await service.snapshot({ threadId })).versions.map(v => [v.status, v.acceptedMessageId]))
      .toEqual([["accepted", receipt.messageId], ["superseded", null]]);
    await expect.poll(() => atDispatch).toEqual([{ text: "# Original\nExact plan text.", status: "accepted" }]);
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Original\nExact plan text.");
  });

  it("restores the draft projection when preparing its ready base fails after file preparation", async () => {
    await draft();
    provider.prepareImplement = async () => { throw new Error("Injected native file failure"); };
    const input = request();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
    expect(new PlanImplementStore(database).read(input.requestId)?.status).toBe("failed");
    expect(runtime.reservations.get(threadId)).toBeUndefined();
  });

  it("publishes the pending edit it saved when Implement fails after preparation", async () => {
    provider.prepareImplement = async () => { throw new Error("Injected native file failure"); };
    const versionId = NodeCrypto.randomUUID();
    pushes.versions = [];
    await expect(service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Pending" } }))
      .rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(pushes.versions).toContainEqual({ threadId,
      version: expect.objectContaining({ id: versionId, revision: 1, contentMd: "# Pending", status: "draft" }) });
  });

  it("implements at the thread's reasoning level", async () => {
    await runtime.threads.updateSettings(threadId, { reasoning_level: "xhigh" });
    await service.implement(request());
    await expect.poll(() => sent.map(turn => turn.reasoningLevel)).toEqual(["xhigh"]);
  });

  it("rolls back pending edits when a fault occurs before the request row", async () => {
    database.run("CREATE TRIGGER fail_implement BEFORE INSERT ON plan_implement_requests BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END");
    const versionId = NodeCrypto.randomUUID();
    await expect(service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Pending" } }))
      .rejects.toMatchObject({ code: "implement_failed" });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    assertUnaccepted();
  });

  it("leaves no message when snapshot file preparation fails after the row", async () => {
    const path = files.path(threadId);
    NodeFS.rmSync(path);
    NodeFS.mkdirSync(path);
    const input = request();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(new PlanImplementStore(database).read(input.requestId)?.status).toBe("failed");
    NodeFS.rmdirSync(path);
  });

  it("rolls back Accepted and the user message when admission fails after plan acceptance", async () => {
    database.run("CREATE TRIGGER fail_admission BEFORE INSERT ON canonical_agent_turns BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END");
    await expect(service.implement(request())).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(runtime.threads.findById(threadId)?.interaction_mode).toBe("plan");
  });

  it("rechecks the recorded revision inside worker admission", async () => {
    const version = await draft();
    provider.prepareImplement = async () => {
      database.prepare("UPDATE plans SET revision = revision + 1, content_md = ? WHERE id = ?").run("# Changed before start", version.id);
      return { outcome: "skipped", reason: "changed" };
    };
    await expect(service.implement(request(version))).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { revision: 2 } });
    expect(plans.getById(version.id)?.status).toBe("draft");
    expect(userMessages()).toEqual([]);
    expect(turns()).toEqual([]);
  });

  it("keeps Accepted after provider dispatch fails and never lets late compensation overwrite admission", async () => {
    const send = vi.spyOn(provider, "sendTurn").mockRejectedValueOnce(new Error("Injected provider dispatch failure"));
    const input = request();
    const receipt = await service.implement(input);
    expect(receipt.state).toBe("admitted");
    await expect.poll(() => turns()).toEqual([{ status: "Errored" }]);
    expect(plans.getById(ready.id)?.status).toBe("accepted");
    expect(userMessages()).toEqual([{ id: receipt.messageId, content: "Implement plan v1" }]);
    await writer.execute(planImplementWriteOperations.fail, { requestId: input.requestId, code: "interrupted" });
    expect(await service.implement(input)).toEqual(receipt);
    send.mockRestore();
  });

  it("answers on admission while the provider is still starting the turn", async () => {
    const providerStarting = deferred();
    const send = vi.spyOn(provider, "sendTurn").mockImplementationOnce(() => providerStarting.promise);
    const receipt = await service.implement(request());
    expect(receipt.state).toBe("admitted");
    await expect.poll(() => send.mock.calls.length).toBe(1);
    providerStarting.resolve();
    send.mockRestore();
  });

  it("recovers an abandoned prepared request with a new service set on the same database", async () => {
    await draft();
    const paused = pauseFiles();
    const input = request();
    void service.implement(input);
    await paused.entered;
    await container.resolve(SnapshotRefPins).drain();
    await workers.close();
    await writer.close();
    container.resolve<Database>("Database").close(true);
    container.reset();
    await openServiceSet();
    service = new PlanService(writer, workers.progress, files, runtime);
    await service.recoverInterrupted();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_interrupted" });
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
    assertUnaccepted();
    await service.implement(request());
    expect(turns()).toEqual([{ status: "Running" }]);
  });

  it("refuses superseded and accepted versions without a new request row", async () => {
    const next = await plans.create(threadId, ready.messageId!, { title: "New", contentMd: "# New", captureSource: "fence" }, "codex");
    await expect(service.implement(request())).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { id: next.id } });
    expect(userMessages()).toEqual([]);
    await service.implement(request(next));
    await agent.stopSession(threadId, { by: "user" });
    await expect(service.implement(request(next))).rejects.toMatchObject({ code: "plan_read_only" });
  });
});
