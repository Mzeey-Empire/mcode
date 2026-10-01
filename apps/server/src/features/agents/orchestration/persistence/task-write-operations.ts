import { z } from "zod";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const taskStatus = z.enum(["pending", "in_progress", "completed", "cancelled"]);
const storedTask = z.object({
  id: z.string().optional(), content: z.string(), status: taskStatus, activeForm: z.string().optional(), group: z.string().optional(),
}).strict();
const taskPatch = storedTask.pick({ content: true, status: true, activeForm: true }).partial();

/** Task read-modify-write operations execute completely on the shared owner. */
export const taskWriteOperations = {
  upsert: databaseWriteOperation("task.upsert", z.tuple([z.string(), z.array(storedTask)]), z.void()),
  upsertGroup: databaseWriteOperation("task.upsertGroup", z.tuple([z.string(), z.string(), z.array(storedTask)]), z.void()),
  appendTask: databaseWriteOperation("task.appendTask", z.tuple([z.string(), storedTask]), z.void()),
  updateTask: databaseWriteOperation("task.updateTask", z.tuple([z.string(), z.string(), taskPatch, z.string().optional()]), z.boolean()),
  removeTask: databaseWriteOperation("task.removeTask", z.tuple([z.string(), z.string(), z.string().optional()]), z.void()),
  delete: databaseWriteOperation("task.delete", z.tuple([z.string()]), z.void()),
};
