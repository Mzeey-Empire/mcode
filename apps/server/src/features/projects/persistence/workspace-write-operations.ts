import { z } from "zod";
import { WorkspaceSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

/** Workspace mutations admitted to the sole application database writer. */
export const workspaceWriteOperations = {
  create: databaseWriteOperation("workspace.create", z.tuple([z.string(), z.string(), z.boolean()]), WorkspaceSchema()),
  prependToSortOrder: databaseWriteOperation("workspace.prependToSortOrder", z.tuple([z.string()]), z.void()),
  reorderToIndex: databaseWriteOperation("workspace.reorderToIndex", z.tuple([z.string(), z.number().int()]), z.void()),
  rename: databaseWriteOperation("workspace.rename", z.tuple([z.string(), z.string()]), WorkspaceSchema().nullable()),
  setPinned: databaseWriteOperation("workspace.setPinned", z.tuple([z.string(), z.boolean()]), z.void()),
  touchLastOpened: databaseWriteOperation("workspace.touchLastOpened", z.tuple([z.string()]), z.void()),
  removeRecent: databaseWriteOperation("workspace.removeRecent", z.tuple([z.string()]), z.void()),
  softDelete: databaseWriteOperation("workspace.softDelete", z.tuple([z.string()]), z.boolean()),
  hardDelete: databaseWriteOperation("workspace.hardDelete", z.tuple([z.string()]), z.boolean()),
  touch: databaseWriteOperation("workspace.touch", z.tuple([z.string()]), z.void()),
  setIsGitRepo: databaseWriteOperation("workspace.setIsGitRepo", z.tuple([z.string(), z.boolean()]), z.void()),
};
