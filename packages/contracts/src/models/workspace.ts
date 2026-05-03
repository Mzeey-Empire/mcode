import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Workspace schema matching the SQLite row shape. */
export const WorkspaceSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    provider_config: z.record(z.unknown()),
    is_git_repo: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    /** Whether the workspace is pinned to the top of the project selector. */
    pinned: z.boolean(),
    /** Unix timestamp (ms) of when this workspace was last opened. Null if never explicitly opened. */
    last_opened_at: z.number().nullable(),
    /** Ascending sidebar order; lower values appear higher in the project list. */
    sort_order: z.number().int(),
  }),
);
/** Workspace record from the database. */
export type Workspace = z.infer<ReturnType<typeof WorkspaceSchema>>;

/** Git, cleanliness, and thread count enrichment for a workspace in the project selector. */
export const WorkspaceEnrichmentSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    /** Current git branch name, or null for non-git directories. */
    branch: z.string().nullable(),
    /** True if the workspace path is inside a git repository. */
    isGit: z.boolean(),
    /** True if the working tree has no uncommitted changes (or is non-git). */
    isClean: z.boolean(),
    /** Number of active (non-deleted) threads in this workspace. */
    threadCount: z.number(),
  }),
);
/** Enrichment data for a workspace returned by the workspace.enrich RPC. */
export type WorkspaceEnrichment = z.infer<ReturnType<typeof WorkspaceEnrichmentSchema>>;
