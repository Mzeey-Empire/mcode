/** Readers for the error a rejected `GitExecutor.exec` call carries. */
import { z } from "zod";

const GitFailureSchema = z.object({
  code: z.union([z.number(), z.string()]).nullish(),
  killed: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

function readFailure(error: unknown): z.infer<typeof GitFailureSchema> {
  const parsed = GitFailureSchema.safeParse(error);
  return parsed.success ? parsed.data : {};
}

/** Exit code of a git child that ran and failed; null when git never ran or was killed. */
export function gitExitCode(error: unknown): number | null {
  const { code } = readFailure(error);
  return typeof code === "number" ? code : null;
}

/** True when the executor killed git at its timeout. */
export function gitWasKilled(error: unknown): boolean {
  return readFailure(error).killed === true;
}

/** Everything git printed before it failed, stdout first, for classification and display. */
export function gitFailureOutput(error: unknown): string {
  const { stdout, stderr } = readFailure(error);
  const parts = [stdout, stderr].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  if (parts.length > 0) return parts.join("\n").trim();
  return error instanceof Error ? error.message : String(error);
}
