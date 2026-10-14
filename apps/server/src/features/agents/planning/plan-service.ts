import * as NodeCrypto from "node:crypto";
import { PlanImplementSchema, PlanImplementErrorSchema, ProviderIdSchema,
  type PlanSaveError, type PlanSaveVersion, type PlanVersion, type PlanImplement,
  type PlanImplementError, type PlanImplementReceipt, type IProviderRegistry } from "@mcode/contracts";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
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

/** Existing runtime owners used to reserve and dispatch Implement. */
export interface PlanImplementRuntime {
  threads: Pick<ThreadRepo, "findById" | "publishPlanPhase">;
  providers: IProviderRegistry;
  reservations: ThreadControlMutationReservationService;
  commands: Pick<AgentTurnCommandPort, "sendMessage">;
  grants: Pick<ScopedPreGrantService, "issue" | "clear">;
}

/** A rejected plan operation, with the current version for explicit conflict resolution. */
export class PlanServiceError extends Error {
  readonly code: PlanSaveError["code"] | PlanImplementError["code"];
  readonly latestVersion: PlanVersion | null;

  constructor(failure: PlanSaveError | PlanImplementError) {
    super(failure.code);
    this.code = failure.code;
    this.latestVersion = failure.latestVersion;
  }
}

/** Owns version saves, snapshots and durable Implement admission. */
export class PlanService {
  private readonly implementing = new Map<string, { fingerprint: string; promise: Promise<PlanImplementReceipt> }>();

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
    const token = runtime.reservations.reserve(input.threadId, "activeTurn");
    if (!token) throw new PlanServiceError({ code: "thread_busy", latestVersion: null });
    let failure: unknown;
    try {
      await this.prepareAndAdmit(input, fingerprint, token, runtime);
    } catch (error) {
      failure = error;
    }
    return this.settleImplement(input, token, runtime, failure);
  }

  private async prepareAndAdmit(input: PlanImplement, fingerprint: string, token: string, runtime: PlanImplementRuntime): Promise<void> {
    await this.progress?.waitForTerminalSaves(input.threadId);
    const prepared = await this.writer.execute(implementWrites.prepare, { input, fingerprint, planFilePath: this.files.path(input.threadId) });
    if (!prepared.ok) throw new PlanServiceError(prepared);
    const thread = runtime.threads.findById(input.threadId);
    if (!thread) throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
    await this.files.writeSnapshot(input.threadId, prepared.contentMd);
    const provider = runtime.providers.resolve(ProviderIdSchema.parse(thread.provider));
    const outcome = await provider.prepareImplement?.({ threadId: input.threadId, markdown: prepared.contentMd,
      nativePlanFile: prepared.nativePlanFile }) ?? { outcome: "skipped", reason: "no-file" };
    await this.writer.execute(implementWrites.nativeFile, { requestId: input.requestId, outcome });
    if (provider.id === "claude" || provider.id === "copilot") {
      runtime.grants.issue({ threadId: input.threadId, toolName: "Read", path: this.files.path(input.threadId) });
    }
    // The receipt only needs admission. Starting or resuming the provider
    // session can take far longer, and its failures arrive on the turn.
    await sendAdmittedTurn(runtime.commands, { threadId: input.threadId, messageId: prepared.request.messageId,
      content: prepared.request.wireText, displayContent: `Implement plan v${prepared.request.version}`,
      interactionMode: "build", mutationReservationToken: token, planImplement: { requestId: input.requestId },
      model: thread.model ?? undefined, reasoningLevel: thread.reasoning_level ?? undefined,
      provider: ProviderIdSchema.parse(thread.provider), permissionMode: "default", attachments: [] });
  }

  private async settleImplement(input: PlanImplement, token: string, runtime: PlanImplementRuntime, failure: unknown): Promise<PlanImplementReceipt> {
    let request = await this.writer.execute(implementWrites.read, input.requestId);
    if (request?.status === "preparing") {
      request = await this.writer.execute(implementWrites.fail, { requestId: input.requestId, code: implementFailureCode(failure) });
    }
    if (request?.status === "admitted") {
      return this.publishAdmission(request);
    }
    releaseFailedImplementReservation(input.threadId, token, runtime);
    if (request) {
      // Preparation may have committed the request's unsent edit before it failed.
      await this.publishVersions(input.threadId);
      await this.files.writeAfterCommit(input.threadId);
      return this.receiptOrFailure(request);
    }
    if (failure instanceof PlanServiceError) throw failure;
    throw new PlanServiceError({ code: "implement_failed", latestVersion: null });
  }

  private async publishAdmission(request: PlanImplementRequest): Promise<PlanImplementReceipt> {
    await this.publishVersions(request.sourceThreadId);
    return this.receiptOrFailure(request);
  }

  private async publishVersions(threadId: string): Promise<void> {
    const versions = this.progress?.reloadPlans(threadId) ?? (await this.snapshot({ threadId })).versions;
    for (const version of versions) broadcast("plan.versionUpserted", { threadId, version });
  }

  private async receiptOrFailure(request: PlanImplementRequest): Promise<PlanImplementReceipt> {
    if (request.status === "admitted" && request.targetThreadId) {
      return { requestId: request.requestId, versionId: request.versionId, version: request.version,
        targetThreadId: request.targetThreadId, messageId: request.messageId,
        nativePlanFile: request.nativePlanFile, state: "admitted" };
    }
    const code = request.failureCode === "interrupted" ? "implement_interrupted" : request.failureCode;
    const result = await this.writer.execute(planWriteOperations.snapshot, { threadId: request.sourceThreadId });
    const latestVersion = result.ok ? result.versions.at(-1) ?? null : null;
    const parsed = PlanImplementErrorSchema().safeParse({ code, latestVersion });
    throw new PlanServiceError(parsed.success ? parsed.data : { code: "implement_failed", latestVersion });
  }

  /** Run after turn and startup recovery, before accepting new commands. */
  async recoverInterrupted(): Promise<void> {
    const requests = await this.writer.execute(implementWrites.preparing, {});
    for (const request of requests) {
      const settled = await this.writer.execute(implementWrites.fail, { requestId: request.requestId, code: "interrupted" });
      if (settled?.status !== "failed") continue;
      this.progress?.reloadPlans(request.sourceThreadId);
      await this.files.writeAfterCommit(request.sourceThreadId);
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
    await this.files.writeAfterCommit(input.threadId);
    return result.version;
  }

  /** Read a serialized snapshot and preserve any later accepted status in memory. */
  async snapshot(input: { threadId: string }) {
    const result = await this.writer.execute(planWriteOperations.snapshot, input);
    if (!result.ok) throw new PlanServiceError(result);
    return { versions: mergePlanVersions(result.versions, this.progress?.reloadPlans(input.threadId) ?? result.versions),
      phase: result.phase, pendingQuestions: result.pendingQuestions };
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
