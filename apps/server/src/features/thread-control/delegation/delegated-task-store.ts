import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { PermissionModeSchema, ProviderIdSchema } from "@mcode/contracts";
import { delegatedTasks } from "../../../runtime/persistence/sqlite/schema.js";

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

  private parse(row: typeof delegatedTasks.$inferSelect): DelegatedTask {
    return DelegatedTaskSchema.parse({ ...row, plan: JSON.parse(row.planJson) });
  }
}
