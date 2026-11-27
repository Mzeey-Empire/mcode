import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Request to convert the managed folder shared by a No project thread. */
export const CreateProjectFromFolderInputSchema = lazySchema(() => z.object({
  threadId: z.string(),
  name: z.string(),
  parentPath: z.string(),
  initGit: z.boolean(),
}));

export type CreateProjectFromFolderInput = z.infer<ReturnType<typeof CreateProjectFromFolderInputSchema>>;

/** Filesystem failure a client can explain without interpreting the raw error. */
export const WorkspaceMoveFailureCauseSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-space"), drive: z.string() }),
  z.object({ kind: z.literal("in-use") }),
  z.object({ kind: z.literal("permission") }),
  z.object({ kind: z.literal("other") }),
]));

export type WorkspaceMoveFailureCause = z.infer<ReturnType<typeof WorkspaceMoveFailureCauseSchema>>;

/** Result of validation and reservation, before touching the folder. */
export const CreateProjectFromFolderResultSchema = lazySchema(() => z.union([
  z.object({ operationId: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string(), cause: WorkspaceMoveFailureCauseSchema() }),
  z.object({
    status: z.literal("busy"),
    threadId: z.string(),
    reason: z.enum(["running", "needs-approval", "background"]),
  }),
]));

export type CreateProjectFromFolderResult = z.infer<ReturnType<typeof CreateProjectFromFolderResultSchema>>;

/** What remains at the destination or staging path after a cross-drive rollback. */
export const WorkspaceMoveCopyLeftoverSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("removed") }),
  z.object({ kind: z.literal("kept"), path: z.string() }),
  z.object({ kind: z.literal("foreign-staging"), path: z.string() }),
]));

/** The copy cleanup outcome reported after a cross-drive rollback. */
export type WorkspaceMoveCopyLeftover = z.infer<ReturnType<typeof WorkspaceMoveCopyLeftoverSchema>>;

/** Durable outcome of a project move. A same-drive failure has no partial copy. */
export const WorkspaceMoveResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), workspaceId: z.string() }),
  z.object({ status: z.literal("git-failed"), workspaceId: z.string(), error: z.string() }),
  z.object({
    status: z.literal("failed"), error: z.string(), cause: WorkspaceMoveFailureCauseSchema(),
    copy: WorkspaceMoveCopyLeftoverSchema().nullable(),
  }),
  z.object({
    status: z.literal("rollback-pending"), error: z.string(), cause: WorkspaceMoveFailureCauseSchema(),
    markerPath: z.string().nullable(), copyPath: z.string().nullable(),
  }),
]));

export type WorkspaceMoveResult = z.infer<ReturnType<typeof WorkspaceMoveResultSchema>>;

/** The committed checkpoints shared by status reads and progress pushes. */
export const WorkspaceMovePhaseSchema = lazySchema(() => z.enum([
  "intent", "renamed", "copying", "copied", "published", "converted", "done",
]));

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

export type WorkspaceMoveFrame = z.infer<ReturnType<typeof WorkspaceMoveFrameSchema>>;

/** Find an operation directly or find an unfinished operation shared by a thread. */
export const WorkspaceMoveStatusInputSchema = lazySchema(() => z.union([
  z.strictObject({ operationId: z.string() }),
  z.strictObject({ threadId: z.string() }),
]));

export type WorkspaceMoveStatusInput = z.infer<ReturnType<typeof WorkspaceMoveStatusInputSchema>>;

/** Outcome of retrying Git initialization on a converted project. */
export const WorkspaceMoveRetryGitResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), workspaceId: z.string() }),
  z.object({ status: z.literal("git-failed"), workspaceId: z.string(), error: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]));

export type WorkspaceMoveRetryGitResult = z.infer<ReturnType<typeof WorkspaceMoveRetryGitResultSchema>>;
