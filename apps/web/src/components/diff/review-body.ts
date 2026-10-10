import type { ReviewComparison, ReviewComparisonResult } from "@mcode/contracts";
import type { DiffViewMode } from "@/stores/diffStore";

/**
 * A comparison outcome as the Review panel holds it: a server result, a view
 * with no operand to compare (no commit or turn picked), or a request that
 * never answered.
 */
export type ReviewOutcome =
  | ReviewComparisonResult
  | { readonly status: "unselected" }
  | { readonly status: "request-failed"; readonly detail: string };

/** What the Review body renders for one settled outcome. */
export type ReviewBody =
  | { readonly kind: "ready"; readonly comparison: ReviewComparison }
  | { readonly kind: "empty"; readonly title: string; readonly detail?: string }
  | { readonly kind: "failed"; readonly summary: string; readonly detail: string }
  | { readonly kind: "too-many-files"; readonly fileCount: number; readonly limit: number }
  | { readonly kind: "gone"; readonly title: string; readonly detail: string };

/** The view facts the copy needs to name what is empty or gone. */
export interface ReviewBodyContext {
  readonly view: DiffViewMode;
  /** The Turn view's ordinal for the selected turn, when it is known. */
  readonly turnOrdinal: number | null;
  /** The range the branch view actually compared. */
  readonly branchRange: { readonly base: string; readonly target: string } | null;
}

/** Map one outcome to the body the panel shows, so a failure never reads as empty. */
export function reviewBody(outcome: ReviewOutcome, context: ReviewBodyContext): ReviewBody {
  switch (outcome.status) {
    case "ready":
      return outcome.comparison.files.length > 0
        ? { kind: "ready", comparison: outcome.comparison }
        : emptyBody(context);
    case "too-many-files":
      return { kind: "too-many-files", fileCount: outcome.fileCount, limit: outcome.limit };
    case "failed":
      return { kind: "failed", summary: outcome.failure.summary, detail: outcome.failure.detail };
    case "request-failed":
      return { kind: "failed", summary: "The request didn't complete", detail: outcome.detail };
    case "unavailable":
      return unavailableBody(outcome.reason, context);
    case "unselected":
      return { kind: "empty", title: context.view === "commit" ? "No commit selected" : "No turns yet" };
  }
}

/**
 * What the Files pane says when a body has no file list to show, so the pane
 * never reads "No changed files" beside a failure. Null means the pane lists
 * the comparison's files as usual.
 */
export function filesPaneNotice(body: ReviewBody | null): string | null {
  switch (body?.kind) {
    case "failed":
      return "Couldn't load this comparison";
    case "too-many-files":
      return "Too many files to show";
    case "gone":
      return body.title;
    default:
      return null;
  }
}

function emptyBody(context: ReviewBodyContext): ReviewBody {
  switch (context.view) {
    case "turn":
      return context.turnOrdinal === null
        ? { kind: "empty", title: "No file changes in this turn", detail: "The agent answered without editing files" }
        : { kind: "empty", title: `No file changes in Turn ${context.turnOrdinal}`, detail: "The agent answered without editing files" };
    case "last-turn":
    case "cumulative":
      return { kind: "empty", title: "No file changes in this thread yet" };
    case "unstaged":
      return { kind: "empty", title: "No unstaged changes" };
    case "staged":
      return { kind: "empty", title: "Nothing staged" };
    case "commit":
      return { kind: "empty", title: "No file changes in this commit" };
    case "branch":
      return context.branchRange
        ? { kind: "empty", title: `No changes between ${context.branchRange.target} and ${context.branchRange.base}` }
        : { kind: "empty", title: "No changes on this branch" };
  }
}

function unavailableBody(
  reason: Extract<ReviewComparisonResult, { status: "unavailable" }>["reason"],
  context: ReviewBodyContext,
): ReviewBody {
  switch (reason) {
    case "unborn":
      return { kind: "empty", title: "No commits yet" };
    case "no-base":
      return { kind: "empty", title: "No base branch to compare against" };
    case "snapshot-expired":
      return { kind: "gone", title: goneTitle(context), detail: "Snapshots older than 30 days are cleared" };
    case "snapshot-pruned":
      return { kind: "gone", title: goneTitle(context), detail: "Git removed this turn's snapshot" };
  }
}

function goneTitle(context: ReviewBodyContext): string {
  if (context.view === "cumulative") return "This thread's changes are gone";
  return context.turnOrdinal === null
    ? "This turn's changes are gone"
    : `Turn ${context.turnOrdinal}'s changes are gone`;
}
