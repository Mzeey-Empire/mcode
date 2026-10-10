import { z } from "zod";
import { ProviderIdSchema } from "./models/settings.js";
import { lazySchema } from "./utils/lazySchema.js";

/** Upper bound on paths in one commit or message request, matching Review's untracked cap. */
export const GIT_COMMIT_MAX_PATHS = 10_000;
/** Upper bound on a commit message after trimming. */
export const GIT_COMMIT_MAX_MESSAGE_LENGTH = 65_536;

const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const GitCommitPathSchema = z.string().min(1).max(4096);

/** Input for generating a commit message from the selected Review paths. */
export const GitGenerateCommitMessageParamsSchema = lazySchema(() => z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  paths: z.array(GitCommitPathSchema).min(1).max(GIT_COMMIT_MAX_PATHS),
}));
/** Caller input for commit message generation. */
export type GitGenerateCommitMessageParams = z.input<ReturnType<typeof GitGenerateCommitMessageParamsSchema>>;

/** Generated subject and body, or why no message was produced. No fallback text is ever returned. */
export const GitGenerateCommitMessageResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    subject: z.string(),
    body: z.string(),
    model: z.object({ provider: ProviderIdSchema, id: z.string(), name: z.string() }),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.enum(["provider-unavailable", "timeout", "unparseable", "empty-diff"]),
    message: z.string(),
  }),
]));
/** Commit message generation outcome. */
export type GitGenerateCommitMessageResult = z.infer<ReturnType<typeof GitGenerateCommitMessageResultSchema>>;

/** One selected file. Renames carry both sides so the old path's deletion is committed too. */
export const GitCommitFileSchema = lazySchema(() => z.object({
  path: GitCommitPathSchema,
  previousPath: GitCommitPathSchema.nullable(),
}));
/** One file selected for a commit. */
export type GitCommitFile = z.infer<ReturnType<typeof GitCommitFileSchema>>;

/** Input for one durable commit request. */
export const GitCommitParamsSchema = lazySchema(() => z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  /** One per click. Replaying it with the same inputs returns the stored outcome instead of committing twice. */
  requestId: z.string().uuid(),
  /** HEAD the sheet built its list from; null means unborn. A precondition, not idempotency. */
  expectedHead: GitObjectIdSchema.nullable(),
  files: z.array(GitCommitFileSchema()).min(1).max(GIT_COMMIT_MAX_PATHS),
  message: z.string().trim().min(1).max(GIT_COMMIT_MAX_MESSAGE_LENGTH),
  push: z.boolean(),
}));
/** Caller input for a commit request. */
export type GitCommitParams = z.input<ReturnType<typeof GitCommitParamsSchema>>;

/** Push outcome reported separately from the commit, because a failed push never undoes it. */
export const GitCommitPushOutcomeSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("skipped") }),
  /** The push has not finished; replaying the same requestId returns its outcome. */
  z.object({ status: z.literal("pending") }),
  /** Destination as "<remote> <ref>", for example "origin refs/heads/mcode-3f2a". */
  z.object({ status: z.literal("pushed"), destination: z.string() }),
  z.object({ status: z.literal("failed"), summary: z.string(), detail: z.string() }),
]));
/** Push outcome of a committed request. */
export type GitCommitPushOutcome = z.infer<ReturnType<typeof GitCommitPushOutcomeSchema>>;

/** Why a commit request committed nothing. */
export const GitCommitRejectionSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nothing-to-commit") }),
  /** The caller's expectedHead is stale. */
  z.object({ kind: z.literal("head-moved"), head: z.string().nullable() }),
  /** Push was requested on a branchless or detached checkout. */
  z.object({ kind: z.literal("no-branch") }),
  z.object({ kind: z.literal("identity-missing"), detail: z.string() }),
  /** Unmerged paths. */
  z.object({ kind: z.literal("conflicts"), detail: z.string() }),
  z.object({ kind: z.literal("index-locked"), detail: z.string() }),
  /** Hooks, signing, and anything else. Full git output is in detail. */
  z.object({ kind: z.literal("failed"), summary: z.string(), detail: z.string() }),
]));
/** Reason a commit request committed nothing. */
export type GitCommitRejection = z.infer<ReturnType<typeof GitCommitRejectionSchema>>;

/** Outcome of one commit request. */
export const GitCommitResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("committed"),
    sha: GitObjectIdSchema,
    shortSha: z.string(),
    branch: z.string().nullable(),
    push: GitCommitPushOutcomeSchema(),
  }),
  z.object({ status: z.literal("rejected"), reason: GitCommitRejectionSchema() }),
  /** Mcode cannot prove this request made a commit, so it is never pushed. */
  z.object({ status: z.literal("unknown"), head: z.string().nullable(), detail: z.string() }),
]));
/** Outcome of one commit request. */
export type GitCommitResult = z.infer<ReturnType<typeof GitCommitResultSchema>>;
