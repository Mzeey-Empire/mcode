import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { PermissionModeSchema, ProviderIdSchema, CanonicalAgentEventEnvelopeSchema, AgentEventSchema, isDelegateTaskToolName } from "@mcode/contracts";
import { canonicalAgentEvents, canonicalAgentItems, canonicalAgentTurns, delegatedTasks, threadStartups, threadControlApprovals } from "../../../runtime/persistence/sqlite/schema.js";

/** Immutable launch snapshot, captured before any approval or startup side effect. */
export const DelegatedTaskPlanSchema = z.object({
  workspaceId: z.string(), title: z.string(), prompt: z.string(),
  providerId: ProviderIdSchema, modelId: z.string(), permissionMode: PermissionModeSchema,
  coordinatorPermissionMode: PermissionModeSchema,
  checkout: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("direct"), branch: z.string() }),
    z.object({ kind: z.literal("attached"), path: z.string(), baseBranch: z.string() }),
    z.object({ kind: z.literal("new_worktree"), commit: z.string(), baseBranch: z.string() }),
  ]),
  messageId: z.string().uuid(), creatorTurnId: z.string(), creatorToolCallId: z.string(),
  creatorProviderId: ProviderIdSchema, userId: z.string(),
});
/** Pinned delegated-task launch plan. */
export type DelegatedTaskPlan = z.infer<typeof DelegatedTaskPlanSchema>;
/** Durable task identity and its immutable launch plan. */
export const DelegatedTaskSchema = z.object({
  taskId: z.string().uuid(), coordinatorThreadId: z.string(), clientRequestId: z.string(),
  inputFingerprint: z.string(), plan: DelegatedTaskPlanSchema, createdAt: z.number(),
});
/** Delegation receipt, independent of mutable startup and turn state. */
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>;
/** Input claimed atomically before a delegated task may launch. */
export type ClaimTaskInput = Omit<DelegatedTask, "taskId" | "createdAt">;
/** Claim outcome preserves the first plan and rejects conflicting wire input. */
export type ClaimResult = { kind: "claimed" | "existing"; task: DelegatedTask } | { kind: "conflict" };

/** Synchronous receipt operations owned by the application database writer. */
export class DelegatedTaskStore {
  private readonly orm;

  constructor(db: Database) { this.orm = drizzle(db); }

  /** Claim one retry key without overwriting a previously pinned launch plan. */
  claim(input: ClaimTaskInput): ClaimResult {
    const taskId = NodeCrypto.randomUUID();
    this.orm.insert(delegatedTasks).values({
      taskId, coordinatorThreadId: input.coordinatorThreadId, clientRequestId: input.clientRequestId,
      inputFingerprint: input.inputFingerprint, planJson: JSON.stringify(input.plan), createdAt: Date.now(),
    }).onConflictDoNothing({ target: [delegatedTasks.coordinatorThreadId, delegatedTasks.clientRequestId] }).run();
    const task = this.findByRequest(input.coordinatorThreadId, input.clientRequestId);
    if (!task) throw new Error("Delegated task claim did not produce a receipt");
    if (task.inputFingerprint !== input.inputFingerprint) return { kind: "conflict" };
    return { kind: task.taskId === taskId ? "claimed" : "existing", task };
  }

  /** Non-enumerating lookup for one authenticated Coordinator. */
  find(taskId: string, coordinatorThreadId: string): DelegatedTask | null {
    const row = this.orm.select().from(delegatedTasks).where(and(
      eq(delegatedTasks.taskId, taskId), eq(delegatedTasks.coordinatorThreadId, coordinatorThreadId),
    )).get();
    return row ? this.parse(row) : null;
  }

  /** Find a retry receipt before resolving mutable execution settings or HEAD. */
  findByRequest(coordinatorThreadId: string, clientRequestId: string): DelegatedTask | null {
    const row = this.orm.select().from(delegatedTasks).where(and(
      eq(delegatedTasks.coordinatorThreadId, coordinatorThreadId), eq(delegatedTasks.clientRequestId, clientRequestId),
    )).get();
    return row ? this.parse(row) : null;
  }

