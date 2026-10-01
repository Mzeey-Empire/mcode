import { z } from "zod";
import {
  ContextWindowModeSchema, InteractionModeSchema, PermissionModeSchema, ProviderIdSchema,
  PullRequestIdentitySchema, PullRequestReviewLinkSchema, ReasoningLevelSchema, ThreadSchema,
} from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const identity = z.object({ provider: z.string(), repositoryNodeId: z.string(), pullRequestNumber: z.number().int().positive() }).strict();
const checkout = z.object({
  pullRequestUrl: z.string().url(), pullRequestState: z.string(), workspaceId: z.string(), worktreePath: z.string(), worktreeManaged: z.boolean(),
  headRepositoryNodeId: z.string(), headRepositoryOwner: z.string(), headRepositoryName: z.string(), headRef: z.string(), headOid: z.string(),
  localBranch: z.string(), pushRemote: z.string(), pushRef: z.string(), managedRemoteName: z.string().nullable().optional(),
}).strict();
const createLink = checkout.merge(identity).extend({ worktreeId: z.string(), primaryThreadId: z.string().nullable().optional() }).strict();
const storedLink = createLink.extend({ managedRemoteName: z.string().nullable(), primaryThreadId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });

/** Data required to commit a provisioned Review task without crossing a Git callback into SQLite. */
export const createReviewTaskInputSchema = z.object({
  identity: PullRequestIdentitySchema(), title: z.string(), baseBranch: z.string(), checkout,
  defaults: z.object({
    provider: ProviderIdSchema, model: z.string(), reasoning: ReasoningLevelSchema,
    interactionMode: InteractionModeSchema, permission: PermissionModeSchema,
    contextWindow: ContextWindowModeSchema, thinking: z.boolean(),
  }).strict(),
}).strict();

/** Committed and validated thread configuration plus its canonical Review linkage. */
export const reviewTaskCommitSchema = z.object({ thread: ThreadSchema(), link: PullRequestReviewLinkSchema() }).strict();
export type CreateReviewTaskInput = z.infer<typeof createReviewTaskInputSchema>;
export type ReviewTaskCommit = z.infer<typeof reviewTaskCommitSchema>;

/** Ordinary Review writes and the complete review-task transaction admitted to the shared owner. */
export const reviewWriteOperations = {
  insert: databaseWriteOperation("reviewLink.insert", z.tuple([createLink]), storedLink),
  replaceLocalCheckout: databaseWriteOperation("reviewLink.replaceLocalCheckout", z.tuple([identity, checkout]), storedLink.nullable()),
  updateRemoteState: databaseWriteOperation("reviewLink.updateRemoteState", z.tuple([identity, z.object({ pullRequestUrl: z.string().url(), pullRequestState: z.string(), headOid: z.string().optional() }).strict()]), storedLink.nullable()),
  updatePrimaryThread: databaseWriteOperation("reviewLink.updatePrimaryThread", z.tuple([identity, z.string().nullable()]), storedLink.nullable()),
  clearPrimaryThreadByThreadId: databaseWriteOperation("reviewLink.clearPrimaryThreadByThreadId", z.tuple([z.string()]), z.boolean()),
  persistReviewTask: databaseWriteOperation("reviewLink.persistReviewTask", z.tuple([createReviewTaskInputSchema]), reviewTaskCommitSchema),
};
