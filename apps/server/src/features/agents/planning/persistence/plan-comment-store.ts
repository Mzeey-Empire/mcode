import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as NodeCrypto from "node:crypto";
import { PlanCommentSchema, type PlanComment, type PlanCommentError, type PlanVersion } from "@mcode/contracts";
import { planComments, plans } from "../../../../runtime/persistence/sqlite/schema.js";
import { reanchorPlanComment } from "../reanchor-plan-comment.js";
import { hasPreparingPlanImplement, hasUnfinishedPlanExecution } from "./plan-write-availability.js";
import { planCommentWriteOperations as operations, type PlanCommentDeleteResult, type PlanCommentWriteResult } from "./plan-comment-write-operations.js";

type Input<K extends keyof typeof operations> = z.infer<typeof operations[K]["input"]>;
type Failure = PlanCommentError & { ok: false };

/** Domain failure thrown inside canonical admission so the entire start rolls back. */
export class PlanCommentAdmissionError extends Error {
  readonly code = "plan_comment_invalid";
  constructor() { super("The selected plan comments are no longer sendable"); }
}

/** Comment persistence shared by serialized user writes and canonical plan captures. */
export class PlanCommentStore {
  private readonly orm;
  constructor(private readonly db: Database) { this.orm = drizzle(db); }

  /** All comments, including resolved and sent records, for reconnect snapshots. */
  listByThread(threadId: string): PlanComment[] {
    return this.orm.select().from(planComments).where(eq(planComments.threadId, threadId))
      .orderBy(asc(planComments.createdAt), asc(planComments.id)).all().map(toComment);
  }

  /** Look up an assigned comment identity. */
  getById(id: string): PlanComment | null {
    const row = this.orm.select().from(planComments).where(eq(planComments.id, id)).get();
    return row ? toComment(row) : null;
  }

  /** Replays an existing identity without overwriting its note. */
  create(input: Input<"create">): PlanCommentWriteResult {
    return this.db.transaction((): PlanCommentWriteResult => {
      const parsed = operations.create.input.parse(input);
      const existing = this.getById(parsed.commentId);
      if (existing) return existing.versionId === parsed.versionId ? { ok: true, comment: existing } : invalid();
      const version = this.orm.select().from(plans).where(eq(plans.id, parsed.versionId)).get();
      if (!version) return invalid();
      const failure = this.writeFailure(version);
      if (failure) return failure;
      if (parsed.anchor.kind === "text" && (parsed.anchor.end > version.contentMd.length
        || version.contentMd.slice(parsed.anchor.start, parsed.anchor.end) !== parsed.anchor.quote)) return invalid();
      const now = new Date().toISOString();
      const comment: PlanComment = { id: parsed.commentId, versionId: version.id, threadId: version.threadId,
        anchor: parsed.anchor, body: parsed.body, status: "open", sentMessageId: null, carriedFromCommentId: null,
        createdAt: now, updatedAt: now, resolvedAt: null };
      this.insert(comment);
      return { ok: true, comment };
    })();
  }

  /** Update the note on a writable version. */
  update(input: Input<"update">): PlanCommentWriteResult {
    const parsed = operations.update.input.parse(input);
    return this.mutate(parsed.commentId, comment => ({ ...comment, body: parsed.body }));
  }

  /** Resolve and Undo share the same version and busy guards. */
  setStatus(input: Input<"setStatus">): PlanCommentWriteResult {
    const parsed = operations.setStatus.input.parse(input);
    return this.mutate(parsed.commentId, comment => ({ ...comment, status: parsed.status,
      resolvedAt: parsed.status === "resolved" ? comment.resolvedAt ?? new Date().toISOString() : null }));
  }

  /** A repeated delete succeeds even after the record is gone. */
  delete(input: Input<"delete">): PlanCommentDeleteResult {
    const parsed = operations.delete.input.parse(input);
    return this.db.transaction((): PlanCommentDeleteResult => {
      const comment = this.getById(parsed.commentId);
      if (!comment) return { ok: true, threadId: null };
      const failure = this.commentWriteFailure(comment);
      if (failure) return failure;
      this.orm.delete(planComments).where(eq(planComments.id, comment.id)).run();
      return { ok: true, threadId: comment.threadId };
    })();
  }

