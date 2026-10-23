import { ThreadStartupStore } from "../../thread-startup/persistence/thread-startup-store.js";
import { ThreadStartupSchema, type ThreadStartup } from "@mcode/contracts";
import type { StartupActionTransition } from "./startup-action-runner.js";
import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  MessageMention,
  PreviewAnnotationBundle,
  StoredAttachment,
  WorkspaceEnvironmentAutomaticSetupAttempt,
  WorkspaceEnvironmentAutomaticSetupReason,
  WorkspaceEnvironmentAutomaticSetupSnapshot,
  WorkspaceEnvironmentQueuedTurn,
} from "@mcode/contracts";
import {
  MessageMentionsSchema,
  SelectedTextCommentsSchema,
  SendMessageSchema,
  StoredAttachmentSchema,
} from "@mcode/contracts";
import { z } from "zod";
import {
  messages,
  workspaceEnvironmentAutomaticSetupAttempts,
  workspaceEnvironmentQueuedTurns,
  workspaceEnvironmentSetupGates,
} from "../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";

const MAX_ACTIVE_QUEUED_TURNS_PER_THREAD = 64;
const MAX_RETAINED_TERMINAL_QUEUED_TURNS_PER_THREAD = 32;

export const QueuedTurnSubmissionSchema = z.object({
  threadId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  persistedAttachments: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), mimeType: z.string().min(1), sizeBytes: z.number().int().nonnegative(), sourcePath: z.string().min(1),
  }).strict()),
  markPlanAnswerForMessageId: z.string().uuid().optional(),
  planImplement: z.object({ requestId: z.string().uuid() }).optional(),
  sourceTurnId: z.string().uuid().optional(),
  sourceThreadId: z.string().min(1).max(256).optional(),
  sourceProviderId: z.string().min(1).max(256).optional(),
  originSourceTurnId: z.string().uuid().optional(),
}).merge(SendMessageSchema().omit({ attachments: true, messageId: true, permissionMode: true, provider: true })).extend({
  content: z.string(),
  displayContent: z.string(),
  model: z.string(),
  attachments: z.array(StoredAttachmentSchema()),
  mentions: MessageMentionsSchema(),
  selectedTextComments: SelectedTextCommentsSchema().optional(),
  permissionMode: z.enum(["default", "full", "supervised"]),
  provider: z.string().min(1),
}).strict();

/** Persisted Turn data required to dispatch after automatic Setup releases it. */
export type WorkspaceEnvironmentQueuedTurnSubmission = z.infer<typeof QueuedTurnSubmissionSchema>;

/**
 * Builds before migration 0098 parse `submission_json` strictly and know Fast only as `codexFastMode`.
 * Stable and nightly share the database, so the stored JSON keeps that key until the compatibility
 * floor passes 0098.
 */
function storedSubmissionJson(submission: WorkspaceEnvironmentQueuedTurnSubmission): string {
  const { fastMode, ...rest } = submission;
  return JSON.stringify(fastMode === undefined ? rest : { ...rest, codexFastMode: fastMode });
}

function withCurrentFastModeKey(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || !("codexFastMode" in stored)) return stored;
  const { codexFastMode, ...rest } = stored;
  return { ...rest, fastMode: codexFastMode };
}

/** Atomic input for queuing a Turn before automatic Setup releases the gate. */
export interface WorkspaceEnvironmentQueueFirstTurnInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly content: string;
  readonly attachments: readonly StoredAttachment[];
  readonly mentions: readonly MessageMention[];
  readonly previewAnnotations?: PreviewAnnotationBundle;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

/** Result of queue admission after a concurrent gate transition. */
export interface WorkspaceEnvironmentQueueAdmission {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly queued: boolean;
}

/** Signals that a Thread reached its bounded active automatic Turn queue capacity. */
export class WorkspaceEnvironmentAutomaticQueueCapacityError extends Error {
  constructor() {
    super("Automatic Setup queued Turn capacity reached");
    this.name = "WorkspaceEnvironmentAutomaticQueueCapacityError";
  }
}

