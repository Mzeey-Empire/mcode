# 0031: Handoff v2, one budgeted transcript selection for switch, fork, and recovery

Status: Proposed

Date: 2026-10-20

## Context

Mcode moves conversation context between provider sessions in three places,
each with its own mechanism:

- **Fork** runs the B/D ladder in `apps/server/src/features/handoff/`. Path B
  asks the parent's provider to write a summary through a side channel
  (`CleanForker`, 120 s timeout). Path B-prime replays history into that side
  channel. Path D builds a deterministic summary from stored data
  (`path-d-deterministic.ts`). Delivery is inline for Codex (14,000-char cap)
  and an off-band temp file with a scoped Read pre-grant for everyone else.
- **Recovery** seeds a fresh session with `buildConversationReplay`
  (`turn-recovery-service.ts`), a third budget (`REPLAY_BUDGET_CHARS`).
- **Cross-provider switch** (`CONTEXT.md`, "Cross-provider switch") is
  defined but not built. `sendMessage` accepts a different `command.provider`
  and persists it, but the new provider receives no context.

Issue #2231 asked how a started thread moves to another provider. Reading the
code for the spike found a defect on that path: `resumeFrom`
(`turn-admission-dispatch-coordinator.ts`) passes `prepared.thread.sdk_session_id`
without comparing providers, while `resumeIdentities` in the same file does.
A Claude session id can therefore reach the Codex adapter as `req.resumeFrom`.

T3 Code built the same feature (`docs/orchestration-v2/provider-switching-and-context.md`,
`packages/provider-core/src/server/handoffBudget.ts` in `pingdotgg/t3code`).
Its design started from agent-written summaries and moved to a deterministic,
budgeted selection of verbatim history. Its user docs now say a handoff "is a
budgeted selection, not an agent-written summary". The lessons that apply here:

1. The usual reason to switch is that the outgoing provider is limited or
   signed out, so a path that needs the outgoing session (our path B) fails
   exactly when it is needed.
2. A summary written by a model loses constraints silently. Verbatim messages,
   chosen under a budget, keep the user's own words.
3. The budget must leave room for the target's existing context and the new
   request, and must fail loudly when even the minimum does not fit.

## Decision

Replace the B/B-prime/D ladder and the recovery replay with one primitive,
**handoff v2**: a deterministic, budgeted selection of stored thread history,
delivered inline with the next turn. Use it for cross-provider switch, fork,
and recovery. No provider writes the handoff.

### The primitive

`selectHandoffHistory({ items, budgetBytes, coverage })` in
`apps/server/src/features/handoff/v2/` is a pure function.

- **Items** come from stored messages for a sequence range: user and assistant
  text, plus one line per tool call that changed files or ran a command, and
  the current plan from `<mcodeDir>/threads/<id>/plan.md` when one exists.
  Reasoning, tool output bodies, and attachments are not replayed.
- **Selection order**: the latest user message, the latest assistant message,
  the first user message, then newest to oldest until the budget is spent.
  Selected items keep full text, order, role, and source provider. An item is
  either selected whole or omitted.
- **Rendering** wraps each item in a header (`role`, `provider`, `sequence`)
  under a preamble that says the material is history, not new instructions,
  and lists how many items were omitted with their sequence numbers.
- **Budget**: `min(HANDOFF_TOKEN_CAP, HANDOFF_BYTE_CAP, window - native - current - reserve)`,
  counting one token per UTF-8 byte. Defaults follow T3 Code: cap 16,000,
  byte cap 64,000, reserve `max(16,000, window / 4)`, a 128,000 window when
  `threads.context_window` is unknown, 8,192 per image and 4,096 per other
  attachment in `current`. If the preamble alone does not fit, the turn fails
  with a typed `handoff_budget_exhausted` error. The user's new message is
  never shortened.

### Answers to #2231

1. **Same thread.** A switch continues the thread in place, as `CONTEXT.md`
   says. Forks still create a new thread; only their context transfer changes.
2. **Context transfer.** Handoff v2 needs no outgoing session, so being
   limited or signed out does not block a switch. Path B, B-prime and D are
   removed rather than kept as fallbacks.
