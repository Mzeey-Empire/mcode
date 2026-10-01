import { z } from "zod";
import type { Database } from "bun:sqlite";
import { ThreadSchema, WorkspaceSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ProjectLifecycleStore } from "./project-lifecycle-store.js";

const id = z.tuple([z.string()]);
const threadIds = z.array(z.string());

/** Complete project transitions admitted by the shared database owner. */
export const projectLifecycleWriteOperations = {
  reuseWorkspace: databaseWriteOperation("project.reuseWorkspace", id, WorkspaceSchema().nullable()),
  beginWorkspaceDeletion: databaseWriteOperation("project.beginWorkspaceDeletion", id, z.object({ threadIds }).strict().nullable()),
  finishWorkspaceDeletion: databaseWriteOperation("project.finishWorkspaceDeletion", id, threadIds),
  forceDeleteWorkspace: databaseWriteOperation("project.forceDeleteWorkspace", id, z.object({ deleted: z.boolean(), threadIds }).strict()),
  persistProvisionedWorktree: databaseWriteOperation("project.persistProvisionedWorktree", z.tuple([z.string(), z.string(), z.string()]), ThreadSchema().nullable()),
  scheduleWorktreeCleanup: databaseWriteOperation("project.scheduleWorktreeCleanup", z.tuple([z.string(), z.string(), z.string(), z.string(), z.string().nullable()]), z.boolean()),
};

/** Bind project transitions to worker-local stores with no external callbacks. */
export function projectLifecycleWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ProjectLifecycleStore(db);
  const operations = projectLifecycleWriteOperations;
  return new Map([
    [operations.reuseWorkspace.name, databaseWriteHandler(operations.reuseWorkspace, (input) => store.reuseWorkspace(...input))],
    [operations.beginWorkspaceDeletion.name, databaseWriteHandler(operations.beginWorkspaceDeletion, (input) => store.beginWorkspaceDeletion(...input))],
    [operations.finishWorkspaceDeletion.name, databaseWriteHandler(operations.finishWorkspaceDeletion, (input) => store.finishWorkspaceDeletion(...input))],
    [operations.forceDeleteWorkspace.name, databaseWriteHandler(operations.forceDeleteWorkspace, (input) => store.forceDeleteWorkspace(...input))],
    [operations.persistProvisionedWorktree.name, databaseWriteHandler(operations.persistProvisionedWorktree, (input) => store.persistProvisionedWorktree(...input))],
    [operations.scheduleWorktreeCleanup.name, databaseWriteHandler(operations.scheduleWorktreeCleanup, (input) => store.scheduleWorktreeCleanup(...input))],
  ]);
}