/** Claimed release that may dispatch exactly once after the transaction commits. */
export interface WorkspaceEnvironmentClaimedQueuedTurn {
  readonly id: string;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

interface AutomaticSetupGate {
  state: WorkspaceEnvironmentAutomaticSetupSnapshot["gate"];
}

interface QueuedTurnMessageOrigin {
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
}

/** SQLite storage for the automatic Setup gate, attempts, and queued Turn claims. */
export class WorkspaceEnvironmentAutomaticStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(private readonly db: Database, private readonly now: () => string) {
    this.orm = drizzle(db);
  }

  /** Atomically persist one blocked Turn and create the Setup gate on the first submission. */
  queueFirstTurn(input: WorkspaceEnvironmentQueueFirstTurnInput): WorkspaceEnvironmentQueueAdmission {
    const now = this.now();
    const submissionId = NodeCrypto.randomUUID();
    const queued = this.db.transaction(
      () => this.queueBlockedFirstTurn(input, now, submissionId),
    )();
    return { snapshot: this.snapshot(input.threadId), queued };
  }

  private queueBlockedFirstTurn(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    now: string,
    submissionId: string,
  ): boolean {
    const gate = this.findSetupGate(input.threadId);
    if (isReleasedSetupGate(gate)) return false;
    this.assertQueuedTurnCapacity(input.threadId);
    this.ensureBlockedSetupGate(input.threadId, gate, now);
    const sequence = this.nextMessageSequence(input.threadId);
    const queuePosition = this.nextQueuedTurnPosition(input.threadId);
    // Implement's user message and Accepted version must commit together at admission.
    if (!input.submission.planImplement) this.insertQueuedTurnMessage(input, now, sequence);
    this.insertQueuedTurn(input, submissionId, now, queuePosition);
    this.pruneTerminalTurns(input.threadId);
    return true;
  }

  private findSetupGate(threadId: string): AutomaticSetupGate | null {
    return (this.orm
      .select({ state: workspaceEnvironmentSetupGates.state })
      .from(workspaceEnvironmentSetupGates)
      .where(eq(workspaceEnvironmentSetupGates.threadId, threadId))
      .get() ?? null) as AutomaticSetupGate | null;
  }

  private assertQueuedTurnCapacity(threadId: string): void {
    const activeCount = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(workspaceEnvironmentQueuedTurns)
      .where(and(
        eq(workspaceEnvironmentQueuedTurns.threadId, threadId),
        inArray(workspaceEnvironmentQueuedTurns.state, ["queued", "released", "dispatching"]),
      ))
      .get()!.count;
    if (activeCount >= MAX_ACTIVE_QUEUED_TURNS_PER_THREAD) {
      throw new WorkspaceEnvironmentAutomaticQueueCapacityError();
    }
  }

  private ensureBlockedSetupGate(threadId: string, gate: AutomaticSetupGate | null, now: string): void {
    if (gate) return;
    const attemptId = NodeCrypto.randomUUID();
    this.orm.insert(workspaceEnvironmentSetupGates).values({
      threadId,
      state: "blocked",
      attemptId,
      createdAt: now,
      updatedAt: now,
    }).run();
    this.orm.insert(workspaceEnvironmentAutomaticSetupAttempts).values({
      id: attemptId,
      threadId,
      state: "queued",
      reason: null,
      createdAt: now,
    }).run();
  }

  private nextMessageSequence(threadId: string): number {
    return this.orm
      .select({ sequence: sql<number>`COALESCE(MAX(${messages.sequence}), 0)` })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .get()!.sequence + 1;
  }

  private nextQueuedTurnPosition(threadId: string): number {
    return this.orm
      .select({ queuePosition: sql<number>`COALESCE(MAX(${workspaceEnvironmentQueuedTurns.queuePosition}), 0) + 1` })
      .from(workspaceEnvironmentQueuedTurns)
      .where(eq(workspaceEnvironmentQueuedTurns.threadId, threadId))
      .get()!.queuePosition;
  }

