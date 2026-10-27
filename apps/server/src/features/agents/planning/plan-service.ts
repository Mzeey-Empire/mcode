import * as NodeCrypto from "node:crypto";
import { PlanImplementSchema, PlanImplementErrorSchema, type PlanSaveError, type PlanSaveVersion, type PlanVersion, type PlanImplement, type PendingPlanImplement, type PlanImplementError, type PlanImplementReceipt, type PlanCommentError, type PlanComment } from "@mcode/contracts/models/plan";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { type IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { ThreadService } from "../../thread-control/lifecycle/thread-service.js";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { CreateAndSendOptions } from "../turns/thread-creation-coordinator.js";
import type { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { ThreadControlMutationReservationService } from "../../thread-control/authority/thread-control-mutation-reservation-service.js";
import type { AgentTurnCommandPort } from "../orchestration/agent-turn-command-port.js";
import type { ScopedPreGrantService } from "../permissions/scoped-pre-grant.js";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { broadcast } from "../../../application/transport/push.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { sendAdmittedTurn } from "../transport/turn-message-dispatch.js";
import { mergePlanVersions } from "./merge-plan-versions.js";
import type { PlanFileWriter } from "./plan-file-writer.js";
import { planWriteOperations } from "./persistence/plan-write-operations.js";
import { planImplementWriteOperations as implementWrites, type PlanImplementRequest } from "./persistence/plan-implement-write-operations.js";
import { planCommentWriteOperations as commentWrites, type PlanCommentWriteResult } from "./persistence/plan-comment-write-operations.js";
import type { PlanCommentStore } from "./persistence/plan-comment-store.js";

/** Existing runtime owners used to reserve and dispatch Implement. */
export interface PlanImplementRuntime {
  threads: Pick<ThreadRepo, "findById" | "publishPlanPhase">;
  providers: IProviderRegistry;
  reservations: ThreadControlMutationReservationService;
  commands: Pick<AgentTurnCommandPort, "sendMessage" | "createAndSend">;
  startups: Pick<ThreadStartupService, "get">;
  messages: Pick<MessageRepo, "hasMessages">;
  threadService: Pick<ThreadService, "delete">;
  grants: Pick<ScopedPreGrantService, "issue" | "clear">;
  git: Pick<GitWorktreeService, "resolveHeadCommit">;
}

/** A rejected plan operation, with the current version for explicit conflict resolution. */
export class PlanServiceError extends Error {
  readonly code: PlanSaveError["code"] | PlanImplementError["code"] | PlanCommentError["code"];
  readonly latestVersion: PlanVersion | null;

  constructor(failure: PlanSaveError | PlanImplementError | PlanCommentError) {
    super(failure.code);
    this.code = failure.code;
    this.latestVersion = "latestVersion" in failure ? failure.latestVersion : null;
  }
}

/** Owns version saves, snapshots and durable Implement admission. */
export class PlanService {
  private readonly implementing = new Map<string, { fingerprint: string; promise: Promise<PlanImplementReceipt> }>();
  private readonly waiting = new Map<string, { input: PlanImplement; token: string }>();
  private readonly settling = new Map<string, Promise<void>>();

  constructor(private readonly writer: ApplicationDatabaseWriter,
    private readonly progress: Pick<CanonicalAcceptedProgress, "reloadPlans" | "waitForTerminalSaves"> | undefined,
    private readonly files: PlanFileWriter,
    private readonly runtime?: PlanImplementRuntime) {}

  /** Join duplicate presses before yielding, then replay the durable admission outcome. */
  implement(params: PlanImplement): Promise<PlanImplementReceipt> {
    const input = PlanImplementSchema().parse(params);
    const { threadId, versionId, expectedRevision, pending, target } = input;
    const fingerprint = NodeCrypto.createHash("sha256").update(JSON.stringify({ threadId, versionId,
      expectedRevision, pending, target })).digest("hex");
    const current = this.implementing.get(input.requestId);
    if (current) {
      if (current.fingerprint !== fingerprint) return Promise.reject(new PlanServiceError({ code: "implement_request_conflict", latestVersion: null }));
      return current.promise;
    }
    const promise = Promise.resolve().then(() => this.runImplement(input, fingerprint));
    this.implementing.set(input.requestId, { fingerprint, promise });
    const retire = () => { this.implementing.delete(input.requestId); };
    void promise.then(retire, retire);
    return promise;
  }

  private async runImplement(input: PlanImplement, fingerprint: string): Promise<PlanImplementReceipt> {
    const prior = await this.writer.execute(implementWrites.read, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new PlanServiceError({ code: "implement_request_conflict", latestVersion: null });
      return this.receiptOrFailure(prior);
    }
    const runtime = this.runtime;
    if (!runtime) throw new Error("Plan Implement runtime is not configured");
    const token = runtime.reservations.reserve(input.threadId, input.target === "thread" ? "activeTurn" : "planImplement");
    if (!token) throw new PlanServiceError({ code: "thread_busy", latestVersion: null });
    let failure: unknown;
    let queued = false;
    try {
      queued = await this.prepareAndAdmit(input, fingerprint, token, runtime);
    } catch (error) {
      failure = error;
    }
    if (queued) {
      this.waiting.set(input.requestId, { input, token });
      // Preparation may have saved the carried draft, and other clients must see it before they lock on it.
      await this.publishVersions(input.threadId);
      const pending = await this.pendingImplement(input.threadId);
      if (pending) broadcast("plan.implementPending", { threadId: input.threadId, pending });
      await this.settleStartup(input.requestId);
      const request = await this.writer.execute(implementWrites.read, input.requestId);
      if (request) return this.receiptOrFailure(request);
    }
    return this.settleImplement(input, token, runtime, failure);
  }

  private async prepareAndAdmit(input: PlanImplement, fingerprint: string, token: string, runtime: PlanImplementRuntime): Promise<boolean> {
    await this.progress?.waitForTerminalSaves(input.threadId);
    const thread = runtime.threads.findById(input.threadId);
    if (!thread) throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
    const sourceCommit = input.target === "new-worktree"
      ? await runtime.git.resolveHeadCommit(thread.workspace_id, thread.mode, thread.worktree_path) : undefined;
    const prepared = await this.writer.execute(implementWrites.prepare, { input, fingerprint,
      planFilePath: this.files.path(input.threadId), sourceCommit });
    if (!prepared.ok) throw new PlanServiceError(prepared);
    await this.files.writeSnapshot(input.threadId, prepared.contentMd);
    const provider = runtime.providers.resolve(ProviderIdSchema.parse(thread.provider));
    const outcome = await provider.prepareImplement?.({ threadId: input.threadId, markdown: prepared.contentMd,
      nativePlanFile: prepared.nativePlanFile }) ?? { outcome: "skipped", reason: "no-file" };
    await this.writer.execute(implementWrites.nativeFile, { requestId: input.requestId, outcome });
    if (input.target !== "thread") return this.admitNewThread(prepared.request, thread, runtime);
    await this.admitSourceThread(prepared.request, thread, token, runtime);
    return false;
  }

  private async admitSourceThread(request: PlanImplementRequest, thread: NonNullable<ReturnType<ThreadRepo["findById"]>>, token: string, runtime: PlanImplementRuntime): Promise<void> {
    if (["claude", "copilot"].includes(thread.provider)) {
      runtime.grants.issue({ threadId: thread.id, toolName: "Read", path: this.files.path(thread.id) });
    }
    // The receipt only needs admission. Starting or resuming the provider
    // session can take far longer, and its failures arrive on the turn.
    await sendAdmittedTurn(runtime.commands, { threadId: thread.id, messageId: request.messageId,
      content: request.wireText, displayContent: `Implement plan v${request.version}`,
      interactionMode: "build", mutationReservationToken: token, planImplement: { requestId: request.requestId },
      model: thread.model ?? undefined, reasoningLevel: thread.reasoning_level ?? undefined,
      provider: ProviderIdSchema.parse(thread.provider), permissionMode: "default", attachments: [] });
  }

  private async admitNewThread(request: PlanImplementRequest, thread: NonNullable<ReturnType<ThreadRepo["findById"]>>, runtime: PlanImplementRuntime): Promise<boolean> {
    if (thread.mode === "worktree" && !thread.worktree_path) {
      throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
    }
    const newWorktree = request.target === "new-worktree";
    const created = await runtime.commands.createAndSend({ workspaceId: thread.workspace_id, startupId: request.requestId,
      content: request.wireText, displayContent: `Implement plan v${request.version}`,
      mode: newWorktree ? "worktree" : thread.mode, branch: thread.branch, interactionMode: "build",
      worktreeBranchMode: "branchless",
      existingWorktreePath: newWorktree ? undefined : thread.worktree_path ?? undefined,
      existingWorktreeBaseBranch: thread.base_branch ?? thread.branch,
      model: thread.model ?? undefined, reasoningLevel: thread.reasoning_level ?? undefined,
      provider: ProviderIdSchema.parse(thread.provider), permissionMode: "default", attachments: [],
    }, this.newThreadOptions(request, thread));
    return created.queued === true;
  }

  private newThreadOptions(request: PlanImplementRequest, thread: NonNullable<ReturnType<ThreadRepo["findById"]>>): CreateAndSendOptions {
    const identity = { messageId: request.messageId, planImplement: { requestId: request.requestId } };
    if (request.target === "new-worktree") {
      if (!request.sourceCommit) throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
      return { ...identity, worktreeStart: { commit: request.sourceCommit } };
    }
    return { ...identity, setupSkip: thread.worktree_path ? { reason: "plan-implement", sourceThreadId: thread.id } : undefined };
  }

  /** Reconcile a queued Implement after a committed admission or startup transition. */
  settleStartup(requestId: string): Promise<void> {
    const current = this.settling.get(requestId);
    if (current) return current.then(() => this.settleStartup(requestId));
    const pending = this.waiting.get(requestId);
    if (!pending || !this.runtime) return Promise.resolve();
    const operation = this.settleWaiting(pending, this.runtime);
    this.settling.set(requestId, operation);
    const retire = () => { this.settling.delete(requestId); };
    void operation.then(retire, retire);
    return operation;
  }

  private async settleWaiting(pending: { input: PlanImplement; token: string }, runtime: PlanImplementRuntime): Promise<void> {
    const request = await this.writer.execute(implementWrites.read, pending.input.requestId);
    const startup = runtime.startups.get(pending.input.requestId);
    if (request?.status === "preparing" && startup && ["pending", "running", "blocked"].includes(startup.state)) return;
    try {
      await this.settleImplement(pending.input, pending.token, runtime, undefined);
    } catch (error) {
      if (!(error instanceof PlanServiceError)) throw error;
    }
    this.waiting.delete(pending.input.requestId);
    broadcast("plan.implementPending", { threadId: pending.input.threadId, pending: null });
  }

  private async settleImplement(input: PlanImplement, token: string, runtime: PlanImplementRuntime, failure: unknown): Promise<PlanImplementReceipt> {
    let request = await this.writer.execute(implementWrites.read, input.requestId);
    if (request?.status === "preparing") {
      request = await this.writer.execute(implementWrites.fail, { requestId: input.requestId,
        code: this.failureCode(request, runtime, failure) });
    }
    if (input.target !== "thread") runtime.reservations.release(input.threadId, token);
    if (request?.status === "admitted") {
      return this.publishAdmission(request);
    }
    releaseFailedImplementReservation(input.threadId, token, runtime);
    if (request) {
      await this.compensateNewThread(request);
      // Preparation may have committed the request's unsent edit before it failed.
      await this.publishVersions(input.threadId);
      await this.files.writeAfterCommit(input.threadId);
      return this.receiptOrFailure(request);
    }
    if (failure instanceof PlanServiceError) throw failure;
    throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
  }

  private failureCode(request: PlanImplementRequest, runtime: PlanImplementRuntime, failure: unknown): string {
    const startup = request.startupId ? runtime.startups.get(request.startupId) : null;
    return startup?.cancellation === "requested" ? "startup_cancelled" : implementFailureCode(failure);
  }

  private async publishAdmission(request: PlanImplementRequest): Promise<PlanImplementReceipt> {
    await this.publishVersions(request.sourceThreadId);
    if (request.targetThreadId && request.targetThreadId !== request.sourceThreadId) {
      await this.publishVersions(request.targetThreadId);
    }
    return this.receiptOrFailure(request);
  }

  private async compensateNewThread(request: PlanImplementRequest): Promise<void> {
    if (request.target === "thread" || !request.startupId || !this.runtime) return;
    const startup = this.runtime.startups.get(request.startupId);
    const targetId = startup?.threadId;
    if (!targetId) return;
    if (targetId === request.sourceThreadId) return;
    await this.removeEmptyTarget(targetId, this.runtime, request.target === "new-worktree");
  }

  private async removeEmptyTarget(threadId: string, runtime: PlanImplementRuntime, cleanupWorktree: boolean): Promise<void> {
    const token = runtime.reservations.reserve(threadId, "planImplement");
    if (!token) return;
    try {
      if (runtime.messages.hasMessages(threadId)) return;
      const thread = runtime.threads.findById(threadId);
      if (thread?.deleted_at === null) await runtime.threadService.delete(threadId, cleanupWorktree);
    } finally {
      runtime.reservations.release(threadId, token);
    }
  }

  private async publishVersions(threadId: string): Promise<void> {
    const versions = this.progress?.reloadPlans(threadId) ?? (await this.snapshot({ threadId })).versions;
    for (const version of versions) broadcast("plan.versionUpserted", { threadId, version });
    await this.publishComments(threadId);
  }

  /** Replay-safe creation of a saved comment. */
  async createComment(input: Parameters<PlanCommentStore["create"]>[0]): Promise<PlanComment> {
    return this.publishCommentResult(await this.writer.execute(commentWrites.create, input));
  }

  /** Replace the note while retaining its anchor. */
  async updateComment(input: Parameters<PlanCommentStore["update"]>[0]): Promise<PlanComment> {
    return this.publishCommentResult(await this.writer.execute(commentWrites.update, input));
  }

  /** Resolve or reopen a comment. */
  async setCommentStatus(input: Parameters<PlanCommentStore["setStatus"]>[0]): Promise<PlanComment> {
    return this.publishCommentResult(await this.writer.execute(commentWrites.setStatus, input));
  }

  /** Delete once and publish the removed identity after commit. */
  async deleteComment(input: Parameters<PlanCommentStore["delete"]>[0]): Promise<void> {
    const result = await this.writer.execute(commentWrites.delete, input);
    if (!result.ok) throw new PlanServiceError(result);
    if (result.threadId) {
      this.progress?.reloadPlans(result.threadId);
      broadcast("plan.commentsChanged", { threadId: result.threadId, upserted: [], deletedIds: [input.commentId] });
    }
  }

  private publishCommentResult(result: PlanCommentWriteResult): PlanComment {
    if (!result.ok) throw new PlanServiceError(result);
    this.progress?.reloadPlans(result.comment.threadId);
    broadcast("plan.commentsChanged", { threadId: result.comment.threadId, upserted: [result.comment], deletedIds: [] });
    return result.comment;
  }

  private async publishComments(threadId: string): Promise<void> {
    const { comments } = await this.snapshot({ threadId });
    broadcast("plan.commentsChanged", { threadId, upserted: comments, deletedIds: [] });
  }

  private async receiptOrFailure(request: PlanImplementRequest): Promise<PlanImplementReceipt> {
    const targetThreadId = request.status === "admitted" ? request.targetThreadId : this.waitingTarget(request);
    if (targetThreadId) {
      return { requestId: request.requestId, versionId: request.versionId, version: request.version,
        targetThreadId, messageId: request.messageId,
        nativePlanFile: request.nativePlanFile, state: request.status === "admitted" ? "admitted" : "waiting-for-setup" };
    }
    const code = request.failureCode === "interrupted" ? "implement_interrupted" : request.failureCode;
    const result = await this.writer.execute(planWriteOperations.snapshot, { threadId: request.sourceThreadId });
    const latestVersion = result.ok ? result.versions.at(-1) ?? null : null;
    const parsed = PlanImplementErrorSchema().safeParse({ code, latestVersion });
    throw new PlanServiceError(parsed.success ? parsed.data : { code: "implement_failed", latestVersion });
  }

  private waitingTarget(request: PlanImplementRequest): string | null {
    if (request.status !== "preparing" || request.target !== "new-worktree" || !this.waiting.has(request.requestId)) return null;
    return this.runtime?.startups.get(request.requestId)?.threadId ?? null;
  }

  /** Run after turn and startup recovery, before accepting new commands. */
  async recoverInterrupted(): Promise<void> {
    const requests = await this.writer.execute(implementWrites.preparing, {});
    for (const request of requests) {
      const settled = await this.writer.execute(implementWrites.fail, { requestId: request.requestId, code: "interrupted" });
      if (settled?.status !== "failed") continue;
      const pending = this.waiting.get(request.requestId);
      if (pending && this.runtime) releaseFailedImplementReservation(request.sourceThreadId, pending.token, this.runtime);
      await this.compensateNewThread(settled);
      await this.publishVersions(request.sourceThreadId);
      await this.files.writeAfterCommit(request.sourceThreadId);
      this.waiting.delete(request.requestId);
      if (pending) broadcast("plan.implementPending", { threadId: request.sourceThreadId, pending: null });
    }
  }

  /** Save or replay one revision-checked draft and publish only after commit. */
  async saveVersion(input: PlanSaveVersion): Promise<PlanVersion> {
    await this.progress?.waitForTerminalSaves(input.threadId);
    const result = await this.writer.execute(planWriteOperations.saveVersion, input);
    if (!result.ok) throw new PlanServiceError(result);
    this.progress?.reloadPlans(input.threadId);
    this.runtime?.threads.publishPlanPhase(input.threadId);
    broadcast("plan.versionUpserted", { threadId: input.threadId, version: result.version });
    await this.publishComments(input.threadId);
    await this.files.writeAfterCommit(input.threadId);
    return result.version;
  }

  /** Read a serialized snapshot and preserve any later accepted status in memory. */
  async snapshot(input: { threadId: string }) {
    // Read the hold first: admission accepts the version before the hold ends, so a snapshot that sees
    // no hold also sees the accepted version, while the reverse order could pair a ready version with no hold.
    const pendingImplement = await this.pendingImplement(input.threadId);
    const result = await this.writer.execute(planWriteOperations.snapshot, input);
    if (!result.ok) throw new PlanServiceError(result);
    return { versions: mergePlanVersions(result.versions, this.progress?.reloadPlans(input.threadId) ?? result.versions),
      comments: result.comments, phase: result.phase, pendingQuestions: result.pendingQuestions, pendingImplement };
  }

  private async pendingImplement(threadId: string): Promise<PendingPlanImplement | null> {
    for (const { input } of this.waiting.values()) {
      if (input.threadId !== threadId) continue;
      const request = await this.writer.execute(implementWrites.read, input.requestId);
      const targetThreadId = request ? this.waitingTarget(request) : null;
      if (request && targetThreadId) return { targetThreadId, version: request.version };
    }
    return null;
  }
}

function implementFailureCode(failure: unknown): string {
  if (failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string") {
    return failure.code;
  }
  return "implement_failed";
}

function releaseFailedImplementReservation(threadId: string, token: string, runtime: PlanImplementRuntime): void {
  runtime.reservations.release(threadId, token);
  if (!runtime.reservations.get(threadId)) runtime.grants.clear(threadId);
}