3. **Build on `sendMessage`.** A send whose `command.provider` differs from
   the thread's provider is a switch. No new command. Fix `resumeFrom` to
   compare providers, matching `resumeIdentities`.
4. **Session identity.** New table `thread_provider_sessions`
   (`thread_id`, `provider_id`, `session_id`, `last_seen_sequence`,
   `updated_at`, primary key `(thread_id, provider_id)`). `threads.sdk_session_id`
   stays as the active provider's session for existing readers and is written
   from this table. A thread that used two providers has two rows.
5. **Switching back resumes plus delta.** Returning to a provider that has a
   row resumes its native session and sends a handoff covering only sequences
   after `last_seen_sequence`. The rule falls back to a fresh session with a
   full-range handoff when the resume fails or when more than
   `MAX_DELTA_TURNS` (default 20) turns ran elsewhere. This replaces the
   "swap-back spawns a fresh session" rule in `CONTEXT.md`.
6. **In-flight state.** A switch is admitted only when the thread is idle. A
   send with a different provider during an active turn is queued like any
   other send and switches when it dequeues. Pending approvals belong to the
   active turn, so none exist at switch time. Interaction mode carries over
   because `plan.md` lives outside the provider session.
7. **History.** Every message keeps `messages.provider`. The timeline renders
   other providers' tool calls and subagent rosters from stored narration as
   it does today, and shows a switch marker (PSW-04).
8. **Capabilities.** Before a switch commits, model options are reconciled
   against the target's catalog: unsupported options (Fast, reasoning levels,
   context-window mode) are dropped and reported in the switch receipt.
   Permission mode maps to the nearest mode the target supports. Skills and
   slash commands resolve against the target provider on the next turn.
9. **Failure.** The provider change, the session row, and the handoff
   artifact commit only after the target provider accepts the turn. If the
   target fails before its first event, the thread keeps its old provider,
   model and session, and the turn ends with a typed error naming the cause.

### Delivery and audit

Handoff text is prepended to the wire payload as a fenced preamble for every
provider. The budget makes the off-band file and its scoped pre-grant
unnecessary for handoffs, so that path is removed. Each handoff is still
written through `HandoffStorage` as `handoff.md` with frontmatter
`schemaVersion: 2`, `kind: switch | fork | recovery`, `fromProvider`,
`toProvider`, `coveredSequences`, `omittedSequences`, and `budgetBytes`, so
users and maintainers can see what the agent received.

### What is removed

`CleanForker`, `DeterministicForker`, every provider clean forker,
`handoff-prompt.ts`, `path-d-deterministic.ts`, `buildConversationReplay`,
`LadderStep`, `SessionForker`, `sessionForkOnResume`, the `forker` field on
providers, `chat.handoff.notifyOnLocalFallback`, and the `generating` and
`fallback` statuses on `thread.handoff`. The `handoff.readLatest` `meta.mode`
enum is reduced to what v2 writes.

## Consequences

- A switch or fork no longer waits up to 120 s on a provider call; selection
  runs in milliseconds.
- Handoffs lose the outgoing model's interpretation of the work. Users who
  relied on path B's summaries get verbatim history instead.
- Agents cannot yet fetch omitted items. T3 Code exposes a thread-reading tool
  for that; Mcode needs the equivalent through its MCP toolkit (#2204). Until
  then the preamble lists omitted sequence numbers only.
- `CONTEXT.md` ("The B/D ladder", "Cross-provider switch", "Handoff
  delivery") and `docs/internals/conversation/chat-fork-handoff.md` must be
  rewritten in the same change that removes the ladder.

## Rejected alternatives

- **Keep the ladder and add switch on top (the epic's original plan).** Path B
  needs the session that is usually unavailable at switch time, and three
  context mechanisms would remain.
- **Always start a fresh session on switch back.** Simpler, but throws away
  native continuity and re-sends history on every swap.
- **A dedicated `switchProvider` command.** `sendMessage` already carries the
  provider and the switch always comes with a message.
- **T3 Code's full graph (`ContextTransfer`, provider-thread coverage arrays,
  rollback supersession).** More than Mcode needs; `thread_provider_sessions`
  plus `last_seen_sequence` gives the same switch-back behavior.
