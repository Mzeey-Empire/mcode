import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  StoredAttachmentSchema, MessageMentionsSchema, PreviewAnnotationBundleSchema,
  WorkspaceEnvironmentAutomaticSetupSnapshotSchema, ThreadStartupSchema, ThreadStartupActionSchema, WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX,
} from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { QueuedTurnSubmissionSchema, WorkspaceEnvironmentAutomaticStore } from "./workspace-environment-automatic-store.js";

const snapshot = WorkspaceEnvironmentAutomaticSetupSnapshotSchema();
const transition = z.object({
  threadId: z.string(), attemptId: z.string(),
  state: z.enum(["running", "awaiting-approval", "passed", "failed"]),
  actions: z.array(ThreadStartupActionSchema()).max(WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX),
  failedActionId: z.string().optional(), exitCode: z.number().int().optional(),
  detail: z.string().min(1).max(2000).optional(),
}).strict();
const firstTurn = z.object({ threadId: z.string(), messageId: z.string(), content: z.string(), attachments: z.array(StoredAttachmentSchema()), mentions: MessageMentionsSchema(), previewAnnotations: PreviewAnnotationBundleSchema().optional(), submission: QueuedTurnSubmissionSchema }).strict();
const clock = z.string();

/** Complete Setup admission, CAS, cancellation and recovery transactions with a sampled clock. */
export const workspaceEnvironmentAutomaticWriteOperations = {
  transitionStartupActions: databaseWriteOperation("workspaceEnvironmentAutomatic.transitionStartupActions", z.tuple([z.tuple([transition]), clock]), z.object({ applied: z.boolean(), startup: ThreadStartupSchema().nullable() }).strict()),
  queueFirstTurn: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>>("workspaceEnvironmentAutomatic.queueFirstTurn", z.tuple([z.tuple([firstTurn]), clock]), z.object({ snapshot, queued: z.boolean() }).strict()),
  releaseWithoutSetup: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>>("workspaceEnvironmentAutomatic.releaseWithoutSetup", z.tuple([z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string().optional()])]), clock]), snapshot),
  continueWithoutSetup: databaseWriteOperation("workspaceEnvironmentAutomatic.continueWithoutSetup", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  cancelStartupTurns: databaseWriteOperation("workspaceEnvironmentAutomatic.cancelStartupTurns", z.tuple([z.tuple([z.string()]), clock]), z.void()),
  interruptCurrentAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.interruptCurrentAttempt", z.tuple([z.tuple([z.string()]), clock]), z.string().nullable()),
  retryCurrentAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.retryCurrentAttempt", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  interruptUnfinishedAttempts: databaseWriteOperation("workspaceEnvironmentAutomatic.interruptUnfinishedAttempts", z.tuple([z.tuple([]), clock]), z.void()),
  claimReleasedTurn: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>>("workspaceEnvironmentAutomatic.claimReleasedTurn", z.tuple([z.union([z.tuple([]), z.tuple([z.string().optional()])]), clock]), z.object({ id: z.string(), submission: QueuedTurnSubmissionSchema }).strict().nullable()),
  releaseUnsentClaim: databaseWriteOperation("workspaceEnvironmentAutomatic.releaseUnsentClaim", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  markDispatched: databaseWriteOperation("workspaceEnvironmentAutomatic.markDispatched", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
};

/** Bind Setup writes to the sole writable connection without splitting transaction boundaries. */
export function workspaceEnvironmentAutomaticWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const operations = workspaceEnvironmentAutomaticWriteOperations;
  return new Map([
    [operations.transitionStartupActions.name, databaseWriteHandler(operations.transitionStartupActions, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).transitionStartupActions(...input[0]))],
    [operations.queueFirstTurn.name, databaseWriteHandler(operations.queueFirstTurn, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).queueFirstTurn(...input[0]))],
    [operations.releaseWithoutSetup.name, databaseWriteHandler(operations.releaseWithoutSetup, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).releaseWithoutSetup(...input[0]))],
    [operations.continueWithoutSetup.name, databaseWriteHandler(operations.continueWithoutSetup, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).continueWithoutSetup(...input[0]))],
    [operations.cancelStartupTurns.name, databaseWriteHandler(operations.cancelStartupTurns, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).cancelStartupTurns(...input[0]))],
    [operations.interruptCurrentAttempt.name, databaseWriteHandler(operations.interruptCurrentAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).interruptCurrentAttempt(...input[0]))],
    [operations.retryCurrentAttempt.name, databaseWriteHandler(operations.retryCurrentAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).retryCurrentAttempt(...input[0]))],
    [operations.interruptUnfinishedAttempts.name, databaseWriteHandler(operations.interruptUnfinishedAttempts, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).interruptUnfinishedAttempts(...input[0]))],
    [operations.claimReleasedTurn.name, databaseWriteHandler(operations.claimReleasedTurn, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).claimReleasedTurn(...input[0]))],
    [operations.releaseUnsentClaim.name, databaseWriteHandler(operations.releaseUnsentClaim, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).releaseUnsentClaim(...input[0]))],
    [operations.markDispatched.name, databaseWriteHandler(operations.markDispatched, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).markDispatched(...input[0]))],
  ]);
}