  /** Trusted approval recovery reads the task by its durable approval identity. */
  get(taskId: string): DelegatedTask | null {
    const row = this.orm.select().from(delegatedTasks).where(eq(delegatedTasks.taskId, taskId)).get();
    return row ? this.parse(row) : null;
  }

  /** Enumerate receipts owned by one coordinator, regardless of child visibility. */
  listByCoordinator(coordinatorThreadId: string): DelegatedTask[] {
    return this.orm.select().from(delegatedTasks)
      .where(eq(delegatedTasks.coordinatorThreadId, coordinatorThreadId)).all().map((row) => this.parse(row));
  }

  /** Read task receipts without durable terminal evidence. */
  listUnfinishedCandidates(coordinatorThreadId?: string): DelegatedTask[] {
    return this.orm.select(getTableColumns(delegatedTasks)).from(delegatedTasks)
      .leftJoin(canonicalAgentTurns, eq(canonicalAgentTurns.id, delegatedTasks.taskId))
      .leftJoin(threadStartups, eq(threadStartups.startupId, delegatedTasks.taskId))
      .leftJoin(threadControlApprovals, eq(threadControlApprovals.id, delegatedTasks.taskId))
      .where(and(
        coordinatorThreadId === undefined ? undefined : eq(delegatedTasks.coordinatorThreadId, coordinatorThreadId),
        sql`CASE
          WHEN ${canonicalAgentTurns.id} IS NOT NULL
            THEN ${canonicalAgentTurns.status} NOT IN ('Completed', 'Errored', 'Cancelled', 'Interrupted')
          WHEN ${threadStartups.startupId} IS NOT NULL
            THEN ${threadStartups.state} NOT IN ('failed', 'interrupted', 'cancelled')
          ELSE ${threadControlApprovals.status} IS NULL
            OR ${threadControlApprovals.status} NOT IN ('rejected', 'expired', 'cancelled')
        END`,
      )).all().map((row) => this.parse(row));
  }

  /** Resolve the original narrative identity from the creator turn's full tool input. */
  sourceCalls(coordinatorThreadId: string, creatorTurnId: string) {
    const rows = this.orm.select({ envelopeJson: canonicalAgentEvents.envelopeJson }).from(canonicalAgentEvents)
      .where(and(eq(canonicalAgentEvents.threadId, coordinatorThreadId), eq(canonicalAgentEvents.turnId, creatorTurnId),
        sql`json_extract(${canonicalAgentEvents.envelopeJson}, '$.payload.type') = 'publication.recorded'`))
      .orderBy(asc(canonicalAgentEvents.durableRevision), asc(canonicalAgentEvents.acceptedSequence)).all();
    return rows.flatMap((row) => {
      const payload = CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson)).payload;
      if (payload.type !== "publication.recorded" || payload.event.type !== "toolUse") return [];
      const event = AgentEventSchema().parse(payload.event);
      if (event.type !== "toolUse" || !isDelegateTaskToolName(event.toolName) || typeof event.toolInput.clientRequestId !== "string") return [];
      const item = this.orm.select({ messageId: sql<string | null>`COALESCE(
        json_extract(${canonicalAgentItems.payloadJson}, '$.record.message_id'),
        json_extract(${canonicalAgentItems.payloadJson}, '$.narrative.record.message_id'))` })
        .from(canonicalAgentItems).where(and(eq(canonicalAgentItems.id, `toolCall:${event.toolCallId}`),
          eq(canonicalAgentItems.threadId, coordinatorThreadId), eq(canonicalAgentItems.turnId, creatorTurnId))).get();
      return [{ id: event.toolCallId, clientRequestId: event.toolInput.clientRequestId, messageId: item?.messageId ?? null }];
    });
  }

  private parse(row: typeof delegatedTasks.$inferSelect): DelegatedTask {
    return DelegatedTaskSchema.parse({ ...row, plan: JSON.parse(row.planJson) });
  }
}
