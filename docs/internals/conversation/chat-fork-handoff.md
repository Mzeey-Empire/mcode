# Context transfer for switch, fork, and recovery

[Handoff v2](../../../apps/server/src/features/handoff/v2/) selects whole
items of stored history under the incoming provider's budget. It never asks
the outgoing provider to summarize the conversation. The decision and budget
policy are recorded in [ADR 0031](../../adr/0031-handoff-v2-budgeted-transcript-selection.md).

The callers own different boundaries:

- [Provider switch](../../../apps/server/src/features/agents/turns/provider-switch-service.ts)
  continues the same thread. A returning native session receives only history
  after its saved watermark, unless the gap is too large or resume fails.
- [Fork](../../../apps/server/src/features/projects/worktrees/thread-branching-service.ts)
  creates a child with fresh native session identity. History stops at the
  selected parent message and context is prepared before first-turn dispatch.
- [Recovery](../../../apps/server/src/features/agents/recovery/turn-recovery-service.ts)
  supplies history to a replacement session while preserving turn ownership.

The [fenced preamble](../../../apps/server/src/features/handoff/v2/fenced-handoff.ts)
uses a fresh random boundary to distinguish historical text from the new
request. Selection reports omitted sequences and excludes reasoning,
tool-output bodies, and attachment contents. The user's new message stays
intact. Insufficient room for the preamble fails with
`handoff_budget_exhausted`; there is no provider-summary fallback.

[Storage](../../../apps/server/src/features/handoff/persistence/handoff-storage.ts)
saves the delivered history in
`threads/<threadId>/handoffs/<ulid>/handoff.md`. Its `schemaVersion: 2`
frontmatter records kind, providers, sequence coverage, budget, and dropped
options. This file is an audit copy. Delivery is inline and grants no file
access. The reader validates v2 metadata and ignores older JSON-sidecar
artifacts without rewriting them.
