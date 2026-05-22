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

const SECTIONS_FULL = [
  "## Parent message — quote VERBATIM the message being forked from. Do not summarize. Do not paraphrase. Copy the exact text.",
  "## Key facts established — bullets of CONCRETE facts the parent thread settled. Lists with names. Values with definitions. Decisions with rationale. The next agent should be able to answer follow-up questions from this section alone, WITHOUT re-searching the filesystem. If the parent thread enumerated things (e.g. 'the three pillars are X, Y, Z'), list X Y Z here verbatim — not 'the parent enumerated three pillars'.",
  "## Recent context — the last 3-5 turns leading up to the fork point. Quote turns when short. Compress to bullets only when individual turns are very long.",
  "## Open items — unfinished work, blockers, open questions",
  "## Files in play — bullets of `path/to/file` with a one-line relevance note",
  "## Suggested next steps — numbered list, ordered by what the next agent should do first to answer the user's follow-up",
  "## Suggested skills — bullets of `skill-name` with when to invoke. Required by the /handoff skill spec",
  "## Attachments — bullets of `attachments/<id>.<ext>` referencing what the original user shared. Only include if attachments exist",
];

const SECTIONS_MINIMAL = [
  "## Parent message — quote VERBATIM the message being forked from",
  "## Key facts established — concrete facts the parent established (lists, names, decisions). Verbatim wherever possible.",
  "## Recent context — last 2-3 turns, quoted when short",
  "## Open items — unfinished work and blockers",
];

/**
 * Builds the prompt sent to the parent's provider session to produce the
 * handoff doc. The provider RETURNS the markdown as its assistant text; mcode
 * writes the file itself via HandoffStorage.write(). The previous design
 * instructed the model to write the file directly, which failed in
 * production because the side-channel call passes `tools: []` and the model
 * was hitting max_turns trying to invoke a Write tool it never had.
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const { mode, forkAnchorRole, parentThreadTitle, forkMessageExcerpt, childProviderId, userFollowUpMessage } = input;
  const budget = computeBudgetChars(input.childMaxInputCharacters);

  // Strong anchor-role-specific framing. Tell the model precisely what
  // kind of follow-up the next agent will receive.
  const forkFraming =
    forkAnchorRole === "user"
      ? [
          "The user is forking from THEIR OWN message — they want to retry the question, potentially with a different provider or different framing.",
          "Preserve the user's question and any prior context the assistant established that bears on answering it.",
          "The next agent will receive the user's question (possibly edited) as its first turn. Prepare it to answer afresh, well-grounded by the prior context.",
        ].join(" ")
      : [
          "The user is forking from the ASSISTANT'S message — they are asking a follow-up about what the assistant just said.",
          "Preserve the assistant's last reply in full as part of Key facts. Quote it directly.",
          "The user's follow-up is likely a clarifying question, a deeper-dive request, or a 'tell me more about X' where X came from the assistant's reply.",
          "Prepare the next agent to answer questions ABOUT the assistant's reply specifically.",
        ].join(" ");

  const sections = mode === "full" ? SECTIONS_FULL : SECTIONS_MINIMAL;

  return [
    "You are producing a handoff document for a fresh agent that will continue from this conversation in a new branched thread.",
    "Your output IS the handoff doc — return it as your assistant text response. Do NOT call any tools. Do NOT write to disk.",
    "",
    "## Context for this handoff",
    `- Parent thread title: ${parentThreadTitle}`,
    `- Fork anchor message (${forkAnchorRole}): ${forkMessageExcerpt.slice(0, 600)}`,
    `- Fork framing: ${forkFraming}`,
    `- Next agent's provider: ${childProviderId}`,
    `- User's follow-up message in the new branched thread (this is what the next agent will be asked next): ${userFollowUpMessage.slice(0, 800)}`,
    "",
    "## Your task",
    "Produce a markdown handoff doc with these sections IN THIS ORDER. Prioritize CONTENT over abstract summary. If the parent thread named things, name them. If it listed items, list them. The next agent should be able to answer the user's follow-up using ONLY this doc plus its own reasoning — without re-searching the filesystem.",
    "",
    "## Constraints",
    `- Target output: less than or equal to ${budget} characters.`,
    `- Output mode: ${mode}.`,
    "- If you cannot fit everything within budget, prioritize the first three sections (Parent message, Key facts, Recent context). Truncate ancillary sections (file lists, skill bullets, attachments) last.",
    "- Do NOT duplicate content captured elsewhere (PRDs, plans, ADRs, issues, commits). Reference by path or URL.",
    "- Redact any API keys, passwords, or personally identifiable information.",
    "",
    "## Required sections (in this order)",
    ...sections,
    "",
    "## Output instructions",
    "Return the complete handoff document as your assistant response, in markdown, with the sections above as ## headings. Do NOT call any tools. Do NOT write to disk. Do NOT include YAML frontmatter (the pipeline injects that). Begin your response directly with the first section heading.",
  ].join("\n");
}
