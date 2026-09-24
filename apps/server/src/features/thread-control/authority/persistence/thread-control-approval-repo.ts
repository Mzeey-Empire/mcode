import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  ResolvedExecutionSchema,
  ThreadPlacementSchema,
  type ResolvedExecution,
  type ThreadPlacement,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { threadControlApprovals } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";

/** Persisted input needed to resume a protected delegated-thread creation. */
export interface PendingThreadCreateApproval {
  operation: "thread_create_batch";
  approvalId: string;
  threadId: string;
  workspaceId: string;
  prompt: string;
  execution: ResolvedExecution;
  placement: Extract<ThreadPlacement, { type: "new_worktree" }>;
  turnId: string;
  operationPhase: "pre_provision" | "provisioning" | "provisioned" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
}

/** Persisted cross-thread send approval. */
export interface PendingThreadSendApproval {
  operation: "thread_send";
  approvalId: string;
  threadId: string;
  workspaceId: string;
  message: string;
  execution: ResolvedExecution;
  turnId: string;
  operationPhase: "pre_dispatch" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  sourceProviderId?: string;
}

/** Persisted cross-thread stop approval. */
export interface PendingThreadStopApproval {
  operation: "thread_stop";
  approvalId: string;
  threadId: string;
  workspaceId: string;
  execution: ResolvedExecution;
  turnId: string;
  operationPhase: "pre_dispatch" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
}

/** Safe persisted identity for a processing approval whose payload cannot be rehydrated. */
export interface MalformedThreadCreateApproval {
  invalid: true;
  operation?: ThreadControlApprovalOperation;
  approvalId: string;
  threadId: string;
  workspaceId: string;
  callerId: string;
  sourceThreadId?: string;
}

/** Processing approval that can either resume safely or must fail closed. */
export type PendingThreadControlApproval = PendingThreadCreateApproval | PendingThreadSendApproval | PendingThreadStopApproval;
export type RecoverableThreadCreateApproval = PendingThreadControlApproval | MalformedThreadCreateApproval;
/** Durable operation identifiers stored with thread-control approvals. */
export type ThreadControlApprovalOperation = "thread_create_batch" | "thread_send" | "thread_stop";

/** Columns read by approval recovery queries; status and timestamps are intentionally omitted. */
const APPROVAL_COLUMNS = {
  id: threadControlApprovals.id,
  threadId: threadControlApprovals.threadId,
  workspaceId: threadControlApprovals.workspaceId,
  prompt: threadControlApprovals.prompt,
  executionJson: threadControlApprovals.executionJson,
  placementJson: threadControlApprovals.placementJson,
  turnId: threadControlApprovals.turnId,
  operationPhase: threadControlApprovals.operationPhase,
  callerId: threadControlApprovals.callerId,
  sourceThreadId: threadControlApprovals.sourceThreadId,
  sourceTurnId: threadControlApprovals.sourceTurnId,
  sourceProviderId: threadControlApprovals.sourceProviderId,
  operation: threadControlApprovals.operation,
} as const;

type ApprovalRow = Pick<typeof threadControlApprovals.$inferSelect, keyof typeof APPROVAL_COLUMNS>;

function parseOperation(value: string | null | undefined): ThreadControlApprovalOperation | undefined {
  return value === "thread_create_batch" || value === "thread_send" || value === "thread_stop" ? value : undefined;
}

