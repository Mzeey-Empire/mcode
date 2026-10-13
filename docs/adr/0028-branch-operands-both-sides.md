# 0028: Branch compares a picked compare ref against a picked base

Status: Accepted

Date: 2026-10-13

Amends [ADR-0007](0007-branch-comparison-default-and-range.md) rule 1 and the
defaults in [ADR-0011](0011-review-default-view-per-thread.md).

## Context

ADR-0007 fixed the current branch on one side of the Branch view and let the
user pick only the other. The client relabelled the server's pair as
`current → selected` and swapped it back on the wire. On a feature branch the
swap sent the intended `origin/main...feat`. On the default branch, ADR-0007
rule 1 proposed `main...origin/main` (incoming commits), but the swap sent
`origin/main...main` (unpushed commits). The ADR and the shipped behaviour
disagreed, and nobody could see which one was meant.

A fixed side also blocks real reviews: a diverged local `main` against
`origin/main`, two feature branches, or a branchless thread's `HEAD` against a
release branch. Short names cannot carry those choices, because local `main`
and `origin/main` both display as "main".

## Decision

The Branch view has two pickable operands, written `compare → base`:

- **compare** is the after side and **base** is the before side. Each is a
  fully qualified ref (`refs/heads/x`, `refs/remotes/origin/x`) or `HEAD`.
- The wire range is always `${base}...${compare}`, three-dot as ADR-0007
  decided. No layer swaps the operands.
- Each picker pages the server's qualified-ref listing with the Review
  purpose. That purpose keeps a local branch and its remote twin as separate
  rows and separate selections.
- The server proposes the default pair. Once the user picks either side, the
  scope keeps both sides until the thread or workspace closes. A later
  re-resolve does not replace the pick. A picked ref that disappears shows as
  a failed comparison, not a silent fallback.

**Default-branch direction.** On the default branch, the default compares the
branch against its upstream as `origin/main → main`: compare `main`, base
`origin/main`. It shows unpushed commits. This replaces ADR-0007 rule 1's
`main...origin/main` example and keeps the behaviour users already had. It
matches ADR-0007's own context, which names the unpushed diff as the most
actionable default. The rest of ADR-0007's priority ladder stands.

**Branchless threads.** compare is `HEAD` and base is the thread's saved base
branch ([ADR-0015](0015-branchless-worktrees-for-new-isolated-threads.md)).

**Defaults across views.** The ADR-0011 default never lands on an unavailable
view. A clean thread whose Branch view is unavailable defaults to Unstaged.
The Turn view, which follows the latest turn, replaces Last turn in that
ladder.

## Considered Options

- **Keep one fixed side (rejected).** It cannot express diverged twins,
  branch-to-branch reviews or a branchless `HEAD`, and it needs the swap that
  caused the direction mismatch.
- **Short ref names on the wire (rejected).** `main` is ambiguous when a local
  and a remote branch share it.
- **Incoming direction on the default branch (rejected).** It follows ADR-0007
  rule 1's text, but it changes what users have been shown, and the unpushed
  diff is the more useful pre-push check.
- **Two pickable qualified operands (chosen).**

## Consequences

- `BranchComparison` carries `{ compare, base }` and no ref list. The pickers
  page refs from the server.
- Readers of a comparison, such as the Thread overview's Changes row, send
  `compare`. Nothing reads a `target` operand.
- The Commit view keeps its own domain: commits since the fork, not the Branch
  default pair. A fully pushed branch still lists its commits.
