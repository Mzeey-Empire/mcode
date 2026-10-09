import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Git branch metadata. */
export const GitBranchSchema = lazySchema(() => z.object({
  name: z.string(),
  shortSha: z.string(),
  type: z.enum(["local", "remote", "worktree"]),
  isCurrent: z.boolean(),
}));
/** Git branch metadata record. */
export type GitBranch = z.infer<ReturnType<typeof GitBranchSchema>>;

/**
 * A git ref string safe to interpolate into a git argv. Rejects a leading `-`
 * (which git would parse as a flag — argument injection) and restricts to the
 * characters git refnames and short SHAs actually use. Used to validate the
 * user-picked base/target of a Branch comparison before they reach `git diff`.
 */
export const GitRefNameSchema = z
  .string()
  .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid git ref");

/**
 * A user-supplied branch name safe for creating a new branch. This is stricter
 * than a generic ref because it rejects reserved names and traversal-like
 * sequences before they cross into a mutating git command.
 */
export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(250)
  .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid git branch name")
  .refine((name) => !name.includes(".."), "invalid git branch name")
  .refine((name) => name !== "HEAD", "invalid git branch name");

/** A checkout location shown on a target row. */
export const TargetWorktreeSchema = lazySchema(() => z.object({
  path: z.string().min(1).max(4096),
  folder: z.string().min(1).max(255),
}));
/** Checkout location associated with a target. */
export type TargetWorktree = z.infer<ReturnType<typeof TargetWorktreeSchema>>;

/** One qualified ref, with an optional origin twin grouped for new threads. */
export const GitRefSchema = lazySchema(() => z.object({
  kind: z.literal("ref"),
  fullName: z.string().min(1).max(512),
  shortName: z.string().min(1).max(512),
  branchName: GitBranchNameSchema,
  remote: z.string().min(1).max(100).nullable(),
  twin: z.string().min(1).max(512).nullable(),
  isCurrent: z.boolean(),
  isDefault: z.boolean(),
  worktree: TargetWorktreeSchema().nullable(),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  committedAt: z.string().datetime(),
}).strict());
/** Qualified branch picker row. */
export type GitRef = z.infer<ReturnType<typeof GitRefSchema>>;

/** A linked checkout with a detached HEAD. */
export const DetachedWorktreeTargetSchema = lazySchema(() => z.object({
  kind: z.literal("detached-worktree"),
  worktree: TargetWorktreeSchema(),
  headShortSha: z.string().regex(/^[0-9a-f]{7,40}$/),
}).strict());
/** Detached checkout picker row. */
export type DetachedWorktreeTarget = z.infer<ReturnType<typeof DetachedWorktreeTargetSchema>>;

/** Server-side target selection policy. */
export const GitRefPurposeSchema = lazySchema(() => z.enum(["new-thread", "existing-worktree", "review"]));
/** Target selection policy. */
export type GitRefPurpose = z.infer<ReturnType<typeof GitRefPurposeSchema>>;
/** Review tab selecting local or remote-tracking refs. */
export const GitRefSideSchema = lazySchema(() => z.enum(["local", "origin"]));
/** Review target side. */
export type GitRefSide = z.infer<ReturnType<typeof GitRefSideSchema>>;

/** Shared bounded result envelope for paged picker lists. */
export function pagedTargetResultSchema<T extends z.ZodTypeAny, E extends z.ZodTypeAny>(item: T, error: E) {
  return lazySchema(() => z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      items: z.array(item).max(100),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().min(1).max(512).nullable(),
    }),
    z.object({ ok: z.literal(false), error }),
  ]))();
}

/** Git listing failure with a bounded first stderr line. */
export const GitListErrorSchema = lazySchema(() => z.object({
  code: z.enum(["not_a_repository", "git_failed", "timed_out"]),
  message: z.string().min(1).max(512),
  detail: z.string().max(2000).optional(),
}));
/** Git target listing failure. */
export type GitListError = z.infer<ReturnType<typeof GitListErrorSchema>>;

/** Listing input: only Review accepts and requires a side. */
export const GitRefsListParamsSchema = lazySchema(() => {
  const common = {
    workspaceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).optional(),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  };
  return z.discriminatedUnion("purpose", [
    z.object({ ...common, purpose: GitRefPurposeSchema().extract(["review"]), side: GitRefSideSchema() }),
    z.object({ ...common, purpose: GitRefPurposeSchema().extract(["new-thread", "existing-worktree"]), side: z.never().optional() }),
  ]);
});
/** Caller input for a qualified-ref page. */
export type GitRefsListParams = z.input<ReturnType<typeof GitRefsListParamsSchema>>;

/** Qualified refs and detached checkouts share one paged result. */
export const GitRefsListResultSchema = lazySchema(() => pagedTargetResultSchema(
  z.discriminatedUnion("kind", [GitRefSchema(), DetachedWorktreeTargetSchema()]),
  GitListErrorSchema(),
));
/** Result of a qualified-ref listing. */
export type GitRefsListResult = z.infer<ReturnType<typeof GitRefsListResultSchema>>;

/** Remote repository metadata resolved from a checkout's origin remote. */
export const GitRemoteUrlSchema = lazySchema(() => z.object({
  /** Normalized https web URL, or null when no usable remote exists. */
  webUrl: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "webUrl must be an https URL",
  }).nullable(),
  /** Repository label shown in the UI, usually "org/repo". */
  label: z.string().min(1),
}));
/** Remote repository metadata resolved from git config. */
export type GitRemoteUrl = z.infer<ReturnType<typeof GitRemoteUrlSchema>>;

/**
 * A resolved Branch comparison: the base→target ref pair the Review tab's Branch
 * view diffs (always three-dot, `base...target`), plus the refs available to
 * populate the pickers. The default pair is resolved per
 * `docs/adr/0007-branch-comparison-default-and-range.md` before the diff call.
 * `base`/`target` are null only when no comparison can be formed (unborn branch,
 * or no base could be detected and the user must pick one).
 */
export const BranchComparisonSchema = lazySchema(() => z.object({
  /** Base ref (the "from" side); null when unresolved (unborn / no base). */
  base: z.string().nullable(),
  /** Target ref (the "to" side); null when unresolved (unborn / no base). */
  target: z.string().nullable(),
  /** Refs available to populate the base/target pickers (local, remote, worktree). */
  refs: z.array(GitBranchSchema()),
  /** True when HEAD has no commits yet — the diff is an explicit empty state. */
  isUnborn: z.boolean(),
  /**
   * False when no meaningful Branch comparison exists (local-only default branch
   * with no upstream). The Branch view is disabled until git state changes.
   */
  isComparisonAvailable: z.boolean(),
}));
/** Resolved Branch comparison record. */
export type BranchComparison = z.infer<ReturnType<typeof BranchComparisonSchema>>;

/** A git worktree registered in the repository. */
export const WorktreeSchema = lazySchema(() => z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  managed: z.boolean(),
}));
/** Worktree metadata registered in the repository. */
export type WorktreeInfo = z.infer<ReturnType<typeof WorktreeSchema>>;

export { GitCommitSchema, type GitCommit } from "./models/git-commit.js";
