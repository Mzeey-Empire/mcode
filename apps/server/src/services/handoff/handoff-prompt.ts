/**
 * Builds the side-channel prompt that the parent's provider session executes
 * to produce a handoff document. Vendors the /handoff skill instructions and
 * tailors them with fork context, mode (full/minimal), and a character budget
 * derived from the child provider's per-turn input cap.
 */

import type { ForkAnchorRole, HandoffMode } from "./handoff-types.js";

const MINIMAL_MODE_THRESHOLD_CHARS = 8_000;
const RESERVED_SYSTEM_PROMPT_CHARS = 1_000;
const RESERVED_USER_FIRST_MESSAGE_CHARS = 500;
const RESERVED_OVERHEAD_CHARS = 500;
const MIN_HANDOFF_BUDGET = 1_000;

/**
 * Pick mode based on child provider's per-turn cap. Minimal is triggered
 * when the cap is too tight to host the full structured doc.
 */
export function pickHandoffMode(childMaxInputCharacters: number): HandoffMode {
  return childMaxInputCharacters < MINIMAL_MODE_THRESHOLD_CHARS ? "minimal" : "full";
}

/** Character budget the handoff doc should target. */
export function computeBudgetChars(childMaxInputCharacters: number): number {
  const budget =
    childMaxInputCharacters -
    RESERVED_SYSTEM_PROMPT_CHARS -
    RESERVED_USER_FIRST_MESSAGE_CHARS -
    RESERVED_OVERHEAD_CHARS;
  return Math.max(budget, MIN_HANDOFF_BUDGET);
}

export interface HandoffPromptInput {
  mode: HandoffMode;
  forkAnchorRole: ForkAnchorRole;
  parentThreadTitle: string;
  forkMessageExcerpt: string;
  childProviderId: string;
  childMaxInputCharacters: number;
  handoffDocAbsolutePath: string;
}

const SECTIONS_FULL = [
  "## Goal, one sentence: what was the parent thread trying to accomplish",
  "## At fork, 2-4 sentences: what was happening when the user branched, including the immediate context of the forked message",
  "## Open items, up to 5 short bullets: unfinished work, relevant file paths, blockers, open questions",
  "## Decisions made, table of (Decision | Rationale) for non-obvious choices made in this thread",
  "## Files in play, bullets of `path/to/file` with a one-line relevance note",
  "## Suggested next steps, numbered list, ordered by what the next agent should do first",
  "## Suggested skills, bullets of `skill-name` with when to invoke. Required by the /handoff skill spec",
  "## Attachments, bullets of `attachments/<id>.<ext>` referencing what the original user shared. Only include if attachments exist",
];

const SECTIONS_MINIMAL = [
  "## Goal, one sentence: parent thread's purpose",
  "## At fork, 2-3 sentences: state at the branch point",
  "## Open items, up to 5 short bullets: unfinished work and relevant file paths",
];

/**
 * Builds the prompt sent to the parent's provider session to produce the
 * handoff doc. The prompt instructs the provider to WRITE the result to the
 * given absolute path using its file-write tool. The pipeline then reads it back.
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const { mode, forkAnchorRole, parentThreadTitle, forkMessageExcerpt, childProviderId, handoffDocAbsolutePath } = input;
  const budget = computeBudgetChars(input.childMaxInputCharacters);

  const forkFraming =
    forkAnchorRole === "user"
      ? "The user is forking to RETRY this question, or to explore a different response to the same input. The next agent should be prepared to answer the same user question afresh."
      : "The user is forking to CONTINUE the conversation in a new direction. A follow-up that diverges from where this thread actually went next. The next agent should be ready to pick up the thread.";

  const sections = mode === "full" ? SECTIONS_FULL : SECTIONS_MINIMAL;

  return [
    "You are producing a handoff document for a fresh agent that will continue work from this conversation in a new branched thread.",
    "",
    "## Context",
    `- Parent thread title: ${parentThreadTitle}`,
    `- Fork point (last included message excerpt): ${forkMessageExcerpt.slice(0, 400)}`,
    `- ${forkFraming}`,
    `- Next agent's provider: ${childProviderId}`,
    "",
    "## Constraints",
    `- Target output: less than or equal to ${budget} characters (string.length units, by character count not word count).`,
    `- Output mode: ${mode}.`,
    "- Do NOT duplicate content captured elsewhere (PRDs, plans, ADRs, issues, commits). Reference by path or URL.",
    "- Redact any API keys, passwords, or personally identifiable information.",
    "",
    "## Required sections (in this order)",
    ...sections,
    "",
    "## Output instructions",
    "Write the complete handoff document to the absolute path:",
    `  ${handoffDocAbsolutePath}`,
    "",
    "Begin the file with YAML frontmatter the pipeline will substitute later. You write only the markdown body with the sections above. Confirm the write succeeded before responding.",
  ].join("\n");
}
