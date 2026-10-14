import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { NativePlanFileOutcomeSchema, NativePlanFileRefSchema, PLAN_MAX_CONTENT_CHARS, type PlanImplement,
  type PlanImplementError, type PlanVersion, type NativePlanFileOutcome } from "@mcode/contracts";
import { planImplementRequests, plans, threads } from "../../../../runtime/persistence/sqlite/schema.js";
import { PlanStore } from "./plan-store.js";
import { PlanImplementRequestSchema, type PlanImplementPrepareResult, type PlanImplementRequest } from "./plan-implement-write-operations.js";

class PreparationRefused extends Error {
  constructor(readonly failure: PlanImplementError) { super(failure.code); }
}

/** Writer-owned request transitions and the plan effect inside canonical admission. */
export class PlanImplementStore {
  private readonly orm;
  private readonly versions;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
    this.versions = new PlanStore(db);
  }

  /** Atomically save pending text and capture exactly the revision the user saw. */
  prepare({ input, fingerprint, planFilePath }: { input: PlanImplement; fingerprint: string; planFilePath: string }): PlanImplementPrepareResult {
    try {
      return this.db.transaction(() => this.prepareInTransaction(input, fingerprint, planFilePath))();
    } catch (error) {
      if (!(error instanceof PreparationRefused)) throw error;
      return { ok: false, ...error.failure };
    }
  }

  private prepareInTransaction(input: PlanImplement, fingerprint: string, planFilePath: string): PlanImplementPrepareResult {
    const latest = this.versions.listByThread(input.threadId).at(-1) ?? null;
    const refuse = (code: PlanImplementError["code"]): never => {
      throw new PreparationRefused({ code, latestVersion: latest });
    };
    const thread = this.orm.select().from(threads).where(eq(threads.id, input.threadId)).get();
    if (!thread || thread.deletedAt) refuse("implement_failed");
    if (this.versions.hasUnfinishedExecution(input.threadId)) refuse("thread_busy");
    if (this.versions.hasPreparingImplement(input.threadId)) refuse("plan_busy");
    if (input.pending) {
      const saved = this.versions.saveVersion({ ...input.pending, threadId: input.threadId });
      if (!saved.ok) refuse(saved.code === "thread_not_found" ? "implement_failed" : saved.code);
    }
    const version = this.requireImplementableVersion(input, refuse);
    const now = new Date().toISOString();
    const wireText = `Implement plan v${version.version}: "${version.title}".\n\nThis is the plan the user approved. It supersedes any earlier plan or plan file, including your own. Mcode keeps this text at ${planFilePath}.\n\n${version.contentMd}`;
    const request: PlanImplementRequest = { requestId: input.requestId, sourceThreadId: input.threadId, fingerprint,
      versionId: version.id, version: version.version, revision: version.revision, title: version.title, wireText,
      target: input.target, sourceCommit: null,
      ...this.targetIdentity(input),
      messageId: NodeCrypto.randomUUID(), status: "preparing", failureCode: null, nativePlanFile: null,
      turnId: null, executionId: null, createdAt: now, updatedAt: now };
    this.orm.insert(planImplementRequests).values({ ...request, nativePlanFileJson: null }).run();
    return { ok: true, request, contentMd: version.contentMd, nativePlanFile: this.newestNativePlanFile(input.threadId) };
  }

  private targetIdentity(input: PlanImplement) {
    const existingThread = input.target === "thread";
    return { targetThreadId: existingThread ? input.threadId : null,
      startupId: existingThread ? null : input.requestId };
  }

  private requireImplementableVersion(input: PlanImplement, refuse: (code: PlanImplementError["code"]) => never): PlanVersion {
    const version = this.versions.getById(input.versionId);
    if (!version || version.threadId !== input.threadId) return refuse("plan_conflict");
    if (version.status === "accepted") refuse("plan_read_only");
    if (version.status === "superseded" || version.revision !== input.expectedRevision) refuse("plan_conflict");
    if (version.contentMd.length > PLAN_MAX_CONTENT_CHARS) refuse("implement_failed");
    return version;
  }

  private newestNativePlanFile(threadId: string) {
    const agent = this.orm.select().from(plans).where(and(eq(plans.threadId, threadId), eq(plans.author, "agent")))
      .orderBy(desc(plans.version)).get();
    return agent?.nativePlanFileJson ? NativePlanFileRefSchema().parse(JSON.parse(agent.nativePlanFileJson)) : null;
  }

  read(requestId: string): PlanImplementRequest | null {
    const row = this.orm.select().from(planImplementRequests).where(eq(planImplementRequests.requestId, requestId)).get();
    return row ? this.toRequest(row) : null;
  }

  /** Record file preparation only while admission has not settled. */
  recordNativeFile(requestId: string, outcome: NativePlanFileOutcome): void {
    this.orm.update(planImplementRequests).set({ nativePlanFileJson: JSON.stringify(outcome), updatedAt: new Date().toISOString() })
      .where(and(eq(planImplementRequests.requestId, requestId), eq(planImplementRequests.status, "preparing"))).run();
  }

  /** Conditional compensation cannot turn an admitted request into a failure. */
  fail(requestId: string, code: string): PlanImplementRequest | null {
    this.orm.update(planImplementRequests).set({ status: "failed", failureCode: code, updatedAt: new Date().toISOString() })
      .where(and(eq(planImplementRequests.requestId, requestId), eq(planImplementRequests.status, "preparing"))).run();
    return this.read(requestId);
  }

  /** Startup recovery considers only requests that never committed admission. */
  preparing(): PlanImplementRequest[] {
    return this.orm.select().from(planImplementRequests).where(eq(planImplementRequests.status, "preparing")).all()
      .map(row => this.toRequest(row));
  }

  /** Runs on the canonical start transaction's connection so every effect rolls back together. */
  acceptPlanImplement(input: { requestId: string; threadId: string; messageId: string; turnId: string; executionId: string }): void {
    const request = this.requireAdmissionRequest(input);
    const version = this.requireAdmissionVersion(request);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE plans SET status = 'superseded', updated_at = ? WHERE thread_id = ? AND id <> ? AND status IN ('draft', 'ready')")
      .run(now, request.sourceThreadId, version.id);
    this.orm.update(plans).set({ status: "accepted", acceptedAt: now, updatedAt: now }).where(eq(plans.id, version.id)).run();
    this.orm.update(threads).set({ interactionMode: "build" }).where(eq(threads.id, request.sourceThreadId)).run();
    if (request.target === "new-thread") {
      this.versions.insert({ ...version, id: NodeCrypto.randomUUID(), threadId: input.threadId,
        messageId: input.messageId, status: "accepted", acceptedAt: now, captureSource: "copy",
        baseVersionId: version.id, createdAt: now, updatedAt: now });
    }
    this.orm.update(planImplementRequests).set({ status: "admitted", targetThreadId: input.threadId,
      turnId: input.turnId, executionId: input.executionId, updatedAt: now })
      .where(eq(planImplementRequests.requestId, request.requestId)).run();
  }

  private requireAdmissionRequest(input: { requestId: string; threadId: string; messageId: string }): PlanImplementRequest {
    const request = this.read(input.requestId);
    if (!request || request.status !== "preparing" || request.messageId !== input.messageId
      || (request.targetThreadId !== null && request.targetThreadId !== input.threadId)
      || (request.target === "thread" && request.sourceThreadId !== input.threadId)
      || (request.target !== "thread" && request.sourceThreadId === input.threadId)) {
      throw Object.assign(new Error("Implement admission identity does not match"), { code: "implement_failed" });
    }
    return request;
  }

  private requireAdmissionVersion(request: PlanImplementRequest): PlanVersion {
    const version = this.versions.getById(request.versionId);
    if (!version || version.threadId !== request.sourceThreadId || version.revision !== request.revision
      || (version.status !== "ready" && version.status !== "draft")) {
      throw Object.assign(new Error("Plan changed before admission"), { code: "plan_conflict" });
    }
    return version;
  }

  private toRequest(row: typeof planImplementRequests.$inferSelect): PlanImplementRequest {
    return PlanImplementRequestSchema.parse({ ...row,
      nativePlanFile: row.nativePlanFileJson ? NativePlanFileOutcomeSchema().parse(JSON.parse(row.nativePlanFileJson)) : null });
  }
}
