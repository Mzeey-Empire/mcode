import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import { PlanVersionSchema, type PlanSaveVersion, type PlanVersion } from "@mcode/contracts/models/plan";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";
import { plans, canonicalAgentItems } from "../../../../runtime/persistence/sqlite/schema.js";
import { readCanonicalPlan } from "../legacy-plan-record.js";
import { mergePlanVersions } from "../merge-plan-versions.js";
import { planTitle } from "../plan-title.js";
import type { PlanPersistenceReady } from "../plan-execution-state.js";
import type { PlanSaveResult, PlanSnapshotResult } from "./plan-write-operations.js";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { PlanQuestionParser } from "../plan-question-parser.js";
import { PlanQuestionAnswersStore } from "./plan-question-answers-store.js";
import { PlanCommentStore } from "./plan-comment-store.js";
import { hasPreparingPlanImplement, hasUnfinishedPlanExecution } from "./plan-write-availability.js";

/** Plan queries and transactional operations, used on the application's sole writer. */
export class PlanStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(private readonly db: Database) { this.orm = drizzle(db); }

  /** Allocate an agent version and retire its mutable/reviewable predecessors. */
  create(threadId: string, messageId: string, capture: PlanPersistenceReady, providerId: ProviderId | null): PlanVersion {
    return this.db.transaction(() => {
      const prior = this.listByThread(threadId);
      const now = new Date().toISOString();
      for (const plan of prior) {
        if (plan.status === "draft" || plan.status === "ready") {
          this.orm.update(plans).set({ status: "superseded", updatedAt: now }).where(eq(plans.id, plan.id)).run();
        }
      }
      const version: PlanVersion = { id: NodeCrypto.randomUUID(), threadId, messageId,
        version: (prior.at(-1)?.version ?? 0) + 1, title: capture.title, contentMd: capture.contentMd,
        status: "ready", author: "agent", providerId, captureSource: capture.captureSource,
        baseVersionId: null, revision: 0, createdAt: now, updatedAt: now, acceptedAt: null, acceptedMessageId: null };
      this.insert(version, capture.nativePlanFile ? JSON.stringify(capture.nativePlanFile) : null);
      return version;
    })();
  }

  /** Checks busy and revision preconditions in the same transaction as the save. */
  saveVersion(input: PlanSaveVersion): PlanSaveResult {
    return this.db.transaction((): PlanSaveResult => {
      if (!this.threadExists(input.threadId)) return { ok: false, code: "thread_not_found", latestVersion: null };
      const latest = this.listByThread(input.threadId).at(-1) ?? null;
      if (this.hasUnfinishedExecution(input.threadId) || this.hasPreparingImplement(input.threadId)) {
        return { ok: false, code: "plan_busy", latestVersion: latest };
      }
      return this.saveAvailableVersion(input, latest);
    })();
  }

  /** Unfinished canonical executions exclude user plan mutations. */
  hasUnfinishedExecution(threadId: string): boolean {
    return hasUnfinishedPlanExecution(this.db, threadId);
  }

  /** A prepared snapshot holds all plan writes until admission or compensation. */
  hasPreparingImplement(threadId: string): boolean {
    return hasPreparingPlanImplement(this.db, threadId);
  }

  private saveAvailableVersion(input: PlanSaveVersion, latest: PlanVersion | null): PlanSaveResult {
    const existing = this.getById(input.versionId);
    const base = this.getById(input.baseVersionId);
    if (isAcceptedVersion(input.threadId, base) || isAcceptedVersion(input.threadId, existing)) {
      return { ok: false, code: "plan_read_only", latestVersion: latest };
    }
    if (existing) return this.saveDraft(input, existing, latest);
    if (!latest || latest.id !== input.baseVersionId || latest.status !== "ready" || latest.revision !== input.baseRevision) {
      return { ok: false, code: "plan_conflict", latestVersion: latest };
    }
    const now = new Date().toISOString();
    const version: PlanVersion = { id: input.versionId, threadId: input.threadId, messageId: null,
      version: latest.version + 1, title: planTitle(input.contentMd), contentMd: input.contentMd,
      status: "draft", author: "user", providerId: null, captureSource: "edit", baseVersionId: latest.id,
      revision: 1, createdAt: now, updatedAt: now, acceptedAt: null, acceptedMessageId: null };
    this.insert(version);
    new PlanCommentStore(this.db).carryForward(latest.id, version);
    return { ok: true, version };
  }

  private saveDraft(input: PlanSaveVersion, existing: PlanVersion, latest: PlanVersion | null): PlanSaveResult {
    const conflict: PlanSaveResult = { ok: false, code: "plan_conflict", latestVersion: latest };
    if (existing.threadId !== input.threadId || existing.status !== "draft" || existing.id !== latest?.id) return conflict;
    if (existing.revision === input.baseRevision + 1 && existing.contentMd === input.contentMd) return { ok: true, version: existing };
    if (existing.revision !== input.baseRevision) return conflict;
    const version = { ...existing, title: planTitle(input.contentMd), contentMd: input.contentMd,
      revision: existing.revision + 1, updatedAt: new Date().toISOString() };
    this.orm.update(plans).set({ title: version.title, contentMd: version.contentMd,
      revision: version.revision, updatedAt: version.updatedAt }).where(eq(plans.id, existing.id)).run();
    new PlanCommentStore(this.db).reanchorDraft(version);
    return { ok: true, version };
  }

  /** Serializes the snapshot behind preceding writes and merges retained canonical history. */
  snapshot(threadId: string): PlanSnapshotResult {
    return this.db.transaction((): PlanSnapshotResult => {
      if (!this.threadExists(threadId)) return { ok: false, code: "thread_not_found", latestVersion: null };
      const phase = new ThreadStore(this.db).findById(threadId)?.plan_phase ?? null;
      return { ok: true, versions: this.listWithHistory(threadId), comments: this.listComments(threadId), phase,
        pendingQuestions: phase === "questions" ? this.pendingQuestions(threadId) : null, pendingImplement: null };
    })();
  }

  private pendingQuestions(threadId: string) {
    const native = new PlanQuestionAnswersStore(this.db).pendingNative(threadId)[0];
    if (native) return { assistantMessageId: native.requestId, questions: native.questions };
    const message = this.db.query<{ id: string; content: string }, [string, string]>(`SELECT id, content FROM messages
      WHERE thread_id = ? AND role = 'assistant' AND instr(content, ?) > 0
      ORDER BY sequence DESC LIMIT 1`).get(threadId, "```plan-questions");
    if (!message || this.db.prepare("SELECT 1 FROM plan_question_answers WHERE assistant_message_id = ?").get(message.id)) return null;
    const questions = new PlanQuestionParser().feed(message.content);
    return questions ? { assistantMessageId: message.id, questions } : null;
  }

  /** Read retained plan projections alongside the authoritative version rows. */
  listWithHistory(threadId: string): PlanVersion[] {
    const historic: PlanVersion[] = [];
    const items = this.orm.select().from(canonicalAgentItems).where(and(
      eq(canonicalAgentItems.threadId, threadId),
      sql`CASE WHEN json_valid(${canonicalAgentItems.payloadJson}) THEN json_extract(${canonicalAgentItems.payloadJson}, '$.projection') END = 'plan'`,
    )).orderBy(asc(canonicalAgentItems.updatedAt)).all();
    for (const item of items) {
      try {
        const payload: unknown = JSON.parse(item.payloadJson);
        if (typeof payload === "object" && payload !== null) {
          const plan = readCanonicalPlan("plan" in payload ? payload.plan : undefined);
          if (plan.threadId !== threadId) throw new Error("Canonical plan belongs to another thread");
          historic.push(plan);
        }
      } catch (error) {
        logger.warn("Skipping unreadable historic plan", {
          threadId, itemId: item.id, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return mergePlanVersions(historic, this.listByThread(threadId));
  }

  private threadExists(threadId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL").get(threadId));
  }

  /** Insert an assigned version without allocating another identity. */
  insert(version: PlanVersion, nativePlanFileJson: string | null = null): void {
    const predecessor = version.author === "agent" ? this.listByThread(version.threadId).at(-1) : undefined;
    this.orm.insert(plans).values({ ...version, nativePlanFileJson }).run();
    if (predecessor) new PlanCommentStore(this.db).carryForward(predecessor.id, version);
    if (version.status === "ready" || version.status === "draft") new ThreadStore(this.db).updatePlanPhase(version.threadId, "ready");
  }

  /** Saved comments for snapshots and post-commit pushes. */
  listComments(threadId: string) {
    return new PlanCommentStore(this.db).listByThread(threadId);
  }

  /** All durable versions in their per-thread order. */
  listByThread(threadId: string): PlanVersion[] {
    return this.orm.select().from(plans).where(eq(plans.threadId, threadId)).orderBy(asc(plans.version)).all().map(row => this.toVersion(row));
  }

  /** Latest version eligible for the Mcode plan-file projection. */
  getLatestForThread(threadId: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(and(eq(plans.threadId, threadId), ne(plans.status, "superseded")))
      .orderBy(desc(plans.version)).get();
    return row ? this.toVersion(row) : null;
  }

  /** Find one assigned version. */
  getById(id: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(eq(plans.id, id)).get();
    return row ? this.toVersion(row) : null;
  }

  /** Find the agent version tied to an assistant message. */
  getByMessageId(messageId: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(eq(plans.messageId, messageId)).get();
    return row ? this.toVersion(row) : null;
  }

  private toVersion(row: typeof plans.$inferSelect): PlanVersion {
    const admitted = row.status === "accepted" ? this.db.prepare<{ message_id: string }, [string]>(
      "SELECT message_id FROM plan_implement_requests WHERE version_id = ? AND status = 'admitted' LIMIT 1",
    ).get(row.id) : null;
    const acceptedMessageId = row.status === "accepted" && row.captureSource === "copy"
      ? row.messageId : admitted?.message_id ?? null;
    return PlanVersionSchema().parse({ ...row, acceptedMessageId });
  }
}

function isAcceptedVersion(threadId: string, version: PlanVersion | null): boolean {
  return version?.threadId === threadId && version.status === "accepted";
}
