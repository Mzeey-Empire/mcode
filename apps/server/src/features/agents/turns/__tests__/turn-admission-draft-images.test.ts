import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry, ProviderId, StagedDraftImage } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { resolveThreadPlanFile } from "@mcode/shared";
import { PlanFileWriter } from "../../planning/plan-file-writer.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { FileService } from "../../../projects/files/file-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { TurnAdmissionDispatchCoordinator, type SendMessageCommand, type TurnParentStartOwner, type TurnRuntimeAdmissionAuthority } from "../turn-admission-dispatch-coordinator.js";

const day = 24 * 60 * 60 * 1000;
let directory: string;
let settings: SettingsService;

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-draft-admission-"));
  vi.stubEnv("MCODE_DATA_DIR", directory);
  settings = new SettingsService();
  settings.update({ provider: { enabled: { cursor: true } } });
});
afterEach(async () => {
  settings.dispose();
  await closeAgentStorageTestDatabases();
  vi.unstubAllEnvs();
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

async function fixture(providerId: ProviderId = "codex", beforeCommit: () => Promise<void> = async () => {}) {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspaces = new WorkspaceRepo(db, writer);
  const messages = new MessageRepo(db, writer);
  const attachments = new AttachmentService();
  const workspace = await workspaces.create("Draft fixture", directory, false);
  const thread = await threads.create(workspace.id, "Draft images", "direct", "main", false, providerId);
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: providerId, descriptor: { id: providerId, capabilities: [] }, supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Not used by admission"); } },
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const git = new FakeGitExecutor();
  const worktrees = new GitWorktreeService(workspaces, git, hostRuntime);
  const canonical = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => {});
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer), new AgentTurnCommandPort(commands));
  const owner: TurnParentStartOwner = { start: async ({ parentTurn }) => { await beforeCommit(); await canonical.startParentTurn(parentTurn); } };
  const admission = new TurnAdmissionDispatchCoordinator(
    threads, workspaces, messages, worktrees, attachments, providers,
    new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, writer, commands, canonical), undefined,
    new FileService(workspaces, threads, worktrees, git, hostRuntime), hostRuntime.platform, owner,
  );
  const runtime: TurnRuntimeAdmissionAuthority = {
    reserve: () => ({ threadId: thread.id, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
    activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
  };
  const send = (ids: string[], extra: Partial<SendMessageCommand> = {}) => admission.admit({ threadId: thread.id, content: "Inspect the image", messageId: NodeCrypto.randomUUID(), stagedDraftImageIds: ids, ...extra }, runtime);
  const stage = async (name = "capture.png") => {
    const sourcePath = NodePath.join(directory, name);
    NodeFS.writeFileSync(sourcePath, Buffer.from([137, 80, 78, 71]));
    const image = await attachments.stageDraft(thread.id, { id: NodeCrypto.randomUUID(), name, sourcePath, mimeType: "image/png", sizeBytes: 4 });
    NodeFS.unlinkSync(sourcePath);
    return image;
  };
  const stagedPath = (image: StagedDraftImage) => NodePath.join(directory, "attachments", thread.id, "draft", `${image.stagingId}.png`);
  const copies = () => NodeFS.readdirSync(NodePath.join(directory, "attachments", thread.id)).filter((name) => name !== "draft");
  const planRepo = new PlanRepo(db, writer);
  plans.bindPlanProjection(undefined, new PlanFileWriter((id) => planRepo.listByThread(id), () => directory));
  return { admission, runtime, thread, attachments, messages, send, stage, stagedPath, copies, planRepo };
}

describe("plan file admission", () => {
  const commands: Partial<SendMessageCommand>[] = [
    { interactionMode: "plan" }, { planAction: "revise" }, { planAction: "implement" },
    { markPlanAnswerForMessageId: "question-message" },
  ];

  it.each(commands)("refreshes a stale plan file before admitting %j", async (command) => {
    let filename = "";
    const f = await fixture("codex", async () => {
      expect(NodeFS.readFileSync(filename, "utf8")).toBe("# Current plan");
    });
    const assistant = await f.messages.create(f.thread.id, "assistant", "Summary", 1);
    await f.planRepo.create(f.thread.id, assistant.id, { title: "Current", contentMd: "# Current plan", captureSource: "fence" }, "codex");
    filename = resolveThreadPlanFile(directory, f.thread.id);
    NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
    NodeFS.writeFileSync(filename, "# Stale plan");
    const admitted = await f.send([], command.markPlanAnswerForMessageId ? { markPlanAnswerForMessageId: assistant.id } : command);
    expect(admitted.kind).toBe("dispatch");
  });

  it.each(commands)("refuses admission if the plan refresh fails for %j", async (command) => {
    const f = await fixture();
    const assistant = await f.messages.create(f.thread.id, "assistant", "Summary", 1);
    await f.planRepo.create(f.thread.id, assistant.id, { title: "Current", contentMd: "# Current plan", captureSource: "fence" }, "codex");
    NodeFS.mkdirSync(resolveThreadPlanFile(directory, f.thread.id), { recursive: true });
    await expect(f.send([], command)).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) });
    expect(f.messages.listByThread(f.thread.id, 10).messages.map((message) => message.id)).toEqual([assistant.id]);
  });
});

