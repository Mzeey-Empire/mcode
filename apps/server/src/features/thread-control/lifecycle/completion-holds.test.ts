import "reflect-metadata";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { broadcast } from "../../../application/transport/push.js";
import { createThreadPersistenceTestRuntime } from "../testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { CompletionHolds } from "./completion-holds.js";
import { ThreadCompletionService } from "./thread-completion-service.js";
import { TurnAdmissionDispatchCoordinator, type TurnRuntimeAdmissionAuthority } from "../../agents/turns/turn-admission-dispatch-coordinator.js";
import { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../agents/canonical/canonical-agent-writer-client.js";
import { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../projects/git/execution/fake-git-executor.js";
import { PlanTurnService } from "../../agents/planning/plan-turn-service.js";
import { PlanQuestionService } from "../../agents/planning/plan-question-service.js";
import { PlanRepo } from "../../agents/planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../agents/planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../agents/goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../agents/orchestration/agent-turn-command-port.js";
import { TurnRevertStore } from "../../agents/turns/persistence/turn-revert-store.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const COMPLETED_AT = "2026-10-27T10:00:00.000Z";

describe("server-held thread completion", () => {
  let storage: ReturnType<typeof createThreadPersistenceTestRuntime>;
  let threads: ThreadRepo;
  let workspaces: WorkspaceRepo;
  let settings: SettingsService;
  let reservations: ThreadControlMutationReservationService;
  let holds: CompletionHolds;
  let service: ThreadCompletionService;
  let threadId: string;
  let directory: string;
  let teardown: ReturnType<typeof vi.fn<(threadId: string) => Promise<void>>>;
  let activeThreadIds: ReturnType<typeof vi.fn<() => string[]>>;

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-completion-holds-"));
    vi.stubEnv("MCODE_DATA_DIR", directory);
    settings = new SettingsService();
    storage = createThreadPersistenceTestRuntime();
    threads = new ThreadRepo(storage.reader, storage.writer);
    workspaces = new WorkspaceRepo(storage.reader, storage.writer);
    const workspace = await workspaces.create("Completion fixture", directory, false);
    threadId = (await threads.create(workspace.id, "Held thread", "direct", "main", false, "codex")).id;
    reservations = new ThreadControlMutationReservationService();
    holds = new CompletionHolds();
    teardown = vi.fn(async () => {});
    activeThreadIds = vi.fn(() => []);
    service = new ThreadCompletionService(
      threads, { runtimeAccess: () => ({ activeThreadIds }) }, { listPendingApprovals: () => [] },
      { teardownThread: teardown }, reservations, settings, () => new Date(COMPLETED_AT),
      new CleanupJobRepo(storage.reader, storage.writer), holds,
    );
    vi.mocked(broadcast).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    settings.dispose();
    vi.unstubAllEnvs();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function lifecyclePushes() {
    return vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "thread.lifecycleChanged");
  }

  function admissionFixture() {
    const messages = new MessageRepo(storage.reader, storage.writer);
    const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex", descriptor: { id: "codex", capabilities: [] }, supportsCompletion: false,
      subagentReporting: null,
      maxInputCharactersPerTurn: 100_000,
      sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
    } satisfies Omit<IAgentProvider, keyof NodeEvents.EventEmitter>);
    const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
    const client = new CanonicalAgentWriterClient(storage.writer);
    const canonical = new CanonicalAgentBoundary(storage.reader, storage.writer, client, () => {});
    const commands = new AgentRuntimeCommandPort();
    const plans = new PlanTurnService(threads, providers,
      new PlanQuestionService(messages, new PlanQuestionAnswersRepo(storage.reader, storage.writer)),
      new PlanRepo(storage.reader, storage.writer), new AgentTurnCommandPort(commands));
    const coordinator = new TurnAdmissionDispatchCoordinator(
      threads, workspaces, messages, new TurnRevertStore(storage.reader),
      new GitWorktreeService(workspaces, new FakeGitExecutor(), hostRuntime), new AttachmentService(), providers,
      new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
      new GoalLifecycleService(threads, providers, storage.writer, commands, canonical),
      undefined, undefined, hostRuntime.platform, { listModels: async () => [] },
      undefined, undefined, undefined, holds,
    );
    const runtime: TurnRuntimeAdmissionAuthority = {
      reserve: () => {
        const token = reservations.reserve(threadId, "activeTurn");
        if (!token) throw new Error("Turn admission is reserved");
        return { threadId, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: token, generation: 1 };
      },
      activate: () => {}, abort: async () => {}, release: (lease) => { reservations.release(threadId, lease.mutationReservationToken); },
      owns: () => true,
    };
    return { coordinator, runtime, provider, messages };
  }

  it("persists and releases nothing until the hold ends", async () => {
    const pending = service.complete(threadId, 3000);
    let settled = false;
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(2999);

    expect(settled).toBe(false);
    expect(threads.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardown).not.toHaveBeenCalled();
    expect(lifecyclePushes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true, thread: { user_completed_at: COMPLETED_AT } });
    expect(threads.findById(threadId)?.user_completed_at).toBe(COMPLETED_AT);
  });

  it("cancels at 2.9 seconds when reopened without persisting anything", async () => {
    const active = threads.findById(threadId);
    const pending = service.complete(threadId, 3000);
    await vi.advanceTimersByTimeAsync(2900);

    await expect(service.reopen(threadId)).resolves.toEqual(active);
    await expect(pending).resolves.toEqual({ ok: false, refusal: "cancelled" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(threads.findById(threadId)).toEqual(active);
    expect(teardown).not.toHaveBeenCalled();
    expect(lifecyclePushes()).toEqual([]);
  });

  it("cancels on turn admission and lets the admitted turn run", async () => {
    const { coordinator, runtime, provider, messages } = admissionFixture();
    const pending = service.complete(threadId, 3000);
    await vi.advanceTimersByTimeAsync(2900);

    const admitted = await coordinator.admit({ threadId, content: "Keep working", messageId: NodeCrypto.randomUUID() }, runtime);
    if (admitted.kind !== "dispatch") throw new Error("Expected an admitted turn");
    const prompts: string[] = [];
    provider.sendTurn = async (request) => { prompts.push(request.message); };
    await provider.sendTurn(admitted.request);

    await expect(pending).resolves.toEqual({ ok: false, refusal: "cancelled" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(prompts).toEqual(["Keep working"]);
    expect(messages.listByThread(threadId, 10).messages.map((message) => message.content)).toContain("Keep working");
    expect(threads.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardown).not.toHaveBeenCalled();
    runtime.release(admitted.lease);
  });

  it("joins a second complete to the existing hold and its result", async () => {
    const first = service.complete(threadId, 3000);
    await vi.advanceTimersByTimeAsync(2000);
    const second = service.complete(threadId, 5000);

    await vi.advanceTimersByTimeAsync(1000);

    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ ok: true, thread: { user_completed_at: COMPLETED_AT } });
    expect(results[1]).toEqual(results[0]);
    expect(lifecyclePushes()).toHaveLength(1);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("persists and publishes before teardown while keeping admission reserved", async () => {
    const observed: Array<{ completedAt: string | null | undefined; pushes: number; reserved: string | undefined }> = [];
    let resolve!: () => void;
    const promise = new Promise<void>((resolveTeardown) => { resolve = resolveTeardown; });
    teardown.mockImplementation(async () => {
      observed.push({
        completedAt: threads.findById(threadId)?.user_completed_at,
        pushes: lifecyclePushes().length,
        reserved: reservations.get(threadId)?.state,
      });
      await promise;
    });
    const pending = service.complete(threadId, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => {
      expect(observed).toEqual([{ completedAt: COMPLETED_AT, pushes: 1, reserved: "completing" }]);
    });

    expect(reservations.reserve(threadId, "activeTurn")).toBeNull();
    resolve();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(reservations.get(threadId)).toBeUndefined();
  });

  it("keeps completion and reports cleanup state after release fails", async () => {
    teardown.mockRejectedValueOnce(new Error("terminal cleanup failed"));
    const pending = service.complete(threadId, 3000);

    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      thread: { user_completed_at: COMPLETED_AT, cleanup_state: "blocked", cleanup_reason: "terminal cleanup failed" },
    });
    expect(threads.findById(threadId)).toMatchObject({
      user_completed_at: COMPLETED_AT, cleanup_state: "blocked", cleanup_reason: "terminal cleanup failed",
    });
    expect(lifecyclePushes()).toHaveLength(1);
    expect(reservations.get(threadId)).toBeUndefined();
  });

  it("rechecks running state when a hold expires", async () => {
    const pending = service.complete(threadId, 3000);
    activeThreadIds.mockReturnValue([threadId]);

    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: false, refusal: "running" });
    expect(threads.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardown).not.toHaveBeenCalled();
    expect(lifecyclePushes()).toEqual([]);
  });
});
