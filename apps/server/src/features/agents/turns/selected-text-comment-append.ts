import {
  SelectedTextCommentsSchema,
  type SelectedTextComment,
  PlanCommentSchema,
  type PlanComment,
} from "@mcode/contracts";

/** Opens the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_OPEN = "<!-- mcode-selected-text-comments-v1 -->";

/** Closes the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_CLOSE = "<!-- /mcode-selected-text-comments-v1 -->";

/** Opens committed plan-comment data appended to a revision prompt. */
export const MCODE_PLAN_COMMENTS_FENCE_OPEN = "<!-- mcode-plan-comments-v1 -->";
/** Closes committed plan-comment data. */
export const MCODE_PLAN_COMMENTS_FENCE_CLOSE = "<!-- /mcode-plan-comments-v1 -->";

/** Append saved notes with the same delimiter escaping as selected-text comments. */
export function appendPlanComments(content: string, planComments: readonly PlanComment[]): string {
  if (planComments.length === 0) return content;
  const comments = PlanCommentSchema().array().max(128).parse(planComments);
  return appendCommentEnvelope(content, comments, MCODE_PLAN_COMMENTS_FENCE_OPEN, MCODE_PLAN_COMMENTS_FENCE_CLOSE);
}

/**
 * Appends selected-text comments as schema-validated JSON data for a provider.
 *
 * Quotes and notes are user data. Escaping markup delimiters prevents either
 * field from closing the envelope or taking a structural role in the prompt.
 */
export function appendSelectedTextComments(
  content: string,
  selectedTextComments: readonly SelectedTextComment[] | undefined,
): string {
  if (!selectedTextComments || selectedTextComments.length === 0) return content;
  const comments = SelectedTextCommentsSchema().parse(selectedTextComments);
  return appendCommentEnvelope(content, comments, MCODE_SELECTED_TEXT_COMMENTS_FENCE_OPEN, MCODE_SELECTED_TEXT_COMMENTS_FENCE_CLOSE);
}

function appendCommentEnvelope(content: string, comments: readonly unknown[], open: string, close: string): string {
  const payload = escapeEnvelopeDelimiters(JSON.stringify({ schemaVersion: 1, comments }));
  const prefix = content.length === 0 ? "" : `${content}\n\n`;
  return `${prefix}${open}\n${payload}\n${close}`;
}

function escapeEnvelopeDelimiters(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
