/** Prompt and response parsing for generated commit messages. */
import { z } from "zod";
import { truncateUnifiedDiff } from "@mcode/shared";

/** Longest subject Mcode accepts from the model. */
export const COMMIT_SUBJECT_MAX_LENGTH = 72;
const MAX_PATCH_LINES = 1_500;

/** What the model sees about the selected paths and the repository's style. */
export interface CommitMessagePromptInput {
  stat: string;
  patch: string;
  recentSubjects: readonly string[];
}

/** Build the one-shot prompt. The stat lists every selected path even when the patch is truncated. */
export function buildCommitMessagePrompt(input: CommitMessagePromptInput): string {
  const style = input.recentSubjects.length > 0
    ? input.recentSubjects.map((subject) => `- ${subject}`).join("\n")
    : "(no earlier commits)";
  return [
    "Write a git commit message for the change below.",
    `Respond with only a JSON object {"subject": string, "body": string}.`,
    `The subject is one line of at most ${COMMIT_SUBJECT_MAX_LENGTH} characters in the imperative mood.`,
    "The body explains why the change was made, wrapped at 72 columns. Use an empty string when the subject is enough.",
    "Match the style of the repository's recent subjects:",
    style,
    "",
    "Files changed:",
    input.stat,
    "",
    "Diff:",
    truncateUnifiedDiff(input.patch, MAX_PATCH_LINES),
  ].join("\n");
}

const CommitMessageResponseSchema = z.object({
  subject: z.string().trim().min(1).max(COMMIT_SUBJECT_MAX_LENGTH).refine((subject) => !subject.includes("\n")),
  body: z.string().transform((body) => body.trim()),
});

/** A parsed commit message. */
export type GeneratedCommitMessage = z.infer<typeof CommitMessageResponseSchema>;

/** Parse the first JSON object in a model response. Returns null when it is not a usable message. */
export function parseCommitMessageResponse(text: string): GeneratedCommitMessage | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = CommitMessageResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
