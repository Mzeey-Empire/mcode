# 0027: Turn revert restores pre-turn content

Status: Accepted

Date: 2026-10-11

## Context

A turn can include several retry attempts and rename chains. Reverting its files
must include the failed attempts' edits and explain when later edits will be lost.
Git trees alone cannot recover exact working-tree bytes after filters or line
ending conversion. A process can also die between any two filesystem writes.

## Decision

Restore attributed, rename-connected paths to a fresh checkout of the first
attempt's pre-turn tree. File scope can span a range of whole turns. Later edits
to those paths are overwritten after preview identifies them. Write only the
working tree; leave the real index, HEAD, commits and branches untouched.

A client request id identifies one click and its durable outcome. A preview
token is a separate precondition over repository identity, the complete snapshot
range, scope, and raw path states. Reusing a request id with different parameters
is an error. Revert, Undo and another Revert are distinct requests.

Before the first write, pin unfiltered blobs and persist each path's raw `pre`
and `planned` states. Planned bytes come from Git's checkout conversion. All
writes restore recorded raw states through the same checked writer. Undo and
rollback therefore restore exact bytes, symlink targets and tracked modes.

Recover an interrupted operation by comparing raw presence, type, mode and
content with its journal. Leave paths already equal to `pre` alone. Restore
`pre` only when the current state equals `planned` and recovery material exists.
Leave every other path alone, record it as unresolved, retain its pin, and retry
on startup. A retry skips any path that a later committed revert or Undo in the
same checkout has written, because a retried revert leaves bytes identical to the
failed one's planned state. Persist a single interrupted receipt so recovery is
visible.

Reject a three-way inverse merge for v1. It would require conflict decisions and
UI that the restore confirmation does not represent.

## Consequences

Forward restore follows checkout filters; Undo and recovery are byte-exact.
Untracked ignored paths and non-Git workspaces cannot be reverted. Git-fallback attribution
can include concurrent user edits. The in-process repository lock cannot exclude
an editor or another runtime. An outside edit that is byte-identical to the
planned state is indistinguishable from the operation's own write.
