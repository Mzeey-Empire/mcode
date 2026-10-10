import type { DetachedWorktreeTarget, GitRef, PullRequestTarget } from "@mcode/contracts";

/** A checkout location, as the picker shows and the store records it. */
export interface BranchTargetWorktree {
  readonly path: string;
  readonly folder: string;
}

/** One choosable target. The picker's rows and its `onSelect` payload are the same value. */
export type BranchTarget =
  | {
      readonly kind: "branch";
      /** Picker label and the value the composer sends: `main`, or `origin/x` for a remote-only ref. */
      readonly name: string;
      /** Branch name without the remote, for places where a remote prefix is wrong, such as a PR base. */
      readonly branchName: string;
      /** Remote of a remote-only ref; null for a local ref, with or without a twin. */
      readonly remote: string | null;
      /** Same-name origin ref grouped into this local row. */
      readonly twin: string | null;
      readonly isCurrent: boolean;
      readonly isDefault: boolean;
      /** Another checkout that has this branch checked out. */
      readonly worktree: BranchTargetWorktree | null;
    }
  | { readonly kind: "detached-worktree"; readonly worktree: BranchTargetWorktree; readonly headShortSha: string }
  | { readonly kind: "pull-request"; readonly number: number; readonly title: string; readonly headRefName: string };

/** A branch row. */
export type BranchRefTarget = Extract<BranchTarget, { kind: "branch" }>;
/** A pull request row. */
export type PullRequestBranchTarget = Extract<BranchTarget, { kind: "pull-request" }>;

/** What a host currently has selected, in the host's own terms. The picker turns it into a row key. */
export type BranchTargetValue =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "pull-request"; readonly number: number }
  | { readonly kind: "worktree"; readonly path: string };

/** Maps one `git.refs.list` item. The only place that reads `GitRef` or `DetachedWorktreeTarget`. */
export function toBranchTarget(ref: GitRef | DetachedWorktreeTarget): BranchTarget {
  if (ref.kind === "detached-worktree") {
    return { kind: "detached-worktree", worktree: ref.worktree, headShortSha: ref.headShortSha };
  }
  return {
    kind: "branch",
    name: ref.shortName,
    branchName: ref.branchName,
    remote: ref.remote,
    twin: ref.twin,
    isCurrent: ref.isCurrent,
    isDefault: ref.isDefault,
    worktree: ref.worktree,
  };
}

/** Maps one `github.pullRequestTargets.list` item. */
export function toPullRequestTarget(pr: PullRequestTarget): PullRequestBranchTarget {
  return { kind: "pull-request", number: pr.number, title: pr.title, headRefName: pr.headRefName };
}

/**
 * The project's default target: the checked-out branch, else the repository default. Reads page one only;
 * the server sorts the default and then the current branch first, so both are on it.
 */
export function pickDefaultBranchTarget(items: readonly BranchTarget[]): BranchRefTarget | null {
  const branches = items.filter((item): item is BranchRefTarget => item.kind === "branch");
  return branches.find((branch) => branch.isCurrent) ?? branches.find((branch) => branch.isDefault) ?? null;
}
