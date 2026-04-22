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
  }),
);
/** Workspace record from the database. */
export type Workspace = z.infer<ReturnType<typeof WorkspaceSchema>>;
