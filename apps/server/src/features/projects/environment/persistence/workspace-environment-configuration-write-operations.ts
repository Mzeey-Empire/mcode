import { z } from "zod";
import type { Database } from "bun:sqlite";
import { WorkspaceEnvironmentStorageModeSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { WorkspaceEnvironmentConfigurationStore } from "./workspace-environment-configuration-store.js";

/** Project environment location and exact-command approval mutations. */
export const workspaceEnvironmentConfigurationWriteOperations = {
  setStorageMode: databaseWriteOperation("workspaceEnvironmentConfiguration.setStorageMode", z.tuple([z.string(), WorkspaceEnvironmentStorageModeSchema]), z.void()),
  approve: databaseWriteOperation("workspaceEnvironmentConfiguration.approve", z.tuple([z.string(), z.string(), z.string()]), z.void()),
  clearApprovals: databaseWriteOperation("workspaceEnvironmentConfiguration.clearApprovals", z.tuple([z.string()]), z.void()),
};

/** Bind configuration writes to the sole writable connection. */
export function workspaceEnvironmentConfigurationWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new WorkspaceEnvironmentConfigurationStore(db);
  const operations = workspaceEnvironmentConfigurationWriteOperations;
  return new Map([
    [operations.setStorageMode.name, databaseWriteHandler(operations.setStorageMode, (input) => store.setStorageMode(...input))],
    [operations.approve.name, databaseWriteHandler(operations.approve, (input) => store.approve(...input))],
    [operations.clearApprovals.name, databaseWriteHandler(operations.clearApprovals, (input) => store.clearApprovals(...input))],
  ]);
}
