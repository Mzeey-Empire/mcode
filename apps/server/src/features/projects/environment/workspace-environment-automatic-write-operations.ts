import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  StoredAttachmentSchema, MessageMentionsSchema, PreviewAnnotationBundleSchema,
  WorkspaceEnvironmentAutomaticSetupSnapshotSchema, WorkspaceEnvironmentSetupLaunchSnapshotSchema,
  WorkspaceEnvironmentAutomaticSetupReasonSchema, WorkspaceEnvironmentSetupOutcomeSchema,
} from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { QueuedTurnSubmissionSchema, WorkspaceEnvironmentAutomaticStore } from "./workspace-environment-automatic-store.js";

const snapshot = WorkspaceEnvironmentAutomaticSetupSnapshotSchema();
const attempt = z.object({ threadId: z.string(), attemptId: z.string(), snapshot: WorkspaceEnvironmentSetupLaunchSnapshotSchema() }).strict();
const completion = z.object({ threadId: z.string(), attemptId: z.string(), state: z.enum(["passed", "failed"]), reason: WorkspaceEnvironmentAutomaticSetupReasonSchema.nullable(), outcome: WorkspaceEnvironmentSetupOutcomeSchema, exitCode: z.number().nullable(), output: z.string(), outputTruncated: z.boolean() }).strict();
const failure = attempt.extend({ reason: WorkspaceEnvironmentAutomaticSetupReasonSchema, outcome: WorkspaceEnvironmentSetupOutcomeSchema.exclude(["success"]) });
const firstTurn = z.object({ threadId: z.string(), messageId: z.string(), content: z.string(), attachments: z.array(StoredAttachmentSchema()), mentions: MessageMentionsSchema(), previewAnnotations: PreviewAnnotationBundleSchema().optional(), submission: QueuedTurnSubmissionSchema }).strict();
const clock = z.string();

/** Complete Setup admission, CAS, cancellation and recovery transactions with a sampled clock. */
export const workspaceEnvironmentAutomaticWriteOperations = {
  queueFirstTurn: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>>("workspaceEnvironmentAutomatic.queueFirstTurn", z.tuple([z.tuple([firstTurn]), clock]), z.object({ snapshot, queued: z.boolean() }).strict()),
  beginAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.beginAttempt", z.tuple([z.tuple([attempt]), clock]), z.string().nullable()),
  awaitApproval: databaseWriteOperation("workspaceEnvironmentAutomatic.awaitApproval", z.tuple([z.tuple([attempt]), clock]), z.boolean()),
  resumeAwaitingApproval: databaseWriteOperation("workspaceEnvironmentAutomatic.resumeAwaitingApproval", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  completeAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.completeAttempt", z.tuple([z.tuple([completion]), clock]), z.boolean()),
  failQueuedAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.failQueuedAttempt", z.tuple([z.tuple([failure]), clock]), z.boolean()),
  releaseWithoutSetup: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>>("workspaceEnvironmentAutomatic.releaseWithoutSetup", z.tuple([z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string().optional()])]), clock]), snapshot),
  continueWithoutSetup: databaseWriteOperation("workspaceEnvironmentAutomatic.continueWithoutSetup", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  cancelStartupTurns: databaseWriteOperation("workspaceEnvironmentAutomatic.cancelStartupTurns", z.tuple([z.tuple([z.string()]), clock]), z.void()),
  interruptCurrentAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.interruptCurrentAttempt", z.tuple([z.tuple([z.string()]), clock]), z.string().nullable()),
  retryCurrentAttempt: databaseWriteOperation("workspaceEnvironmentAutomatic.retryCurrentAttempt", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
  interruptUnfinishedAttempts: databaseWriteOperation("workspaceEnvironmentAutomatic.interruptUnfinishedAttempts", z.tuple([z.tuple([]), clock]), z.void()),
  claimReleasedTurn: databaseWriteOperation<[Parameters<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>, string], ReturnType<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>>("workspaceEnvironmentAutomatic.claimReleasedTurn", z.tuple([z.union([z.tuple([]), z.tuple([z.string().optional()])]), clock]), z.object({ id: z.string(), submission: QueuedTurnSubmissionSchema }).strict().nullable()),
  markDispatched: databaseWriteOperation("workspaceEnvironmentAutomatic.markDispatched", z.tuple([z.tuple([z.string()]), clock]), z.boolean()),
};

/** Bind Setup writes to the sole writable connection without splitting transaction boundaries. */
export function workspaceEnvironmentAutomaticWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const operations = workspaceEnvironmentAutomaticWriteOperations;
  return new Map([
    [operations.queueFirstTurn.name, databaseWriteHandler(operations.queueFirstTurn, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).queueFirstTurn(...input[0]))],
    [operations.beginAttempt.name, databaseWriteHandler(operations.beginAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).beginAttempt(...input[0]))],
    [operations.awaitApproval.name, databaseWriteHandler(operations.awaitApproval, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).awaitApproval(...input[0]))],
    [operations.resumeAwaitingApproval.name, databaseWriteHandler(operations.resumeAwaitingApproval, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).resumeAwaitingApproval(...input[0]))],
    [operations.completeAttempt.name, databaseWriteHandler(operations.completeAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).completeAttempt(...input[0]))],
    [operations.failQueuedAttempt.name, databaseWriteHandler(operations.failQueuedAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).failQueuedAttempt(...input[0]))],
    [operations.releaseWithoutSetup.name, databaseWriteHandler(operations.releaseWithoutSetup, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).releaseWithoutSetup(...input[0]))],
    [operations.continueWithoutSetup.name, databaseWriteHandler(operations.continueWithoutSetup, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).continueWithoutSetup(...input[0]))],
    [operations.cancelStartupTurns.name, databaseWriteHandler(operations.cancelStartupTurns, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).cancelStartupTurns(...input[0]))],
    [operations.interruptCurrentAttempt.name, databaseWriteHandler(operations.interruptCurrentAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).interruptCurrentAttempt(...input[0]))],
    [operations.retryCurrentAttempt.name, databaseWriteHandler(operations.retryCurrentAttempt, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).retryCurrentAttempt(...input[0]))],
    [operations.interruptUnfinishedAttempts.name, databaseWriteHandler(operations.interruptUnfinishedAttempts, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).interruptUnfinishedAttempts(...input[0]))],
    [operations.claimReleasedTurn.name, databaseWriteHandler(operations.claimReleasedTurn, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).claimReleasedTurn(...input[0]))],
    [operations.markDispatched.name, databaseWriteHandler(operations.markDispatched, (input) => new WorkspaceEnvironmentAutomaticStore(db, () => input[1]).markDispatched(...input[0]))],
  ]);
}
