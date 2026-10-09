import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";
import { pagedTargetResultSchema } from "./git.js";
import { PullRequestErrorSchema } from "./pull-requests.js";

/** PR metadata returned by the server. */
export const PrInfoSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
  }),
);
/** Basic PR metadata returned by the server. */
export type PrInfo = z.infer<ReturnType<typeof PrInfoSchema>>;

/** Open pull request available as a new-thread target. */
export const PullRequestTargetSchema = lazySchema(() => z.object({
  number: z.number().int().positive(),
  title: z.string().max(512),
  headRefName: z.string().min(1).max(255),
  author: z.string().max(100).nullable(),
  isCrossRepository: z.boolean(),
  url: z.string().url().max(2048),
}));
/** Pull request target row. */
export type PullRequestTarget = z.infer<ReturnType<typeof PullRequestTargetSchema>>;

/** Repository-scoped pull request target page input. */
export const PullRequestTargetsListParamsSchema = lazySchema(() => z.object({
  workspaceId: z.string().min(1).max(256),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(50).default(30),
}));
/** Caller input for a pull request target page. */
export type PullRequestTargetsListParams = z.input<ReturnType<typeof PullRequestTargetsListParamsSchema>>;

/** Pull request page with a GitHub total or a typed error. */
export const PullRequestTargetsListResultSchema = lazySchema(() => pagedTargetResultSchema(
  PullRequestTargetSchema(), PullRequestErrorSchema(),
));
/** Pull request target listing result. */
export type PullRequestTargetsListResult = z.infer<ReturnType<typeof PullRequestTargetsListResultSchema>>;

/** Detailed PR metadata for branch picker and URL detection. */
export const PrDetailSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    title: z.string(),
    branch: z.string(),
    author: z.string(),
    url: z.string(),
    state: z.string(),
  }),
);
/** Detailed PR metadata for branch picker and URL detection. */
export type PrDetail = z.infer<ReturnType<typeof PrDetailSchema>>;

/** Parameters for AI-generated PR draft. */
export const PrDraftSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    body: z.string(),
  }),
);

export type PrDraft = z.infer<ReturnType<typeof PrDraftSchema>>;

/** Parameters for creating a PR via the server. */
export const CreatePrParamsSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    threadId: z.string(),
    title: z.string(),
    body: z.string(),
    baseBranch: z.string(),
    isDraft: z.boolean().default(false),
  }),
);

export type CreatePrParams = z.infer<ReturnType<typeof CreatePrParamsSchema>>;

/** Result returned after PR creation. */
export const CreatePrResultSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    url: z.string(),
  }),
);

export type CreatePrResult = z.infer<ReturnType<typeof CreatePrResultSchema>>;

/** Individual CI check run (one job in a GitHub Actions workflow). */
export const CheckRunSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum(["success", "failure", "cancelled", "skipped", "timed_out", "neutral"])
      .nullable(),
    durationMs: z.number().nullable(),
    /** ISO timestamp when the run started. Populated for running and completed runs alike;
     *  used client-side to render live elapsed time for in-progress checks. */
    startedAt: z.string().nullable(),
  }),
);

/** Individual CI check run. */
export type CheckRun = z.infer<ReturnType<typeof CheckRunSchema>>;

/** Aggregate CI check status for a thread's PR. */
export const ChecksStatusSchema = lazySchema(() =>
  z.object({
    aggregate: z.enum(["passing", "failing", "pending", "no_checks"]),
    runs: z.array(CheckRunSchema()),
    fetchedAt: z.number(),
  }),
);

/** Aggregate CI check status for a thread's PR. */
export type ChecksStatus = z.infer<ReturnType<typeof ChecksStatusSchema>>;
