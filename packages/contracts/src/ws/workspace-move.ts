import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Request to convert the managed folder shared by a No project thread. */
export const CreateProjectFromFolderInputSchema = lazySchema(() => z.object({
  threadId: z.string(),
  name: z.string(),
  parentPath: z.string(),
  initGit: z.boolean(),
}));

/** Request to convert the managed folder shared by a No project thread. */
export type CreateProjectFromFolderInput = z.infer<ReturnType<typeof CreateProjectFromFolderInputSchema>>;

/** Result of validation and reservation, before touching the folder. */
export const CreateProjectFromFolderResultSchema = lazySchema(() => z.union([
  z.object({ operationId: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({
    status: z.literal("busy"),
    threadId: z.string(),
    reason: z.enum(["running", "needs-approval", "background"]),
  }),
]));

/** Result of validation and reservation, before touching the folder. */
export type CreateProjectFromFolderResult = z.infer<ReturnType<typeof CreateProjectFromFolderResultSchema>>;

/** Durable outcome of a same-drive project move. */
export const WorkspaceMoveResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), workspaceId: z.string() }),
  z.object({ status: z.literal("git-failed"), workspaceId: z.string(), error: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("rollback-pending"), error: z.string(), markerPath: z.string().nullable() }),
]));

/** Durable outcome of a same-drive project move. */
export type WorkspaceMoveResult = z.infer<ReturnType<typeof WorkspaceMoveResultSchema>>;

/** The committed checkpoints shared by status reads and progress pushes. */
export const WorkspaceMovePhaseSchema = lazySchema(() => z.enum(["intent", "renamed", "converted", "done"]));

/** The committed checkpoints shared by status reads and progress pushes. */
export type WorkspaceMovePhase = z.infer<ReturnType<typeof WorkspaceMovePhaseSchema>>;

/** A revision-ordered progress snapshot for one operation. */
export const WorkspaceMoveFrameSchema = lazySchema(() => z.object({
  operationId: z.string(),
  revision: z.number().int().nonnegative(),
  phase: WorkspaceMovePhaseSchema(),
  copiedBytes: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  result: WorkspaceMoveResultSchema().optional(),
}));

/** A revision-ordered progress snapshot for one operation. */
export type WorkspaceMoveFrame = z.infer<ReturnType<typeof WorkspaceMoveFrameSchema>>;

/** Find an operation directly or find an unfinished operation shared by a thread. */
export const WorkspaceMoveStatusInputSchema = lazySchema(() => z.union([
  z.strictObject({ operationId: z.string() }),
  z.strictObject({ threadId: z.string() }),
]));

/** Find an operation directly or find an unfinished operation shared by a thread. */
export type WorkspaceMoveStatusInput = z.infer<ReturnType<typeof WorkspaceMoveStatusInputSchema>>;

/** Outcome of retrying Git initialization on a converted project. */
export const WorkspaceMoveRetryGitResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), workspaceId: z.string() }),
  z.object({ status: z.literal("git-failed"), workspaceId: z.string(), error: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]));

/** Outcome of retrying Git initialization on a converted project. */
export type WorkspaceMoveRetryGitResult = z.infer<ReturnType<typeof WorkspaceMoveRetryGitResultSchema>>;
