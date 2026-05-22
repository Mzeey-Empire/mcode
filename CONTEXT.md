# Context: Mcode Glossary

Domain terms used across this repo, resolved during design conversations.
This file is a glossary only. No implementation details, no architecture, no
specs. For those see `ARCHITECTURE.md`, `docs/plans/`, and
`docs/guides/`.

## Chat threading

### Thread
A single chat conversation between a user and an AI agent. Threads belong to
workspaces and run against a provider. Distinct from a git branch even though
threads can be associated with a worktree.

### Fork (verb), forked thread (noun)
The act of branching a conversation from a specific message in a parent
thread, creating a new child thread that picks up from that anchor point.
Renamed from "branch" in UI copy to disambiguate from git branches. The
schema field is already named `forked_from_message_id`.

### Parent thread / child thread
The pre-existing thread a fork is created from is the **parent**. The newly
created thread is the **child**. The parent is unaffected by the fork; the
child inherits the parent's context via a handoff.

### Fork anchor
The specific message in the parent thread that a fork is created from. Has a
**role**, either `user` (forking from your own message; intent is "retry")
or `assistant` (forking from the agent's reply; intent is "follow up about
what was just said"). The role shapes how the handoff is framed.

## Handoff

### Handoff
A markdown document summarizing the parent thread, written to disk and
inlined into the child thread's first provider turn so the new agent picks
up with the parent's context. The handoff replaces what would otherwise be a
verbose transcript replay.

### Handoff pipeline
The orchestration layer that produces a handoff for a given fork. Routes
through one of three paths (B / A / D) based on the parent provider's
capability and live availability.

### Side-channel
A provider call made out-of-band from the user-visible conversation, used to
generate a handoff. Does not appear in the parent thread's UI. Distinct from
a "hidden turn". Side-channels typically use a separate SDK process.

### Hidden turn
A message persisted with `is_internal: 1` so it doesn't render in the UI but
is still present in the provider's session state. Used in path A to inject
the handoff request into the parent's session without polluting the user's
view of the conversation.

### Disregard turn
A second hidden turn following a hidden handoff request, instructing the
model to ignore the previous request and continue normally. Specific to
path A's session-mutation cleanup.

## The B/A/D ladder

### Path B (clean side-channel)
Resumes the parent provider's session in a forked SDK process to generate
the handoff. The original session is untouched. Used when the provider
declares `sessionForkOnResume: "clean"` (Claude).

### Path B-prime (sessionless side-channel)
Variant of path B that runs without `resume:` when the parent's session
isn't available (e.g. after a server restart). Provides the conversation
history as text in the prompt instead. Same artifact ladder step ("B") from
the caller's perspective.

### Path A (mutating resume)
Injects hidden turns directly into the parent thread's session. Used when
the provider declares `sessionForkOnResume: "mutating"` (Cursor today).
Cleaned up with a disregard turn.

### Path D (deterministic)
Local builder that produces the handoff from message rows without invoking
any provider. Used as the universal fallback. Lowest fidelity but always
available.

### Ladder step
A label on a produced handoff artifact (`"B" | "A" | "D"`) identifying which
path generated it. Stored in `handoff.json` for diagnostics and the
fallback banner copy.

## Modes and budgets

### Full mode
The default handoff structure produced by path B / A when the child
provider's per-turn input window is large enough (≥ 8000 characters).
Includes the model's choice of sections. The prompt does not enforce a
fixed list.

### Minimal mode
Compact handoff structure triggered when the child provider's
`maxInputCharactersPerTurn` is below 8000 (Cursor's 4000-char floor today).
Drops ancillary sections to keep the inlined doc within budget.

### Character budget
The size constraint applied to the inlined portion of a handoff. Sourced
from the child provider's declared `maxInputCharactersPerTurn`, minus
reserved overhead for system prompt + the user's first message. Used as
characters, not tokens. Tokens vary per model and are not portable.

### Overflow
The portion of a handoff that exceeds the inline budget. Written to the
user's OS temp directory at
`os.tmpdir()/mcode-handoff-overflow-<threadId>-<ts>.md` with a pointer
embedded in the inlined version. The next agent can `Read` it on demand.

## Provider capabilities

### Session fork behavior
Declared per provider as `"clean" | "mutating" | "unsupported"`. Determines
which ladder path the orchestrator dispatches to:

- **clean**: `resume:` spawns a fork without mutating the original (Claude)
- **mutating**: `resume:` mutates the session forward (Cursor today)
- **unsupported**: provider can't fork sessions; pipeline goes directly to
  path D (Codex, Copilot today)

### Per-turn input cap
The maximum input characters a provider accepts per turn. Declared as
`maxInputCharactersPerTurn`. Drives both the handoff budget and the
mode (full vs minimal) selection.

## Internal / hidden state

### Internal message
A message persisted with `is_internal: 1`. Excluded from the user-visible
timeline and from queries by default. Used for hidden turns and for the
synthetic system message anchoring a handoff at sequence 1 in a child
thread.

### Provenance metadata
The `handoff.json` sidecar accompanying every `handoff.md`. Records which
path produced the doc, when, against which provider, with which classified
error (if any). Used by the View doc dialog and by the fallback banner copy.

## Related but distinct

### Cross-provider switch (deferred)
Swapping a thread's provider mid-conversation. Uses the same handoff
primitive as a fork but with the implicit anchor being the thread's last
message, and the same thread continues with the new provider. Not yet
implemented; tracked in `docs/plans/2026-05-21-chat-branch-handoff-pipeline.md`.

### Compaction
A separate mechanism that summarizes a thread's older turns into a single
compact summary stored on the thread itself, used to keep long threads
within their own provider's context window. Distinct from a fork handoff,
though the orchestrator does consult `last_compact_summary` when building a
deterministic path-D handoff.
