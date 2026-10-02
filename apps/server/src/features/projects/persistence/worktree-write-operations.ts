import { z } from "zod";
import type { Database } from "bun:sqlite";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { WorktreeStore } from "./worktree-store.js";

const worktreeInput = z.object({ canonicalPath: z.string(), label: z.string(), branch: z.string().optional(), baseRef: z.string().optional(), managed: z.boolean() }).strict();
const worktree = z.object({ worktreeId: z.string(), label: z.string(), branch: z.string().optional(), baseRef: z.string().optional() }).strict();

/** Complete worktree reconciliation and identity registration commands. */
export const worktreeWriteOperations = {
  reconcile: databaseWriteOperation<Parameters<WorktreeStore["reconcile"]>, ReturnType<WorktreeStore["reconcile"]>>("worktree.reconcile", z.tuple([z.string(), z.array(worktreeInput).max(4096)]), z.array(worktree)),
  register: databaseWriteOperation("worktree.register", z.tuple([z.string(), worktreeInput]), worktree),
};

/** Bind worktree writes to the sole writable connection. */
export function worktreeWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new WorktreeStore(db);
  const operations = worktreeWriteOperations;
  return new Map([
    [operations.reconcile.name, databaseWriteHandler(operations.reconcile, (input) => store.reconcile(...input))],
    [operations.register.name, databaseWriteHandler(operations.register, (input) => store.register(...input))],
  ]);
}