  private insertQueuedTurnMessage(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    now: string,
    sequence: number,
  ): void {
    const origin = queuedTurnMessageOrigin(input.submission);
    this.orm.insert(messages).values({
      id: input.messageId,
      threadId: input.threadId,
      role: "user",
      content: input.content,
      timestamp: now,
      sequence,
      attachments: serializedArray(input.attachments),
      previewAnnotations: serializedOptionalValue(input.previewAnnotations),
      mentions: serializedArray(input.mentions),
      selectedTextComments: serializedSelectedTextComments(input.submission.selectedTextComments),
      replyToMessageId: input.submission.replyToMessageId ?? null,
      quotedText: input.submission.quotedText ?? null,
      originType: origin ? "thread" : "composer",
      sourceThreadId: origin?.sourceThreadId ?? null,
      sourceTurnId: origin?.sourceTurnId ?? null,
      sourceProviderId: origin?.sourceProviderId ?? null,
      isInternal: 0,
    }).run();
  }

  private insertQueuedTurn(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    submissionId: string,
    now: string,
    queuePosition: number,
  ): void {
    this.orm.insert(workspaceEnvironmentQueuedTurns).values({
      id: submissionId,
      threadId: input.threadId,
      messageId: input.messageId,
      queuePosition,
      state: "queued",
      submissionJson: storedSubmissionJson(input.submission),
      createdAt: now,
    }).run();
  }

  /** Return the reconnect-authoritative lifecycle snapshot for one Thread. */
  snapshot(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const gate = this.orm
      .select({
        state: workspaceEnvironmentSetupGates.state,
        attemptId: workspaceEnvironmentSetupGates.attemptId,
      })
      .from(workspaceEnvironmentSetupGates)
      .where(eq(workspaceEnvironmentSetupGates.threadId, threadId))
      .get();
    if (!gate) return { gate: "not-required", attempt: null, queuedTurns: [] };
    const attempt = gate.attemptId
      ? this.orm
        .select({
          id: workspaceEnvironmentAutomaticSetupAttempts.id,
          state: workspaceEnvironmentAutomaticSetupAttempts.state,
          reason: workspaceEnvironmentAutomaticSetupAttempts.reason,
          failedActionId: workspaceEnvironmentAutomaticSetupAttempts.failedActionId,
          createdAt: workspaceEnvironmentAutomaticSetupAttempts.createdAt,
          startedAt: workspaceEnvironmentAutomaticSetupAttempts.startedAt,
          finishedAt: workspaceEnvironmentAutomaticSetupAttempts.finishedAt,
        })
        .from(workspaceEnvironmentAutomaticSetupAttempts)
        .where(eq(workspaceEnvironmentAutomaticSetupAttempts.id, gate.attemptId))
        .get()
      : undefined;
    const queued = this.orm
      .select({
        id: workspaceEnvironmentQueuedTurns.id,
        messageId: workspaceEnvironmentQueuedTurns.messageId,
        queuePosition: workspaceEnvironmentQueuedTurns.queuePosition,
        state: workspaceEnvironmentQueuedTurns.state,
        createdAt: workspaceEnvironmentQueuedTurns.createdAt,
        submissionJson: workspaceEnvironmentQueuedTurns.submissionJson,
        dispatchedAt: workspaceEnvironmentQueuedTurns.dispatchedAt,
      })
      .from(workspaceEnvironmentQueuedTurns)
      .where(eq(workspaceEnvironmentQueuedTurns.threadId, threadId))
      .orderBy(asc(workspaceEnvironmentQueuedTurns.queuePosition))
      .all();
    return {
      gate: gate.state as WorkspaceEnvironmentAutomaticSetupSnapshot["gate"],
      attempt: attempt ? {
        id: attempt.id,
        state: attempt.state as WorkspaceEnvironmentAutomaticSetupAttempt["state"],
        reason: attempt.reason as WorkspaceEnvironmentAutomaticSetupReason | null,
        failedActionId: attempt.failedActionId,
        createdAt: attempt.createdAt,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      } : null,
      queuedTurns: queued.map((queuedTurn) => ({
        id: queuedTurn.id,
        messageId: queuedTurn.messageId,
        state: queuedTurn.state as WorkspaceEnvironmentQueuedTurn["state"],
        createdAt: queuedTurn.createdAt,
        dispatchedAt: queuedTurn.dispatchedAt,
      })),
    };
  }

