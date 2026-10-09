# 0023: Durable plan versions

Status: Accepted

Date: 2026-10-09

## Context

Agent captures enter canonical accepted progress before their SQLite writes finish.
User edits have no assistant message and cannot satisfy canonical plan ownership.
A separate user writer would also leave the canonical version allocator unaware of edits.

## Decision

Store agent captures and user edits in the same version sequence per thread.
Agent versions are ready and immutable. The latest user draft is mutable through
revision-checked saves. A user fork keeps its ready base reviewable. A subsequent
agent capture supersedes both, but never supersedes an accepted version.

Serialize user saves and snapshots through ApplicationDatabaseWriter. Check busy
state, fork identity and revision inside the transaction. A client-generated version
ID keys a fork; an identical request one revision behind replays its saved result.
Other stale requests return the latest version without changing stored text.

Reload the canonical plan cache after writes. Merge statuses monotonically and
take user content and revisions from SQLite. Read old canonical payloads through
one compatibility reader without rewriting the event log.

Mcode's per-thread plan file projects the latest non-superseded version. Provider
file references stay server-side and do not grant permission to mutate a file.

## Consequences

Version numbers continue across accepted plans. Clients consume one snapshot and
one version-upsert push. They retain unsaved text on conflicts and must obtain an
explicit user choice before replacing another window's draft.

Accepted transitions belong to Implement turn admission, not a generic status RPC.
The editor, comments and Implement admission are separate follow-up work.
