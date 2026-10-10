/**
 * Pure rules that decide what a commit request did. Ownership of a commit is proved only by
 * what this process saw `git commit` do; parent, subject and time are never treated as proof.
 */
import type { GitCommitRejection } from "@mcode/contracts";

/** Seconds a `git commit` may run before Mcode kills it. Hooks can run linters. */
export const COMMIT_TIMEOUT_SECONDS = 300;

/** How the git child that should have made the commit ended. */
export type CommitExit =
  | { kind: "exited"; code: number; output: string }
  | { kind: "killed"; output: string };

/** Repository state read after the git child exited, under the mutation lock. */
export interface CommitObservation {
  exit: CommitExit;
  originalHead: string | null;
  currentHead: string | null;
  /** First parent of `currentHead`; null when it is a root commit or HEAD is unborn. */
  currentHeadFirstParent: string | null;
}

/** Outcome of settling one observed commit attempt. */
export type CommitAttemptSettlement =
  | { state: "committed"; commitSha: string }
  | { state: "rejected"; rejection: GitCommitRejection }
  | { state: "unknown"; head: string | null; detail: string };

/** Settle a request from what this process saw `git commit` do. */
export function settleCommit(observation: CommitObservation): CommitAttemptSettlement {
  const { exit, originalHead, currentHead, currentHeadFirstParent } = observation;
  const succeeded = exitedCleanly(exit);
  const headMoved = currentHead !== originalHead;
  if (succeeded && headMoved && currentHead !== null && currentHeadFirstParent === originalHead) {
    return { state: "committed", commitSha: currentHead };
  }
  if (!succeeded && !headMoved) return { state: "rejected", rejection: classifyCommitFailure(exit) };
  return {
    state: "unknown",
    head: currentHead,
    detail: succeeded
      ? "git commit succeeded, but HEAD is not a child of the commit this request started from."
      : `git commit failed after HEAD moved.\n${exit.output}`.trimEnd(),
  };
}

function exitedCleanly(exit: CommitExit): boolean {
  return exit.kind === "exited" && exit.code === 0;
}

/** Repository state read when a `prepared` row is found with nobody left to settle it. */
export interface PreparedObservation {
  originalHead: string | null;
  currentHead: string | null;
  indexLockPresent: boolean;
}

/** Outcome of reconciling a request no process recorded. It is never `committed`. */
export type ReconcileSettlement = Exclude<CommitAttemptSettlement, { state: "committed" }>;

/** Settle an orphaned `prepared` request without claiming a commit it cannot prove. */
export function reconcilePrepared(observation: PreparedObservation): ReconcileSettlement {
  if (observation.currentHead === observation.originalHead && !observation.indexLockPresent) {
    return {
      state: "rejected",
      rejection: {
        kind: "failed",
        summary: "Commit was interrupted",
        detail: "Mcode stopped before it recorded the outcome, and HEAD did not move.",
      },
    };
  }
  return {
    state: "unknown",
    head: observation.currentHead,
    detail: observation.indexLockPresent
      ? "Mcode stopped before it recorded the outcome, and an index lock shows a git commit may still be running."
      : "Mcode stopped before it recorded the outcome, and HEAD moved. The commit may exist.",
  };
}

type PatternRejection = (detail: string) => GitCommitRejection;

/** One table maps git output to a rejection kind; the first match wins. */
const COMMIT_FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, PatternRejection]> = [
  [/nothing to commit|nothing added to commit|no changes added to commit/i, () => ({ kind: "nothing-to-commit" })],
  [/Please tell me who you are|unable to auto-detect email address|empty ident name/i, (detail) => ({ kind: "identity-missing", detail })],
  [/unmerged files|unmerged paths|partial commit during a merge|not possible because you have unmerged/i, (detail) => ({ kind: "conflicts", detail })],
  [/index\.lock/i, (detail) => ({ kind: "index-locked", detail })],
];

/** Classify why `git commit` (or the intent-to-add step before it) committed nothing. */
export function classifyCommitFailure(exit: CommitExit): GitCommitRejection {
  const detail = exit.output.trim();
  if (exit.kind === "killed") {
    return { kind: "failed", summary: `Commit timed out after ${COMMIT_TIMEOUT_SECONDS}s`, detail };
  }
  const match = COMMIT_FAILURE_PATTERNS.find(([pattern]) => pattern.test(detail));
  if (match) return match[1](detail);
  const firstLine = detail.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return { kind: "failed", summary: firstLine ?? `git commit exited with code ${exit.code}`, detail };
}
