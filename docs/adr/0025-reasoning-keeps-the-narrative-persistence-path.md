# 0025: Reasoning keeps the narrative persistence path

Status: Accepted

Date: 2026-10-11

## Context

Codex, Cursor and Devin stream model reasoning. Their adapters mapped it to
non-final `textDelta` events, so reasoning rendered as narration. It merged
with neighbouring narration, supplied activity headings, and could be matched
against the final response and dropped.

Reasoning needs its own identity in the timeline. It does not need its own
storage, live buffer or recovery path. Each new path would repeat the volatile
ingest, crash recovery and display materialization that narration already has.

## Decision

Providers emit reasoning as `reasoningDelta` with an optional native item ID
and a `done` flag. A thought segment carries a `kind` of `narration` or
`reasoning`. A missing kind reads as narration, so older rows and payloads need
no rewrite.

Reasoning uses the same path as non-final text. Publishers mark it volatile.
It persists as a `thought_segments` row, and the `kind` column defaults to
`narration`. Recovery and display materialization carry the kind through.

Each turn keeps one open segment, and that segment carries its kind. Opening
the other kind closes it, so reasoning never merges with narration. A tool,
a hook, a boundary, answer text or turn end also closes open reasoning.
Provider reasoning IDs map to fresh segment IDs because native IDs can repeat
across turns.

Classification skips reasoning. It is never promoted to the answer, tagged
final, matched against the response text, counted as a step or thought, or
used as an activity heading. The timeline renders it as a collapsed `Thought`
row.

## Consequences

One kind check guards each classification site. A new classification site
must check the kind, or reasoning will leak into the answer.

Claude `thinking` blocks can adopt the event later without schema changes.
Codex child reasoning, which the canonical projection already kept separate,
now renders as the same `Thought` row.