  /** Commit the attempt and its sole action projection together, releasing turns only after a pass. */
  transitionStartupActions(input: StartupActionTransition): { applied: boolean; startup: ThreadStartup | null } {
    return this.db.transaction(() => {
      const current = this.currentStartupAttempt(input);
      if (!current) {
        return { applied: false, startup: null };
      }
      const now = this.now();
      this.orm.update(workspaceEnvironmentAutomaticSetupAttempts).set({
        state: input.state,
        reason: input.state === "failed" ? "setup_failed"
          : input.state === "awaiting-approval" ? "setup_approval_required" : null,
        failedActionId: input.failedActionId ?? null,
        startedAt: current.startedAt ?? now,
        finishedAt: input.state === "passed" || input.state === "failed" ? now : null,
      }).where(eq(workspaceEnvironmentAutomaticSetupAttempts.id, input.attemptId)).run();
      const startup = this.updateStartupActions(input);
      if (input.state === "passed") {
        this.orm.update(workspaceEnvironmentSetupGates)
          .set({ state: "released-by-pass", updatedAt: now })
          .where(eq(workspaceEnvironmentSetupGates.threadId, input.threadId)).run();
        this.orm.update(workspaceEnvironmentQueuedTurns)
          .set({ state: "released", releasedAt: now })
          .where(and(eq(workspaceEnvironmentQueuedTurns.threadId, input.threadId),
            eq(workspaceEnvironmentQueuedTurns.state, "queued"))).run();
      }
      return { applied: true, startup };
    })();
  }

  private currentStartupAttempt(input: StartupActionTransition): WorkspaceEnvironmentAutomaticSetupAttempt | null {
    const startup = new ThreadStartupStore(this.db).findByThreadId(input.threadId);
    if (startup?.cancellation === "requested" || startup?.state === "cancelled") return null;
    const current = this.snapshot(input.threadId);
    if (current.gate !== "blocked" || current.attempt?.id !== input.attemptId) return null;
    return ["queued", "running", "awaiting-approval"].includes(current.attempt.state) ? current.attempt : null;
  }

  private updateStartupActions(input: StartupActionTransition): ThreadStartup | null {
    const store = new ThreadStartupStore(this.db);
    const startup = store.findByThreadId(input.threadId);
    if (!startup || startup.phase !== "setup" || startup.cancellation === "requested"
      || !["running", "blocked", "interrupted"].includes(startup.state)) return null;
    const blocked = input.state === "failed" || input.state === "awaiting-approval";
    const now = this.now();
    const next: ThreadStartup = {
      ...startup, revision: startup.revision + 1, updatedAt: now,
      state: blocked ? "blocked" : "running",
      block: blocked ? {
        code: input.state === "failed" ? "SETUP_FAILED" : "SETUP_APPROVAL_REQUIRED",
        message: input.state === "failed" ? "Project Setup failed" : "Project Setup requires approval",
        detail: input.detail,
        actions: ["retry", "continue"],
      } : undefined,
      steps: startup.steps.map((step) => step.phase === "setup" ? {
        ...step, state: blocked ? "blocked" : "running", endedAt: undefined,
        startedAt: !blocked && startup.state !== "running" ? now : step.startedAt,
        detail: { phase: "setup", actions: input.actions, exitCode: input.exitCode },
      } : step),
    };
    store.update(ThreadStartupSchema().parse(next));
    return next;
  }

