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

/**
 * Truncates markdown at the last complete H2 (`## `) section boundary at or
 * before maxChars. Falls back to a hard slice when no usable H2 exists past
 * the halfway point, to avoid returning an empty or near-empty document.
 */
export function truncateAtSectionBoundary(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const slice = md.slice(0, maxChars);
  const lastH2 = slice.lastIndexOf("\n## ");
  return lastH2 > maxChars * 0.5 ? slice.slice(0, lastH2) : slice;
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
  /**
   * The user's new follow-up message in the fork composer. Passed to the
   * side-channel so the prompt can tell the model what the child agent is
   * about to be asked, enabling targeted context preservation.
   */
  userFollowUpMessage: string;
}

/**
 * Builds the prompt sent to the parent's provider session to produce the
 * handoff doc. The provider RETURNS the markdown as its assistant text; mcode
 * writes the file itself via HandoffStorage.write(). The side-channel call
 * passes `tools: []`, so the model must not be asked to write files.
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const { mode, forkAnchorRole, parentThreadTitle, forkMessageExcerpt, childProviderId, userFollowUpMessage } = input;
  const budget = computeBudgetChars(input.childMaxInputCharacters);

  const anchorFraming =
    forkAnchorRole === "user"
      ? "The user is forking from their own message. They want to retry this question, potentially with different framing or to a different provider."
      : "The user is forking from the assistant's reply. They are asking a follow-up about what the assistant just said.";

  // The "argument" the /handoff skill is designed to receive: what the next
  // session will focus on. When the user has typed a follow-up message in the
  // fork composer, that's the argument. When they haven't, we tell the skill
  // explicitly so it knows to hand off the full context.
  const argumentBlock = userFollowUpMessage.trim().length > 0
    ? `The user's follow-up message in the new branched thread (treat this as the skill's "arguments", the description of what the next session will focus on): "${userFollowUpMessage.slice(0, 800)}"`
    : "The user has not provided a follow-up message yet (no skill arguments). Hand off the full context up to the fork point so the next agent is prepared for any direction the user takes.";

  return [
    "You are executing the /handoff skill on the conversation up to the fork point. Below are the skill's instructions verbatim, followed by mcode-specific context.",
    "",
    "## /handoff skill instructions",
    "",
    "Write a handoff document summarising the current conversation so a fresh agent can continue the work.",
    "",
    `Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.`,
    "",
    "Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.",
    "",
    "Redact any sensitive information, such as API keys, passwords, or personally identifiable information.",
    "",
    "If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.",
    "",
    "## Context for this handoff",
    `- Parent thread title: ${parentThreadTitle}`,
    `- Fork anchor (${forkAnchorRole} message): ${forkMessageExcerpt.slice(0, 600)}`,
    `- ${anchorFraming}`,
    `- Next agent's provider: ${childProviderId}`,
    "",
    "## Arguments",
    argumentBlock,
    "",
    "## Output constraints (mcode-specific)",
    `- Target output: less than or equal to ${budget} characters (string.length, by character count not word count).`,
    `- Output mode: ${mode}${mode === "minimal" ? " (the next provider has a small per-turn input window, so be concise but preserve the concrete facts that matter for the follow-up)" : ""}.`,
    "- Return the complete handoff document as your assistant text response.",
    "- Do NOT call any tools. Do NOT write to disk. mcode handles persistence; if your output exceeds the budget, mcode automatically overflows the full doc to the user's OS temp dir.",
    "- Do NOT include YAML frontmatter (the pipeline injects that).",
    "- Begin your response directly with the document's first heading.",
  ].join("\n");
}
