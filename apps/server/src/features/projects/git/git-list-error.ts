import { z } from "zod";
import type { GitListError } from "@mcode/contracts";

/** Fields git command failures carry, read loosely because callers receive them as `unknown`. */
export const gitCommandFailureSchema = z.object({
  stderr: z.string().optional(), message: z.string().optional(),
  killed: z.boolean().optional(), code: z.union([z.string(), z.number()]).nullish(),
});

/**
 * Classify failures shared by ref and commit picker listings. Lives outside `GitRepositoryService` so transport
 * code can import it without loading tsyringe decorators, which need the reflect polyfill first.
 */
export function gitListError(error: unknown): GitListError {
  const parsed = gitCommandFailureSchema.safeParse(error);
  const failure = parsed.success ? parsed.data : {};
  const detail = (failure.stderr || failure.message || String(error)).split(/\r?\n/)[0]?.slice(0, 2000);
  if (failure.killed || failure.code === "ETIMEDOUT") {
    return { code: "timed_out", message: "Git target listing timed out.", detail };
  }
  return {
    code: /not a git repository/i.test(failure.stderr ?? "") ? "not_a_repository" : "git_failed",
    message: "Could not list Git targets.", detail,
  };
}
