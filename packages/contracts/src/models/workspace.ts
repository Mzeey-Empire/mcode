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
  }),
);
/** Workspace record from the database. */
export type Workspace = z.infer<ReturnType<typeof WorkspaceSchema>>;
