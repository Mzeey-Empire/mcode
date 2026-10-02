import { z } from "zod";
import type { Database } from "bun:sqlite";
import { TerminalProfileReferenceSchema, WorkspaceTerminalPreferenceSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { WorkspaceTerminalPreferencesStore } from "./workspace-terminal-preferences-store.js";

/** Workspace preference mutations including their workspace existence checks. */
export const workspaceTerminalPreferencesWriteOperations = {
  update: databaseWriteOperation("workspaceTerminalPreferences.update", z.tuple([z.string(), TerminalProfileReferenceSchema()]), WorkspaceTerminalPreferenceSchema()),
  reset: databaseWriteOperation("workspaceTerminalPreferences.reset", z.tuple([z.string()]), z.boolean()),
};

/** Bind preference writes to the sole writable connection. */
export function workspaceTerminalPreferencesWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new WorkspaceTerminalPreferencesStore(db);
  const operations = workspaceTerminalPreferencesWriteOperations;
  return new Map([
    [operations.update.name, databaseWriteHandler(operations.update, (input) => store.update(...input))],
    [operations.reset.name, databaseWriteHandler(operations.reset, (input) => store.reset(...input))],
  ]);
}