  /** Copy only open, unsent predecessor notes after inserting a new version. */
  carryForward(predecessorId: string, version: PlanVersion): void {
    const rows = this.orm.select().from(planComments).where(and(eq(planComments.versionId, predecessorId),
      eq(planComments.status, "open"), isNull(planComments.sentMessageId))).all();
    for (const row of rows) {
      const comment = toComment(row);
      this.insert({ ...comment, id: NodeCrypto.randomUUID(), versionId: version.id,
        anchor: reanchorPlanComment(comment.anchor, version.contentMd), carriedFromCommentId: comment.id,
        createdAt: version.createdAt, updatedAt: version.updatedAt });
    }
  }

  /** Draft edits move every open anchor, including notes already sent. */
  reanchorDraft(version: PlanVersion): void {
    const rows = this.orm.select().from(planComments).where(and(eq(planComments.versionId, version.id), eq(planComments.status, "open"))).all();
    for (const row of rows) {
      const anchor = reanchorPlanComment(toComment(row).anchor, version.contentMd);
      this.orm.update(planComments).set({ anchorJson: JSON.stringify(anchor), updatedAt: version.updatedAt })
        .where(eq(planComments.id, row.id)).run();
    }
  }

  /** Must run in the user-message transaction; any invalid id aborts the whole start. */
  stampSent(threadId: string, ids: readonly string[], messageId: string): void {
    if (ids.length === 0) return;
    const comments = [...new Set(ids)].map(id => this.getById(id));
    for (const comment of comments) {
      if (!comment || comment.threadId !== threadId
        || comment.status !== "open" || comment.sentMessageId !== null) throw new PlanCommentAdmissionError();
      const version = this.orm.select({ id: plans.id }).from(plans).where(and(
        eq(plans.id, comment.versionId), eq(plans.threadId, threadId), ne(plans.status, "accepted"),
      )).get();
      const carried = this.orm.select({ id: planComments.id }).from(planComments)
        .where(eq(planComments.carriedFromCommentId, comment.id)).get();
      if (!version || carried) {
        throw new PlanCommentAdmissionError();
      }
    }
    for (const id of new Set(ids)) {
      this.orm.update(planComments).set({ sentMessageId: messageId, updatedAt: new Date().toISOString() })
        .where(eq(planComments.id, id)).run();
    }
  }

  private mutate(id: string, change: (comment: PlanComment) => PlanComment): PlanCommentWriteResult {
    return this.db.transaction((): PlanCommentWriteResult => {
      const existing = this.getById(id);
      if (!existing) return invalid();
      const failure = this.commentWriteFailure(existing);
      if (failure) return failure;
      const comment = { ...change(existing), updatedAt: new Date().toISOString() };
      this.orm.update(planComments).set({ body: comment.body, status: comment.status,
        resolvedAt: comment.resolvedAt, updatedAt: comment.updatedAt }).where(eq(planComments.id, id)).run();
      return { ok: true, comment };
    })();
  }

  private commentWriteFailure(comment: PlanComment): Failure | null {
    const version = this.orm.select().from(plans).where(eq(plans.id, comment.versionId)).get();
    return version ? this.writeFailure(version) : invalid();
  }

  private writeFailure(version: { threadId: string; status: string }): Failure | null {
    if (hasUnfinishedPlanExecution(this.db, version.threadId) || hasPreparingPlanImplement(this.db, version.threadId)) {
      return { ok: false, code: "plan_busy" };
    }
    if (version.status === "accepted") return { ok: false, code: "plan_read_only" };
    return null;
  }

  private insert(comment: PlanComment): void {
    this.orm.insert(planComments).values({ ...comment, anchorJson: JSON.stringify(comment.anchor) }).run();
  }
}

function toComment(row: typeof planComments.$inferSelect): PlanComment {
  return PlanCommentSchema().parse({ ...row, anchor: JSON.parse(row.anchorJson) });
}

function invalid(): Failure { return { ok: false, code: "plan_comment_invalid" }; }

