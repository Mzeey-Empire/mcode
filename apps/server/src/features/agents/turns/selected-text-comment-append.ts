import { SelectedTextCommentsSchema, type SelectedTextComment } from "@mcode/contracts/models/selected-text-comment";
import { PlanCommentSchema, type PlanComment, type PlanVersion } from "@mcode/contracts/models/plan";

/** Opens the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_OPEN = "<!-- mcode-selected-text-comments-v1 -->";

/** Closes the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_CLOSE = "<!-- /mcode-selected-text-comments-v1 -->";

/** Opens committed plan-comment data appended to a revision prompt. */
export const MCODE_PLAN_COMMENTS_FENCE_OPEN = "<!-- mcode-plan-comments-v2 -->";
/** Closes committed plan-comment data. */
export const MCODE_PLAN_COMMENTS_FENCE_CLOSE = "<!-- /mcode-plan-comments-v2 -->";

const PLAN_COMMENTS_PREFACE = "These are the user's comments on the plan, and each applies to the plan version in planVersion. The quote is the text as it read in that version, which may differ from latestPlanVersion.";

/** Append saved notes with the same delimiter escaping as selected-text comments. */
export function appendPlanComments(
  content: string,
  planComments: readonly PlanComment[],
  versions: readonly Pick<PlanVersion, "id" | "version">[],
): string {
  if (planComments.length === 0) return content;
  const comments = PlanCommentSchema().array().max(128).parse(planComments).map(comment => {
    const version = versions.find(version => version.id === comment.versionId);
    if (!version) throw new Error("Plan comment version is missing");
    return { planVersion: version.version, section: comment.anchor.section, quote: comment.anchor.quote, note: comment.body };
  });
  const latestPlanVersion = versions.reduce((latest, version) => Math.max(latest, version.version), 0);
  const payload = escapeEnvelopeDelimiters(JSON.stringify({ schemaVersion: 2, latestPlanVersion, comments }));
  const prefix = content.length === 0 ? "" : `${content}\n\n`;
  return `${prefix}${PLAN_COMMENTS_PREFACE}\n${MCODE_PLAN_COMMENTS_FENCE_OPEN}\n${payload}\n${MCODE_PLAN_COMMENTS_FENCE_CLOSE}`;
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
