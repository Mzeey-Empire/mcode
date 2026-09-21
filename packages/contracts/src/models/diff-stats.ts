import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ReviewFileChangeTypeSchema } from "./review-comparison.js";

/** Per-file addition/deletion counts and change classification from git diff. */
export const DiffStatsSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changeType: ReviewFileChangeTypeSchema(),
  }),
);

/** Type inferred from DiffStatsSchema. */
export type DiffStats = z.infer<ReturnType<typeof DiffStatsSchema>>;