describe("draft image admission", () => {
  it("copies the staged image into the admitted message and keeps it after a cross-window discard", async () => {
    const gate = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<void>();
    const f = await fixture("codex", async () => { copied.resolve(); await gate.promise; });
    const image = await f.stage();
    const staleWindow = { stagingIds: [image.stagingId] };
    const messageId = NodeCrypto.randomUUID();
    const pending = f.send([image.stagingId], { messageId });
    await copied.promise;
    staleWindow.stagingIds = [];
    expect(f.attachments.removeExpiredDraftImages(() => Date.now() + 31 * day)).toBe(0);
    expect(f.copies()).toHaveLength(1);
    gate.resolve();
    const result = await pending;
    if (result.kind !== "dispatch") throw new Error("Expected admission");
    const stored = f.messages.findByIdInThread(f.thread.id, messageId)?.attachments;
    expect(stored).toEqual([{ id: result.request.attachments?.[0]?.id, name: "capture.png", mimeType: "image/png", sizeBytes: 4 }]);
    const copyPath = result.request.attachments?.[0]?.sourcePath;
    if (!copyPath) throw new Error("Expected message image path");
    expect(NodeFS.readFileSync(copyPath)).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(NodeFS.readFileSync(f.stagedPath(image))).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(staleWindow.stagingIds).toEqual([]);
  });

  it("fails structurally for a missing image and removes copies made before that failure", async () => {
    const f = await fixture();
    const image = await f.stage();
    const missing = await f.stage("missing.png");
    NodeFS.unlinkSync(f.stagedPath(missing));
    const messageId = NodeCrypto.randomUUID();
    await expect(f.send([image.stagingId, missing.stagingId], { messageId })).rejects.toMatchObject({ code: "draft_image_missing", stagingId: missing.stagingId });
    expect(f.copies()).toEqual([]);
    expect(f.messages.findByIdInThread(f.thread.id, messageId)).toBeNull();
    expect(NodeFS.existsSync(f.stagedPath(image))).toBe(true);
  });

  it("rolls back copies on failed admission; stale discard preserves submitted and unsubmitted images for retry and retention", async () => {
    let fail = true;
    const copied = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const f = await fixture("codex", async () => {
      if (!fail) return;
      copied.resolve();
      await gate.promise;
      throw new Error("Forced database commit failure");
    });
    const submitted = await f.stage();
    const cleanCapture = await f.stage("clean.png");
    const staleWindow = { stagingIds: [submitted.stagingId, cleanCapture.stagingId] };
    const pending = f.send([submitted.stagingId]);
    const rejection = expect(pending).rejects.toThrow("Forced database commit failure");
    await copied.promise;
    expect(f.copies()).toHaveLength(1);
    staleWindow.stagingIds = [];
    gate.resolve();
    await rejection;
    expect(f.copies()).toEqual([]);
    for (const image of [submitted, cleanCapture]) expect(NodeFS.readFileSync(f.stagedPath(image))).toEqual(Buffer.from([137, 80, 78, 71]));
    fail = false;
    const result = await f.send([submitted.stagingId]);
    expect(result.kind).toBe("dispatch");
    expect(f.copies()).toHaveLength(1);
    expect(f.attachments.removeExpiredDraftImages(() => Date.now() + 29 * day)).toBe(0);
    for (const image of [submitted, cleanCapture]) expect(NodeFS.existsSync(f.stagedPath(image))).toBe(true);
    expect(f.attachments.removeExpiredDraftImages(() => Date.now() + 31 * day)).toBe(2);
    for (const image of [submitted, cleanCapture]) expect(NodeFS.existsSync(f.stagedPath(image))).toBe(false);
    expect(staleWindow.stagingIds).toEqual([]);
  });

  it.each(["codex", "claude", "cursor"] as const)("resolves diff-comment file mentions for %s", async (providerId) => {
    const f = await fixture(providerId);
    NodeFS.writeFileSync(NodePath.join(directory, "example.txt"), "literal file contents");
    const mention = { kind: "file" as const, id: "file-1", path: "example.txt", label: "example.txt", range: { start: 0, end: 12 } };
    const previewAnnotations = { schemaVersion: 1 as const, annotations: [{ kind: "diff" as const, id: NodeCrypto.randomUUID(), displayNumber: 1, filePath: "example.txt", side: "right" as const, line: 1, lineContent: "before", note: "@example.txt explain", mentions: [mention] }] };
    const result = await f.send([], { previewAnnotations });
    if (result.kind !== "dispatch") throw new Error("Expected admission");
    expect(result.request.mentions).toEqual([mention]);
    if (providerId === "codex") expect(result.request.message).not.toContain("literal file contents");
    else expect(result.request.message).toContain("literal file contents");
    const invalid = { ...previewAnnotations, annotations: previewAnnotations.annotations.map((annotation) => ({ ...annotation, mentions: [{ ...mention, path: "../escape.txt" }] })) };
    await expect(f.send([], { previewAnnotations: invalid })).rejects.toThrow();
  });
});
