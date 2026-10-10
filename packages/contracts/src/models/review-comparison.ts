import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Change classification shown for one file in a Review comparison. */
export const ReviewFileChangeTypeSchema = lazySchema(() =>
  z.enum(["added", "modified", "deleted", "renamed", "copied"]),
);

/** Bounded file metadata returned with a Review comparison. */
export const ReviewFileChangeSchema = lazySchema(() =>
  z.object({
    path: z.string().min(1).max(4096),
    previousPath: z.string().min(1).max(4096).nullable(),
    changeType: ReviewFileChangeTypeSchema(),
    binary: z.boolean(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    untracked: z.boolean(),
  }),
);

/** One settled Review comparison shared by the diff and Files navigator. */
export const ReviewComparisonSchema = lazySchema(() =>
  z.object({
    files: z.array(ReviewFileChangeSchema()).max(10_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    turnDiff: z.object({
      id: z.string(),
      phase: z.enum(["live", "settled"]),
      source: z.enum(["native", "tracked", "git"]),
      fidelity: z.enum(["agent", "same-file-changes-possible"]),
      revision: z.number().int().nonnegative(),
    }).optional(),
  }),
);

/** Change classification shown for one file in a Review comparison. */
export type ReviewFileChange = z.infer<ReturnType<typeof ReviewFileChangeSchema>>;

/** One settled Review comparison shared by the diff and Files navigator. */
export type ReviewComparison = z.infer<ReturnType<typeof ReviewComparisonSchema>>;

/** Expected comparison limits and failures, shared by metadata and patch reads. */
export const ReviewComparisonUnavailableSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("too-many-files"), fileCount: z.number().int().nonnegative(), limit: z.literal(10_000) }),
  z.object({ status: z.literal("unavailable"), reason: z.enum(["unborn", "no-base", "snapshot-expired", "snapshot-pruned"]) }),
  z.object({ status: z.literal("failed"), failure: z.object({
    kind: z.enum(["timeout", "worktree-missing", "unsafe-ref", "git-error"]),
    summary: z.string(), detail: z.string(),
  }) }),
]));

/** Every comparison read distinguishes empty evidence from unavailable evidence. */
export const ReviewComparisonResultSchema = lazySchema(() => z.union([
  z.object({ status: z.literal("ready"), comparison: ReviewComparisonSchema() }),
  ReviewComparisonUnavailableSchema(),
]));

/** The outcome of reading comparison metadata. */
export type ReviewComparisonResult = z.infer<ReturnType<typeof ReviewComparisonResultSchema>>;

/** A patch or the reason its evidence could not be read. */
export const ReviewFileDiffResultSchema = lazySchema(() => z.union([z.string(), ReviewComparisonUnavailableSchema()]));

/** A patch or the reason its evidence could not be read. */
export type ReviewFileDiffResult = z.infer<ReturnType<typeof ReviewFileDiffResultSchema>>;

/** One logical turn, ordered independently of snapshot retention. */
export const ReviewTurnSchema = lazySchema(() => z.object({
  messageId: z.string(), ordinal: z.number().int().positive(), createdAt: z.string(),
  phase: z.enum(["live", "settled"]), fileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative().nullable(), deletions: z.number().int().nonnegative().nullable(),
  evidence: z.enum(["native", "tracked", "git"]).nullable(),
  availability: z.enum(["available", "snapshot-expired"]),
}));

/** One logical turn in the Review picker. */
export type ReviewTurn = z.infer<ReturnType<typeof ReviewTurnSchema>>;

/** Repository state used to choose and enable Review views. */
export const ReviewStateSchema = lazySchema(() => z.discriminatedUnion("isGitRepo", [
  z.object({ isGitRepo: z.literal(false) }),
  z.object({
    isGitRepo: z.literal(true),
    head: z.string().nullable(),
    branch: z.string().nullable(),
    uncommitted: z.object({
      staged: z.number().int().nonnegative(),
      unstaged: z.number().int().nonnegative(),
      untracked: z.number().int().nonnegative(),
    }),
    commitsAhead: z.object({ count: z.number().int().nonnegative(), base: z.string() }).nullable(),
    branchDefault: z.union([
      z.object({ compare: z.string(), base: z.string() }),
      z.object({ unavailable: z.enum(["unborn", "no-base"]) }),
    ]),
  }),
]));

/** Repository state used to choose and enable Review views. */
export type ReviewState = z.infer<ReturnType<typeof ReviewStateSchema>>;
