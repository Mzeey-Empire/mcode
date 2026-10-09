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
