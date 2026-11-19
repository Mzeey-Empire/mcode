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

/**
 * The line of a failed push's output that says why it failed. Git wraps the reason in `To <remote>`,
 * hint, and summary lines, so prefer a remote hook's message, then the rejected ref, then git's own error.
 */
export function gitPushFailureReason(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const remote = lines.find((line) => line.startsWith("remote:") && line.length > "remote:".length);
  if (remote) return remote.slice("remote:".length).trim();
  return lines.find((line) => line.startsWith("! ["))
    ?? lines.find((line) => /^(fatal|error):/.test(line))
    ?? lines[0]
    ?? "Push failed";
}

/** Everything git printed before it failed, stdout first, for classification and display. */
export function gitFailureOutput(error: unknown): string {
  const { stdout, stderr } = readFailure(error);
  const parts = [stdout, stderr].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  if (parts.length > 0) return parts.join("\n").trim();
  return error instanceof Error ? error.message : String(error);
}