/** Durable repository for protected thread-control creation approvals. */
@injectable()
export class ThreadControlApprovalRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Persist one pending approval and return its opaque identity. */
  create(input: Omit<PendingThreadCreateApproval, "approvalId" | "operation" | "operationPhase">): string {
    const approvalId = NodeCrypto.randomUUID();
    this.orm.insert(threadControlApprovals).values({
      id: approvalId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      prompt: input.prompt,
      executionJson: JSON.stringify(input.execution),
      placementJson: JSON.stringify(input.placement),
      turnId: input.turnId,
      callerId: input.callerId,
      sourceThreadId: input.sourceThreadId ?? null,
      operation: "thread_create_batch",
      operationPhase: "pre_provision",
      status: "pending",
    }).run();
    return approvalId;
  }

  /** Persist a supervised cross-thread send before a human decision. */
  createSend(input: Omit<PendingThreadSendApproval, "approvalId" | "operation" | "operationPhase"> & { approvalId?: string }): string {
    return this.createMutation({
      operation: "thread_send",
      prompt: input.message,
      placement: { type: "direct" },
      ...input,
    });
  }

  /** Persist a supervised cross-thread stop before a human decision. */
  createStop(input: Omit<PendingThreadStopApproval, "approvalId" | "operation" | "operationPhase"> & { approvalId?: string }): string {
    return this.createMutation({
      operation: "thread_stop",
      prompt: "",
      placement: { type: "direct" },
      ...input,
    });
  }

  private createMutation(input: {
    operation: "thread_send" | "thread_stop";
    threadId: string;
    workspaceId: string;
    prompt: string;
    execution: ResolvedExecution;
    placement: ThreadPlacement;
    turnId: string;
    callerId: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    sourceProviderId?: string;
    approvalId?: string;
  }): string {
    const approvalId = input.approvalId ?? NodeCrypto.randomUUID();
    this.orm.insert(threadControlApprovals).values({
      id: approvalId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      prompt: input.prompt,
      executionJson: JSON.stringify(input.execution),
      placementJson: JSON.stringify(input.placement),
      turnId: input.turnId,
      callerId: input.callerId,
      sourceThreadId: input.sourceThreadId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      sourceProviderId: input.sourceProviderId ?? null,
      operation: input.operation,
      operationPhase: "pre_dispatch",
      status: "pending",
    }).run();
    return approvalId;
  }

  /** Atomically claim one pending approval so repeated decisions cannot resume it twice. */
  claim(approvalId: string): PendingThreadControlApproval | null {
    const row = this.orm.transaction((tx) => {
      const row = tx
        .select(APPROVAL_COLUMNS)
        .from(threadControlApprovals)
        .where(and(eq(threadControlApprovals.id, approvalId), eq(threadControlApprovals.status, "pending")))
        .get();
      if (!row) return null;
      const updated = runChanges(tx
        .update(threadControlApprovals)
        .set({ status: "processing", processingStartedAt: new Date().toISOString() })
        .where(and(eq(threadControlApprovals.id, approvalId), eq(threadControlApprovals.status, "pending")))
        );
      return updated.changes === 1 ? row : null;
    });
    if (!row) return null;
    try {
      return this.parse(row);
    } catch (error) {
      logger.error("Failed to parse claimed thread-control approval", {
        approvalId: row.id,
        threadId: row.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.settle(row.id, "failed");
      return null;
    }
  }

  /** Persist a completed side-effect boundary before the next operation begins. */
  setOperationPhase(approvalId: string, phase: PendingThreadCreateApproval["operationPhase"] | "pre_dispatch"): boolean {
    return runChanges(this.orm
      .update(threadControlApprovals)
      .set({ operationPhase: phase })
      .where(and(eq(threadControlApprovals.id, approvalId), eq(threadControlApprovals.status, "processing")))
      ).changes === 1;
  }

  /** Return approvals stranded by a process exit without letting one malformed payload block recovery. */
  listProcessing(): RecoverableThreadCreateApproval[] {
    const rows = this.orm
      .select(APPROVAL_COLUMNS)
      .from(threadControlApprovals)
      .where(eq(threadControlApprovals.status, "processing"))
      .orderBy(asc(threadControlApprovals.processingStartedAt), asc(threadControlApprovals.id))
      .all();
    return rows.map((row) => {
      try {
        return this.parse(row);
      } catch {
        const operation = parseOperation(row.operation);
        return {
          invalid: true,
          ...(operation ? { operation } : {}),
          approvalId: row.id,
          threadId: row.threadId,
          workspaceId: row.workspaceId,
          callerId: row.callerId ?? "unknown",
          ...(row.sourceThreadId ? { sourceThreadId: row.sourceThreadId } : {}),
        };
      }
    });
  }

  /** Return a pre-side-effect accepted operation to the visible pending state. */
  requeue(approvalId: string): boolean {
    return runChanges(this.orm
      .update(threadControlApprovals)
      .set({ status: "pending", processingStartedAt: null })
      .where(and(
        eq(threadControlApprovals.id, approvalId),
        eq(threadControlApprovals.status, "processing"),
        eq(threadControlApprovals.operationPhase, "pre_provision"),
      ))
      ).changes === 1;
  }

  /** Return a recovered provisioning approval to the pre-provision pending state. */
  requeueRecoveredProvisioning(approvalId: string): boolean {
    return runChanges(this.orm
      .update(threadControlApprovals)
      .set({ status: "pending", processingStartedAt: null, operationPhase: "pre_provision" })
      .where(and(
        eq(threadControlApprovals.id, approvalId),
        eq(threadControlApprovals.status, "processing"),
        eq(threadControlApprovals.operationPhase, "provisioning"),
      ))
      ).changes === 1;
  }

  /** Mark a processing approval with its terminal outcome, or fail malformed pending data. */
  settle(approvalId: string, status: "approved" | "rejected" | "failed"): boolean {
    const where = status === "failed"
      ? and(eq(threadControlApprovals.id, approvalId), inArray(threadControlApprovals.status, ["pending", "processing"]))
      : and(eq(threadControlApprovals.id, approvalId), eq(threadControlApprovals.status, "processing"));
    return runChanges(this.orm
      .update(threadControlApprovals)
      .set({ status, resolvedAt: new Date().toISOString() })
      .where(where)
      ).changes === 1;
  }

  /** Return pending approval cards for one visible thread, skipping malformed payloads. */
  listPendingByThread(threadId: string): PendingThreadControlApproval[] {
    const rows = this.orm
      .select(APPROVAL_COLUMNS)
      .from(threadControlApprovals)
      .where(and(eq(threadControlApprovals.threadId, threadId), eq(threadControlApprovals.status, "pending")))
      .orderBy(asc(threadControlApprovals.createdAt), asc(threadControlApprovals.id))
      .all();
    const parsed: PendingThreadControlApproval[] = [];
    for (const row of rows) {
      try {
        parsed.push(this.parse(row));
      } catch (error) {
        logger.error("Skipping malformed pending thread-control approval", {
          approvalId: row.id,
          threadId: row.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parsed;
  }

  /** Return pending mutation approvals created by one source thread. */
  listPendingBySourceThread(sourceThreadId: string): PendingThreadControlApproval[] {
    const rows = this.orm
      .select(APPROVAL_COLUMNS)
      .from(threadControlApprovals)
      .where(and(eq(threadControlApprovals.sourceThreadId, sourceThreadId), eq(threadControlApprovals.status, "pending")))
      .orderBy(asc(threadControlApprovals.createdAt), asc(threadControlApprovals.id))
      .all();
    const parsed: PendingThreadControlApproval[] = [];
    for (const row of rows) {
      try {
        parsed.push(this.parse(row));
      } catch (error) {
        logger.error("Skipping malformed pending source-thread approval", {
          approvalId: row.id,
          threadId: row.threadId,
          sourceThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parsed;
  }

  private parse(row: ApprovalRow): PendingThreadControlApproval {
    const operation = parseOperation(row.operation);
    if (!operation) throw new Error("Stored thread-control approval has invalid operation");
    const execution = ResolvedExecutionSchema().parse(JSON.parse(row.executionJson));
    return parseApprovalByOperation(operation, row, execution);
  }

  /** Return all durable pending approvals so mutation reservations can rehydrate before ingress. */
  listPending(): RecoverableThreadCreateApproval[] {
    const rows = this.orm
      .select(APPROVAL_COLUMNS)
      .from(threadControlApprovals)
      .where(eq(threadControlApprovals.status, "pending"))
      .orderBy(asc(threadControlApprovals.createdAt), asc(threadControlApprovals.id))
      .all();
    return rows.map((row) => {
      try {
        return this.parse(row);
      } catch {
        const operation = parseOperation(row.operation);
        return {
          invalid: true,
          ...(operation ? { operation } : {}),
          approvalId: row.id,
          threadId: row.threadId,
          workspaceId: row.workspaceId,
          callerId: row.callerId ?? "unknown",
          ...(row.sourceThreadId ? { sourceThreadId: row.sourceThreadId } : {}),
        };
      }
    });
  }

  /** Requeue a mutation that had not crossed its external dispatch boundary. */
  requeueDispatch(approvalId: string): boolean {
    return runChanges(this.orm
      .update(threadControlApprovals)
      .set({ status: "pending", processingStartedAt: null, operationPhase: "pre_dispatch" })
      .where(and(
        eq(threadControlApprovals.id, approvalId),
        eq(threadControlApprovals.status, "processing"),
        eq(threadControlApprovals.operationPhase, "pre_dispatch"),
      ))
      ).changes === 1;
  }
}

function approvalIdentity(row: ApprovalRow): {
  approvalId: string;
  threadId: string;
  workspaceId: string;
  turnId: string;
  callerId: string;
} {
  return {
    approvalId: row.id,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    turnId: row.turnId,
    callerId: row.callerId ?? "unknown",
  };
}

function sourceThreadFields(row: ApprovalRow): Pick<PendingThreadCreateApproval, "sourceThreadId"> {
  return row.sourceThreadId ? { sourceThreadId: row.sourceThreadId } : {};
}

function sourceSendFields(row: ApprovalRow): Pick<
  PendingThreadSendApproval,
  "sourceThreadId" | "sourceTurnId" | "sourceProviderId"
> {
  return {
    ...sourceThreadFields(row),
    ...(row.sourceTurnId ? { sourceTurnId: row.sourceTurnId } : {}),
    ...(row.sourceProviderId ? { sourceProviderId: row.sourceProviderId } : {}),
  };
}

function parseApprovalByOperation(
  operation: ThreadControlApprovalOperation,
  row: ApprovalRow,
  execution: ResolvedExecution,
): PendingThreadControlApproval {
  const parsers: Record<ThreadControlApprovalOperation, () => PendingThreadControlApproval> = {
    thread_create_batch: () => parseCreateApproval(row, execution),
    thread_send: () => parseSendApproval(row, execution),
    thread_stop: () => parseStopApproval(row, execution),
  };
  return parsers[operation]();
}

function parseCreateApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadCreateApproval {
  const placement = ThreadPlacementSchema().parse(JSON.parse(row.placementJson));
  if (placement.type !== "new_worktree") throw new Error("Stored thread-control approval has invalid placement");
  return {
    operation: "thread_create_batch",
    ...approvalIdentity(row),
    prompt: row.prompt,
    execution,
    placement,
    operationPhase: row.operationPhase as PendingThreadCreateApproval["operationPhase"],
    ...sourceThreadFields(row),
  };
}

function parseSendApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadSendApproval {
  return {
    operation: "thread_send",
    ...approvalIdentity(row),
    message: row.prompt,
    execution,
    operationPhase: row.operationPhase as PendingThreadSendApproval["operationPhase"],
    ...sourceSendFields(row),
  };
}

function parseStopApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadStopApproval {
  return {
    operation: "thread_stop",
    ...approvalIdentity(row),
    execution,
    operationPhase: row.operationPhase as PendingThreadStopApproval["operationPhase"],
    ...sourceThreadFields(row),
  };
}
