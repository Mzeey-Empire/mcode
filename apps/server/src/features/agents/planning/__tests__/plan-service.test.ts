import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventSchema, type AgentEvent, type PlanVersion, type ProviderRuntimeEvent } from "@mcode/contracts";
import { resolveThreadPlanFile } from "@mcode/shared";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalAcceptedProgress } from "../../canonical/canonical-accepted-progress.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand } from "../../execution/execution-worker-handler.js";
import { HandoffStorage } from "../../../handoff/persistence/handoff-storage.js";
import { PlanStore } from "../persistence/plan-store.js";
import { PlanFileWriter } from "../plan-file-writer.js";
import { PlanService, PlanServiceError } from "../plan-service.js";

const pushes = vi.hoisted(() => ({ versions: [] as unknown[] }));
vi.mock("../../../../application/transport/push.js", () => ({
  broadcast: (channel: string, data: unknown) => { if (channel === "plan.versionUpserted") pushes.versions.push(data); },
  subscribedThreadIds: () => new Set<string>(),
}));
const threadId = "plan-thread";
const now = "2026-10-09T00:00:00.000Z";
const execution = { threadId, turnId: "plan-turn", executionId: "00000000-0000-4000-8000-000000000123" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "plan-lease" };

describe("PlanService on the application SQLite writer", { timeout: 30_000 }, () => {
  let directory: string;
  let db: Database;
  let owner: ApplicationDatabaseWriter;
  let canonicalWriter: CanonicalAgentWriterClient;
  let progress: CanonicalAcceptedProgress;
  let handler: ExecutionWorkerHandler;
  let plans: PlanStore;
  let files: PlanFileWriter;
  let service: PlanService;
  let ready: PlanVersion;

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-plan-service-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("workspace", "Plans", directory);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, "workspace", "Plan", "main", "codex");
    db.prepare("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES (?, ?, ?, ?, ?)")
      .run("assistant", threadId, "assistant", "Summary", 1);
    plans = new PlanStore(db);
    ready = plans.create(threadId, "assistant", { title: "Original", contentMd: "# Original", captureSource: "fence" }, "codex");
    owner = new ApplicationDatabaseWriter(dbPath);
    await owner.whenReady();
    canonicalWriter = new CanonicalAgentWriterClient(owner);
    files = new PlanFileWriter((id) => plans.listByThread(id), () => directory);
    progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, owner, canonicalWriter, () => {}), canonicalWriter, files);
    handler = new ExecutionWorkerHandler(new CanonicalExecutionWriterPort(canonicalWriter, () => {}, undefined, undefined, progress));
    service = new PlanService(owner, progress, files);
    pushes.versions.length = 0;
  });

  afterEach(async () => {
    await progress.close();
    await canonicalWriter.close();
    await owner.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function fork(contentMd = "# Edited") {
    return { threadId, versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id, baseRevision: 0, contentMd };
  }

  function send(ordinal: number, command: ExecutionWorkCommand) {
    return handler.handle({ requestId: ordinal, execution, lease, ordinal, command });
  }

  async function start(providerId = "codex") {
    await send(1, { kind: "start", providerId, publishParentStart: true,
      parentLive: { planFeature: "output", precedingMessageId: "user-plan" },
      input: { thread: { id: threadId, workspaceId: "workspace", providerId, createdAt: now },
        turnId: execution.turnId, executionId: execution.executionId, permissionMode: "full", providerIdentities: [],
        userMessage: { kind: "create", messageId: "user-plan", content: "Revise", sequence: 2 } } });
  }

  function event(sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}, planCapture?: ProviderRuntimeEvent["planCapture"]) {
    const value = AgentEventSchema().parse({ type, threadId, turnExecutionId: execution.executionId,
      ...(type === "turnComplete" ? { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } : {}), ...fields });
    const itemId = `plan-event-${sequence}`;
    return { eventId: itemId, routing: { ...execution, itemId }, sourceProviderId: "codex", sourceIdentities: [],
      sourceSequence: sequence, payload: { type: "item.recorded" as const,
        item: { id: itemId, threadId, turnId: execution.turnId, kind: "system" as const, providerIdentities: [],
          payload: { projection: "providerRuntimeEvent", runtimeEvent: { event: value, ...(planCapture ? { planCapture } : {}) } }, createdAt: now, updatedAt: now } } };
  }

  async function captureAndFinish() {
    const content = "````mcode-plan\n# Revised by agent\nDo the new work.\n````";
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [event(1, "textDelta", { delta: content, isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [event(2, "message", { content, tokens: null })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [event(3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending, { timeout: 10_000 }).toBe(0);
  }

  it("rejects a save during an unfinished execution with no write", async () => {
    await start();
    await expect(service.saveVersion(fork())).rejects.toMatchObject({ code: "plan_busy", latestVersion: ready });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    expect(pushes.versions).toEqual([]);
  });

  it("keys a fork by client id and replays a lost response without allocating another version", async () => {
    const input = fork();
    const draft = await service.saveVersion(input);
    expect(draft).toMatchObject({ id: input.versionId, version: 2, revision: 1, author: "user", status: "draft",
      messageId: null, providerId: null, captureSource: "edit", baseVersionId: ready.id, contentMd: input.contentMd });
    expect(await service.saveVersion(input)).toEqual(draft);
    expect(plans.listByThread(threadId)).toEqual([ready, draft]);
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(input.contentMd);
  });

  it("increments equal revisions, rejects higher/lower revisions, and permits only the identical lost-response replay", async () => {
    const input = fork();
    const first = await service.saveVersion(input);
    const save = { ...input, baseRevision: 1, contentMd: "# Second\nExact text\n" };
    const second = await service.saveVersion(save);
    expect(second).toMatchObject({ id: first.id, revision: 2, contentMd: save.contentMd });
    expect(await service.saveVersion(save)).toEqual(second);
    for (const baseRevision of [0, 1, 3]) {
      await expect(service.saveVersion({ ...save, baseRevision, contentMd: "# Conflicting" }))
        .rejects.toMatchObject({ code: "plan_conflict", latestVersion: second });
      expect(plans.getById(first.id)).toEqual(second);
    }
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(save.contentMd);
  });

  it("serializes competing forks and lets Keep my text save into the winning draft", async () => {
    const first = fork("# Window one");
    const second = fork("# Window two");
    const results = await Promise.allSettled([service.saveVersion(first), service.saveVersion(second)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const draft = plans.listByThread(threadId)[1];
    expect(draft).toMatchObject({ id: first.versionId, version: 2, revision: 1 });
    const rejected = results[1];
    if (rejected.status !== "rejected") throw new Error("Second fork must conflict");
    expect(rejected.reason).toMatchObject({ code: "plan_conflict", latestVersion: draft });
    const kept = await service.saveVersion({ ...second, versionId: draft.id, baseRevision: draft.revision });
    expect(kept).toMatchObject({ id: draft.id, version: 2, revision: 2, contentMd: second.contentMd });
    await expect(service.saveVersion({ ...first, baseRevision: 1, contentMd: "# Window one again" }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: kept });
    expect(plans.listByThread(threadId)).toEqual([ready, kept]);
  });

  it("commits exactly one of two different saves with the same baseRevision", async () => {
    const input = fork();
    await service.saveVersion(input);
    const results = await Promise.allSettled([
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Winner" }),
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Conflict" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(plans.getById(input.versionId)).toMatchObject({ revision: 2, contentMd: "# Winner" });
  });

  it("saves Keep my text to another window's draft at its current revision", async () => {
    const firstWindow = await service.saveVersion(fork("# Window one"));
    const secondWindow = await service.saveVersion({ ...fork("# Window two"), versionId: firstWindow.id, baseRevision: 1 });
    expect(secondWindow).toMatchObject({ id: firstWindow.id, version: 2, revision: 2, contentMd: "# Window two" });
    expect(plans.listByThread(threadId)).toEqual([ready, secondWindow]);
  });

  it("keeps the ready base after a user fork and supersedes both on agent capture", async () => {
    const draft = await service.saveVersion(fork());
    expect((await service.snapshot({ threadId })).versions.map((version) => version.status)).toEqual(["ready", "draft"]);
    await start();
    await captureAndFinish();
    expect(plans.getById(ready.id)?.status).toBe("superseded");
    expect(plans.getById(draft.id)?.status).toBe("superseded");
  });

  it("projects exact text after every version upsert, including concurrent saves", async () => {
    const filename = resolveThreadPlanFile(directory, threadId);
    const input = fork("# First\n\nExact whitespace.\n");
    const draft = await service.saveVersion(input);
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# First\n\nExact whitespace.\n");
    const saved = await Promise.all([
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Second" }),
      service.saveVersion({ ...input, baseRevision: 2, contentMd: "# Third" }),
    ]);
    expect(saved.map((version) => version.revision)).toEqual([2, 3]);
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# Third");
    expect(pushes.versions).toEqual([draft, ...saved].map((version) => ({ threadId, version })));
    await start();
    await captureAndFinish();
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# Revised by agent\nDo the new work.");
  });

  it("bounds save input before any database write and accepts the exact content limit", async () => {
    const input = fork("x".repeat(65_537));
    await expect(service.saveVersion(input)).rejects.toThrow();
    expect(plans.listByThread(threadId)).toEqual([ready]);
    const draft = await service.saveVersion({ ...input, contentMd: "x".repeat(65_536) });
    expect(draft.contentMd).toBe("x".repeat(65_536));
    expect(draft.revision).toBe(1);
  });

  it("numbers an agent capture past user versions, supersedes both bases, and permits an immediate post-turn fork", async () => {
    const draft = await service.saveVersion(fork());
    expect(plans.getById(ready.id)?.status).toBe("ready");
    await start();
    await captureAndFinish();
    const snapshot = await service.snapshot({ threadId });
    expect(snapshot.versions.map(({ version, status, author }) => ({ version, status, author }))).toEqual([
      { version: 1, status: "superseded", author: "agent" },
      { version: 2, status: "superseded", author: "user" },
      { version: 3, status: "ready", author: "agent" },
    ]);
    const latest = snapshot.versions[2];
    expect(latest).toMatchObject({ providerId: "codex", captureSource: "fence", revision: 0 });
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(latest.contentMd);
    const next = await service.saveVersion({ ...fork("# After turn"), baseVersionId: latest.id });
    expect(next).toMatchObject({ version: 4, revision: 1, baseVersionId: latest.id });
    await expect(service.saveVersion({ ...fork(), versionId: draft.id, baseRevision: draft.revision }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: next });
  });

  it("never supersedes accepted versions and continues numbering after them", async () => {
    db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(ready.id);
    await expect(service.saveVersion(fork())).rejects.toMatchObject({ code: "plan_read_only" });
    await start();
    await captureAndFinish();
    expect((await service.snapshot({ threadId })).versions.map((plan) => [plan.version, plan.status]))
      .toEqual([[1, "accepted"], [2, "ready"]]);
  });

  it("retains native capture ownership only on the server", async () => {
    const nativePlanFile = { path: NodePath.join(directory, "native-plan.md"), sessionId: "native-session", sha256: "a".repeat(64) };
    await start("claude");
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [{ ...event(1, "message", { content: "Native summary", tokens: null },
        { markdown: "# Native plan", source: "native", nativePlanFile }), sourceProviderId: "claude" }] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [{ ...event(2, "turnComplete"), sourceProviderId: "claude" }],
      terminalInput: { ...execution, providerId: "claude", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending, { timeout: 10_000 }).toBe(0);
    const snapshot = await service.snapshot({ threadId });
    const captured = snapshot.versions[1];
    expect(captured).toMatchObject({ author: "agent", providerId: "claude", captureSource: "native", contentMd: "# Native plan" });
    expect(db.prepare("SELECT native_plan_file_json FROM plans WHERE id = ?").get(captured.id))
      .toEqual({ native_plan_file_json: JSON.stringify(nativePlanFile) });
    expect(JSON.stringify(snapshot)).not.toContain("nativePlanFile");
    expect(JSON.stringify(pushes.versions)).not.toContain(nativePlanFile.path);
    expect(NodeFS.existsSync(nativePlanFile.path)).toBe(false);
  });

  it("keeps later memory status after reload with a head present and never returns stale user content", async () => {
    const draft = await service.saveVersion(fork());
    await start();
    await captureAndFinish();
    db.prepare("UPDATE plans SET status = 'ready' WHERE id = ?").run(ready.id);
    db.prepare("UPDATE plans SET content_md = ?, revision = ? WHERE id = ?").run("# Saved user text", 7, draft.id);
    expect(progress.reloadPlans(threadId).find((plan) => plan.id === ready.id)?.status).toBe("superseded");
    const snapshot = await service.snapshot({ threadId });
    expect(snapshot.versions.find((plan) => plan.id === ready.id)?.status).toBe("superseded");
    expect(snapshot.versions.find((plan) => plan.id === draft.id)).toMatchObject({ contentMd: "# Saved user text", revision: 7 });
    db.prepare("UPDATE plans SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, ready.id);
    expect(progress.reloadPlans(threadId).find((plan) => plan.id === ready.id)?.status).toBe("accepted");
    db.prepare("UPDATE plans SET status = 'ready', accepted_at = NULL WHERE id = ?").run(ready.id);
    expect((await service.snapshot({ threadId })).versions.find((plan) => plan.id === ready.id))
      .toMatchObject({ status: "accepted", acceptedAt: now });
  });

  it("loads legacy canonical payloads as ready without rewriting retained history", async () => {
    await start();
    const legacy = { id: ready.id, threadId, messageId: ready.messageId, version: 1, title: ready.title,
      contentMd: ready.contentMd, sectionsJson: [], changeSummary: null, status: "draft", createdAt: ready.createdAt,
      providerId: "unknown-legacy-provider" };
    const payload = JSON.stringify({ projection: "plan", plan: legacy });
    db.prepare("INSERT INTO canonical_agent_items (id, thread_id, turn_id, kind, payload_json, provider_identities_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-plan", threadId, execution.turnId, "system", payload, "[]", now, now);
    expect((await service.snapshot({ threadId })).versions).toEqual([ready]);
    expect(db.prepare("SELECT payload_json FROM canonical_agent_items WHERE id = ?").get("legacy-plan")).toEqual({ payload_json: payload });
  });

  it("rejects missing threads and foreign version identities without exposing their rows", async () => {
    await expect(service.snapshot({ threadId: "missing" })).rejects.toMatchObject({ code: "thread_not_found", latestVersion: null });
    await expect(service.saveVersion({ ...fork(), threadId: "missing" })).rejects.toBeInstanceOf(PlanServiceError);
    await expect(service.saveVersion({ ...fork(), versionId: ready.id })).rejects.toMatchObject({ code: "plan_conflict", latestVersion: ready });
    expect(plans.listByThread(threadId)).toEqual([ready]);
  });

  it("removes the plan file with the existing handoff thread cleanup", async () => {
    await service.saveVersion(fork());
    const storage = HandoffStorage.forTesting({ mcodeDirFn: () => directory });
    await storage.deleteThreadFiles(threadId);
    expect(NodeFS.existsSync(NodePath.dirname(resolveThreadPlanFile(directory, threadId)))).toBe(false);
    expect(() => resolveThreadPlanFile(directory, "../escape")).toThrow();
  });
});