  /** Atomically release queued Turns when the workspace declares no automatic Setup. */
  releaseWithoutSetup(threadId: string, attemptId?: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const now = this.now();
    this.db.transaction(() => {
      const gate = this.orm
        .select({ attemptId: workspaceEnvironmentSetupGates.attemptId })
        .from(workspaceEnvironmentSetupGates)
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
          attemptId === undefined ? undefined : eq(workspaceEnvironmentSetupGates.attemptId, attemptId),
        ))
        .get();
      if (!gate) return;
      this.orm.update(workspaceEnvironmentSetupGates)
        .set({ state: "not-required", attemptId: null, updatedAt: now })
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
        ))
        .run();
      this.orm.update(workspaceEnvironmentQueuedTurns)
        .set({ state: "released", releasedAt: now })
        .where(and(
          eq(workspaceEnvironmentQueuedTurns.threadId, threadId),
          eq(workspaceEnvironmentQueuedTurns.state, "queued"),
        ))
        .run();
      if (gate.attemptId) {
        this.orm.delete(workspaceEnvironmentAutomaticSetupAttempts)
          .where(and(
            eq(workspaceEnvironmentAutomaticSetupAttempts.id, gate.attemptId),
            eq(workspaceEnvironmentAutomaticSetupAttempts.state, "queued"),
          ))
          .run();
      }
    })();
    return this.snapshot(threadId);
  }

  /** Release queued Turns without changing the automatic Setup attempt. */
  continueWithoutSetup(threadId: string): boolean {
    const now = this.now();
    return this.db.transaction(() => {
      const released = runChanges(this.orm
        .update(workspaceEnvironmentSetupGates)
        .set({ state: "released-by-continue", updatedAt: now })
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
        )));
      if (released.changes !== 1) return false;
      this.orm.update(workspaceEnvironmentQueuedTurns)
        .set({ state: "released", releasedAt: now })
        .where(and(
          eq(workspaceEnvironmentQueuedTurns.threadId, threadId),
          eq(workspaceEnvironmentQueuedTurns.state, "queued"),
        ))
        .run();
      return true;
    })();
  }

  /** Discard pending startup Turns and clear the gate without replaying their messages. */
  cancelStartupTurns(threadId: string): void {
    this.db.transaction(() => {
      this.orm.update(workspaceEnvironmentQueuedTurns)
        .set({ state: "cancelled" })
        .where(and(
          eq(workspaceEnvironmentQueuedTurns.threadId, threadId),
          inArray(workspaceEnvironmentQueuedTurns.state, ["queued", "released", "dispatching"]),
        ))
        .run();
      this.orm.update(workspaceEnvironmentSetupGates)
        .set({ state: "not-required", attemptId: null, updatedAt: this.now() })
        .where(eq(workspaceEnvironmentSetupGates.threadId, threadId))
        .run();
      this.pruneTerminalTurns(threadId);
    })();
  }

  /** Mark the current queued or running automatic Setup attempt interrupted. */
  interruptCurrentAttempt(threadId: string): string | null {
    const now = this.now();
    return this.db.transaction(() => {
      const gate = this.orm
        .select({ attemptId: workspaceEnvironmentSetupGates.attemptId })
        .from(workspaceEnvironmentSetupGates)
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
        ))
        .get();
      if (!gate?.attemptId) return null;
      const result = runChanges(this.orm
        .update(workspaceEnvironmentAutomaticSetupAttempts)
        .set({
          state: "interrupted",
          reason: "setup_interrupted",
          finishedAt: now,
        })
        .where(and(
          eq(workspaceEnvironmentAutomaticSetupAttempts.id, gate.attemptId),
          inArray(workspaceEnvironmentAutomaticSetupAttempts.state, ["awaiting-approval", "queued", "running"]),
        )));
      if (result.changes !== 1) return null;
      this.orm.update(workspaceEnvironmentSetupGates)
        .set({ updatedAt: now })
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
        ))
        .run();
      return gate.attemptId;
    })();
  }

  /** Create one new queued automatic Setup attempt after a final blocked outcome. */
  retryCurrentAttempt(threadId: string): boolean {
    const now = this.now();
    const attemptId = NodeCrypto.randomUUID();
    return this.db.transaction(() => {
      const replaced = runChanges(this.orm
        .update(workspaceEnvironmentSetupGates)
        .set({ attemptId, updatedAt: now })
        .where(and(
          eq(workspaceEnvironmentSetupGates.threadId, threadId),
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
          sql`${workspaceEnvironmentSetupGates.attemptId} IN (SELECT id FROM workspace_environment_automatic_setup_attempts WHERE state IN ('failed', 'interrupted'))`,
        )));
      if (replaced.changes !== 1) return false;
      this.orm.insert(workspaceEnvironmentAutomaticSetupAttempts).values({
        id: attemptId,
        threadId,
        state: "queued",
        reason: null,
        createdAt: now,
      }).run();
      return true;
    })();
  }

  /** Mark unfinished automatic attempts interrupted without replaying any command. */
  interruptUnfinishedAttempts(): void {
    const now = this.now();
    this.db.transaction(() => {
      this.orm.update(workspaceEnvironmentAutomaticSetupAttempts)
        .set({
          state: "interrupted",
          reason: "setup_interrupted",
          finishedAt: now,
        })
        .where(inArray(workspaceEnvironmentAutomaticSetupAttempts.state, ["awaiting-approval", "queued", "running"]))
        .run();
      this.orm.update(workspaceEnvironmentSetupGates)
        .set({ state: "blocked", updatedAt: now })
        .where(and(
          eq(workspaceEnvironmentSetupGates.state, "blocked"),
          sql`${workspaceEnvironmentSetupGates.attemptId} IN (SELECT id FROM workspace_environment_automatic_setup_attempts WHERE state = 'interrupted')`,
        ))
        .run();
    })();
  }

  /** Claim the next released Turn so dispatch begins only once after release commits. */
  claimReleasedTurn(threadId?: string): WorkspaceEnvironmentClaimedQueuedTurn | null {
    const now = this.now();
    return this.db.transaction(() => {
      const row = threadId
        ? this.orm
          .select({ id: workspaceEnvironmentQueuedTurns.id, submissionJson: workspaceEnvironmentQueuedTurns.submissionJson })
          .from(workspaceEnvironmentQueuedTurns)
          .where(and(
            eq(workspaceEnvironmentQueuedTurns.threadId, threadId),
            eq(workspaceEnvironmentQueuedTurns.state, "released"),
          ))
          .orderBy(asc(workspaceEnvironmentQueuedTurns.queuePosition))
          .limit(1)
          .get()
        : this.orm
          .select({ id: workspaceEnvironmentQueuedTurns.id, submissionJson: workspaceEnvironmentQueuedTurns.submissionJson })
          .from(workspaceEnvironmentQueuedTurns)
          .where(eq(workspaceEnvironmentQueuedTurns.state, "released"))
          .orderBy(asc(workspaceEnvironmentQueuedTurns.createdAt), asc(workspaceEnvironmentQueuedTurns.queuePosition))
          .limit(1)
          .get();
      if (!row) return null;
      const claimed = runChanges(this.orm
        .update(workspaceEnvironmentQueuedTurns)
        .set({ state: "dispatching", dispatchingAt: now })
        .where(and(
          eq(workspaceEnvironmentQueuedTurns.id, row.id),
          eq(workspaceEnvironmentQueuedTurns.state, "released"),
        )));
      if (claimed.changes !== 1) return null;
      return { id: row.id, submission: this.parseSubmission(row.submissionJson) };
    })();
  }

  /**
   * Release a claim whose dispatch failed before its runtime was reserved, so the user can send it again.
   * A reserved claim is always marked dispatched, so a claim still dispatching never reached a provider.
   */
  releaseUnsentClaim(threadId: string): boolean {
    const result = runChanges(this.orm
      .update(workspaceEnvironmentQueuedTurns)
      .set({ state: "released", dispatchingAt: null })
      .where(sql`${workspaceEnvironmentQueuedTurns.id} = (
        SELECT id FROM workspace_environment_queued_turns
        WHERE thread_id = ${threadId} AND state = 'dispatching'
        ORDER BY queue_position ASC LIMIT 1
      )`));
    return result.changes === 1;
  }

  /** Return Threads with released Turns so startup can resume only committed dispatch work. */
  releasedThreadIds(): string[] {
    return this.orm
      .select({ threadId: workspaceEnvironmentQueuedTurns.threadId })
      .from(workspaceEnvironmentQueuedTurns)
      .where(eq(workspaceEnvironmentQueuedTurns.state, "released"))
      .groupBy(workspaceEnvironmentQueuedTurns.threadId)
      .orderBy(
        asc(sql`MIN(${workspaceEnvironmentQueuedTurns.createdAt})`),
        asc(workspaceEnvironmentQueuedTurns.threadId),
      )
      .all()
      .map((row) => row.threadId);
  }

  /** Mark a successfully dispatched Turn so reconnects do not remain in a transient claim state. */
  markDispatched(id: string): boolean {
    const result = runChanges(this.orm
      .update(workspaceEnvironmentQueuedTurns)
      .set({ state: "dispatched", dispatchedAt: this.now() })
      .where(and(
        eq(workspaceEnvironmentQueuedTurns.id, id),
        eq(workspaceEnvironmentQueuedTurns.state, "dispatching"),
      )));
    if (result.changes === 1) {
      const row = this.orm
        .select({ threadId: workspaceEnvironmentQueuedTurns.threadId })
        .from(workspaceEnvironmentQueuedTurns)
        .where(eq(workspaceEnvironmentQueuedTurns.id, id))
        .get()!;
      this.pruneTerminalTurns(row.threadId);
    }
    return result.changes === 1;
  }

  private parseSubmission(raw: string): WorkspaceEnvironmentQueuedTurnSubmission {
    try {
      return QueuedTurnSubmissionSchema.parse(withCurrentFastModeKey(JSON.parse(raw)));
    } catch {
      throw new Error("Invalid persisted automatic Setup submission");
    }
  }

  private pruneTerminalTurns(threadId: string): void {
    this.orm.delete(workspaceEnvironmentQueuedTurns)
      .where(sql`${workspaceEnvironmentQueuedTurns.id} IN (
        SELECT id FROM workspace_environment_queued_turns
        WHERE thread_id = ${threadId} AND state IN ('dispatched', 'cancelled')
        ORDER BY queue_position DESC LIMIT -1 OFFSET ${MAX_RETAINED_TERMINAL_QUEUED_TURNS_PER_THREAD}
      )`)
      .run();
  }
}

function isReleasedSetupGate(gate: AutomaticSetupGate | null): boolean {
  return gate !== null && gate.state !== "blocked";
}

function queuedTurnMessageOrigin(
  submission: WorkspaceEnvironmentQueuedTurnSubmission,
): QueuedTurnMessageOrigin | null {
  if (!submission.sourceThreadId || !submission.originSourceTurnId || !submission.sourceProviderId) {
    return null;
  }
  return {
    sourceThreadId: submission.sourceThreadId,
    sourceTurnId: submission.originSourceTurnId,
    sourceProviderId: submission.sourceProviderId,
  };
}

function serializedArray(value: readonly unknown[]): string | null {
  return value.length > 0 ? JSON.stringify(value) : null;
}

function serializedOptionalValue(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

function serializedSelectedTextComments(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return JSON.stringify(SelectedTextCommentsSchema().parse(value));
}
