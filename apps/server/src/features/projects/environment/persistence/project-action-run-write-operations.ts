import { z } from "zod";
import type { Database } from "bun:sqlite";
import { WorkspaceEnvironmentActionRunSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { ProjectActionRunStore } from "./project-action-run-store.js";

/** Retained slot replacement, revision CAS and bounded recovery transactions. */
export const projectActionRunWriteOperations = {
  replace: databaseWriteOperation("projectActionRun.replace", z.tuple([WorkspaceEnvironmentActionRunSchema()]), WorkspaceEnvironmentActionRunSchema()),
  updateIfCurrent: databaseWriteOperation("projectActionRun.updateIfCurrent", z.tuple([WorkspaceEnvironmentActionRunSchema()]), z.boolean()),
  interruptRunning: databaseWriteOperation("projectActionRun.interruptRunning", z.tuple([z.string()]), z.array(WorkspaceEnvironmentActionRunSchema()).max(256)),
};

/** Bind Project Action writes to the sole writable connection. */
export function projectActionRunWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ProjectActionRunStore(db);
  const operations = projectActionRunWriteOperations;
  return new Map([
    [operations.replace.name, databaseWriteHandler(operations.replace, (input) => store.replace(...input))],
    [operations.updateIfCurrent.name, databaseWriteHandler(operations.updateIfCurrent, (input) => store.updateIfCurrent(...input))],
    [operations.interruptRunning.name, databaseWriteHandler(operations.interruptRunning, (input) => store.interruptRunning(...input))],
  ]);
}
