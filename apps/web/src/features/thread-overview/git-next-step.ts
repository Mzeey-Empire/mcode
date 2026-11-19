import type { Thread } from "@/transport";

/** One git action the Overview's git row can offer. */
export type GitStep = "create-branch" | "commit" | "commit-and-push" | "push" | "create-pr";

/** The git row: its main part and the chevron menu's steps, in order. */
export interface GitRowPlan {
  readonly main: GitStep;
  readonly alternates: readonly GitStep[];
}

/** What the plan reads. null means not known yet. */
export interface ThreadGitFacts {
  readonly mode: Thread["mode"];
  readonly checkoutState: Thread["checkout_state"];
  readonly hasPullRequest: boolean;
  readonly hasUncommittedChanges: boolean | null;
  readonly hasCommitsAhead: boolean | null;
  readonly hasUnpushedCommits: boolean | null;
}

/**
 * The thread's next git step, or null when the row is hidden.
 *
 * An unknown fact hides the row rather than guessing: a guessed step that swaps a
 * moment later is the flicker the row must not show.
 */
export function planGitRow(facts: ThreadGitFacts): GitRowPlan | null {
  if (facts.mode !== "worktree") return null;
  if (facts.checkoutState === "branchless") return { main: "create-branch", alternates: ["commit"] };
  // Once a PR exists, the Open PR row owns the lane.
  if (facts.hasPullRequest) return null;
  return planNamedBranchRow(facts);
}

/** The next step on a named branch with no PR yet: commit, then push, then open a PR. */
function planNamedBranchRow(facts: ThreadGitFacts): GitRowPlan | null {
  if (facts.hasUncommittedChanges === null) return null;
  if (facts.hasUncommittedChanges) {
    return { main: "commit", alternates: ["commit-and-push", ...(facts.hasUnpushedCommits === true ? ["push" as const] : [])] };
  }
  if (facts.hasUnpushedCommits === null) return null;
  // Create PR… waits in the menu until the branch is pushed, and only when there is something to review.
  if (facts.hasUnpushedCommits) return { main: "push", alternates: facts.hasCommitsAhead === true ? ["create-pr"] : [] };
  if (facts.hasCommitsAhead === true) return { main: "create-pr", alternates: [] };
  return null;
}
