# Context: Mcode Glossary

Domain terms used across this repo, resolved during design conversations.
This file is a glossary only. No implementation details, no architecture, no
specs. For those see `ARCHITECTURE.md`, `docs/plans/`, and
`docs/guides/`.

## Providers

### Provider
An external AI agent backend that a thread runs against. Each provider is a
separately-installed CLI on the user's machine (Claude, Cursor, Codex,
OpenCode, GitHub Copilot). Mcode adapts to each one via an `IAgentProvider`
implementation. Providers are user-scoped (installed per user), not
workspace-scoped.

### Default provider
The provider used for new threads when the user does not pick one
explicitly. Set globally in user settings.

### Utility provider
The provider used for short, one-shot, non-conversational completions that
the app issues on the user's behalf (currently: drafting PR titles/bodies
and summarising a diff). Set globally in user settings; may differ from the
default provider. Handoff generation is **not** a utility-provider use case;
handoffs route through the originating thread's own provider via the B/A/D
pipeline.

## Workspaces and worktrees

### Workspace
The top-level container that owns a set of threads. Anchored 1:1 to a local
repository or folder path; a workspace cannot exist without one. The
workspace is the main folder the user set up first. Worktrees rooted under
that folder may host their own threads, but those threads still belong to
the parent workspace.

Workspace-level settings do not exist yet. All user-facing settings (default
provider, utility provider, etc.) are global (user-level) today. Providers
are installed on the user's machine, not on the workspace.

### Worktree
A git worktree provisioned under a workspace so a thread can run against
an isolated checkout of the repo on its own branch. Standard git semantics
— one repository, multiple working directories — applied as an isolation
primitive: each worktree-mode thread runs against its own files, its own
branch, and (in dev mode) its own database.

**A worktree is not 1:1 with a thread.** Multiple threads can share the
same worktree via the composer's "Existing worktree" mode. A thread can
also run *without* a worktree, directly against the workspace's main
checkout — see "Direct mode" below.

Worktrees are persistent and removed manually. When a user deletes a
thread, an option to delete its worktree is offered alongside; the
worktree can also be kept and reused for future threads.

## Composer

### Composer mode
The mode the composer is in when the user creates a new thread, determining
whether the thread runs against the workspace's main checkout or against a
worktree, and whether that worktree is new or pre-existing. Three modes:
**Direct**, **New worktree**, **Existing worktree**. Once a thread has been
created, its mode is fixed for the life of the thread — the composer shows
the chosen mode in read-only form rather than as a fourth mode.

### Direct mode
Composer mode where the thread runs against the workspace's main checkout.
No isolation: file edits affect the user's primary working directory and
current branch. The default when a workspace is not a git repo.

### New worktree mode
Composer mode where the thread provisions a fresh git worktree on a new
branch. Used when the user wants isolation and a clean branch for the work
about to be done. Code identifier: `"worktree"`.

### Existing worktree mode
Composer mode where the thread attaches to a worktree that already exists.
Enables multiple threads to share one worktree — e.g. follow-up work on
the same branch without re-creating the directory.

### Naming mode (Auto / Custom)
Sub-control of New worktree mode controlling how the new branch is named.
**Auto** generates a branch name from the thread's first message;
**Custom** lets the user type one explicitly. Auto is the default, but the
user can change the default to Custom from settings.

## Interaction modes

The two modes a thread can be in. Mutually exclusive; orthogonal to the
composer mode and to model configuration.

### Plan mode
A thread state where the agent produces a structured plan instead of
executing changes. The agent reasons, searches the codebase, drafts a plan
document, and presents it for the user to approve, revise, or reject.
Exited via the SDK's `ExitPlanMode` tool, after which the thread switches
to Build mode and the agent can act on the plan.

### Build mode
The opposite of Plan mode: the thread state where the agent actually
performs the work — editing files, running tools, making changes. The
default for new threads when the user does not opt into Plan mode.

> **Codebase mismatch (rename pending).** The `InteractionMode` enum still
> uses the value `"chat"` for what the product calls "Build mode." A
> follow-up rename to `"build"` is planned. Likewise, the
> `AgentDefaultModeSchema` still exposes a deprecated third `"agent"`
> value that should be dropped — the product has only Plan and Build.

## Model configuration

Per-thread settings that configure *how* the agent runs the model. None of
these are "modes" in the interaction-mode sense — they're configuration
axes that compose with whatever interaction mode is active.

### Permission mode
A thread-level setting controlling how much the agent can do without
explicit user confirmation. Two values: **Supervised** (prompts the user
before risky operations like edits and shell execution) and **Full** (the
agent acts without prompting). Default for new threads: **Full**.

### Context window
A per-thread selection of the model's context window size, sent to the
provider as a model slug suffix. Today only Claude exposes multiple tiers
(`200k` and `1m`); other providers ignore the setting. The 1M tier
unlocks Claude's extended context but typically costs more per turn.

### Reasoning level
A per-thread setting that controls how much reasoning effort the model
spends per turn. Values: `none`, `minimal`, `low`, `medium`, `high`,
`max`, `xhigh`, `ultrathink`. Each provider maps the value to whatever its
SDK supports — Claude uses these directly (with `max` mapping to extended
thinking on supported models), Codex maps `none`/`minimal` to its own
presets, and Copilot honours the level per model capability. The Cursor
provider does not expose a reasoning-level selector — its models manage
reasoning internally.

**Ultrathink** is a virtual top tier: it prepends `Ultrathink:\n` to the
user's prompt and sends `max` effort to the SDK underneath. Supported
only on max-tier Claude models.

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

## Chat lifecycle

### Turn
One round of agent execution within a thread, bounded by a `TurnStarted`
event and a `TurnComplete` event. A turn always begins with one user
message; the agent then does whatever work it needs (streaming thoughts,
calling tools, reading files, dispatching sub-agents) before producing its
final response. Everything from the user message to the final agent
response is the **same turn**, no matter how many intermediate steps
occurred. Costs, token counts, and tool-call sequences are attributed
per-turn, and several pieces of client-side state are scoped to the current
turn.

### Tool call
A single tool invocation the agent makes during a turn (e.g. `Read`,
`Bash`, `Grep`, `Edit`). Each tool call has an input, a result, and a
completion status, and renders as one row in the narrative timeline.
Multiple tool calls can run in parallel within the same turn. All
user-visible tool calls are domain tool calls; internal SDK plumbing is
not.

### Sub-agent
A tool call of a special kind: the agent dispatching another agent to do a
focused task and report back. Sub-agents may run in parallel and may
themselves dispatch further sub-agents (nested). Each sub-agent's events
are attributed to its parent via `parentToolCallId` so the narrative
timeline can nest them correctly.

Sub-agent calls are **always shown** in the user's timeline; the user
should be able to tell when the agent has handed work to a sub-agent. From
the user's point of view, a sub-agent is still part of the same turn as
the parent.

### Text delta
A streaming text chunk emitted by the provider as the agent types its
output. Many text deltas accumulate during a turn. At emission time the
deltas are unclassified — the system does not yet know whether they will
become part of the final response or get grouped as preamble narration.
Classification is resolved later by the `AssistantMessageBoundary` signal.

### Reasoning block
Structured reasoning output emitted by the provider when extended thinking
is enabled (e.g. Claude's `thinking` content blocks). A reasoning block is
its own distinct response object in the SDK — **not** the same as a stream
of text deltas. Mcode does not yet surface reasoning blocks; they will
become visible when extended thinking is wired into the UI.

### Narration segment
A contiguous group of text deltas the agent emitted **before** a tool call
within a turn — the agent's narration of what it is about to do. Distinct
from the final response (text deltas emitted *after* all tool calls have
resolved) and distinct from a reasoning block (only emitted when extended
thinking is on). Classification happens at the `AssistantMessageBoundary`
event: a `stop_reason` of `tool_use` closes the buffered deltas as a
narration segment; `end_turn` / `stop_sequence` / `max_tokens` / `refusal`
reclassifies them as final-response text instead.

### Final response
The text the agent produces after all tool calls in a turn have resolved,
intended as the user-facing reply for that turn. Identified by the SDK's
terminal `stop_reason` (`end_turn`, `stop_sequence`, `max_tokens`,
`refusal`) and persisted as the assistant message's `content`. Distinct
from narration segments (which are persisted to a separate table) and from
reasoning blocks (not yet surfaced).

### Message
A persisted unit of conversation in a thread. Each message has a **role**
(`user`, `assistant`, or `system`), a sequence number, and an optional
`is_internal` flag that excludes it from user-visible queries. User and
assistant messages drive the normal turn flow. System-role messages anchor
synthetic context — today used for the handoff document at sequence 1 in
a child thread and for the "Context compacted" marker placed after
compaction runs. Messages are what `forked_from_message_id` points to and
what hidden messages exclude themselves from in user-visible queries.

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
implemented; was a deferred item in the chat-fork handoff feature (PR #499).

### Compaction
A separate mechanism that summarizes a thread's older turns into a single
compact summary stored on the thread itself, used to keep long threads
within their own provider's context window. Distinct from a fork handoff,
though the orchestrator does consult `last_compact_summary` when building a
deterministic path-D handoff.

## App-side extensibility

Three end-user-facing extensibility surfaces inside the running Mcode app.
Each shares a name with a dev-tooling concept used by contributors who
develop Mcode itself (documented in `AGENTS.md`); the entries here refer
to the runtime, user-facing version only.

### Skill
A reusable agent capability the end user can attach to their threads
inside the Mcode app — domain knowledge or a multi-step workflow the
agent loads on demand. Skills are surfaced via `SkillInfo` records and
the skills store. Distinct from the dev-tooling skill concept under
`AGENTS.md` (which is for contributors developing Mcode itself).

### Slash command
A short command the user types in the composer (e.g. `/something`) that
the Mcode app expands into a richer prompt or action. Editor integration
lives in the composer's Lexical plugin (`SlashCommandPlugin`,
`SlashCommandNode`, `SlashCommandPopup`). Distinct from the dev-tooling
slash commands under `.claude/commands/` etc. (which are for
contributors).

### Hook
A user-configurable script that fires at a specific point in an agent's
lifecycle within a thread. Two kinds today:

- **Permission hook** — runs before a tool call to gate it. The hook can
  **allow** the call (optionally with a *modified input*) or **deny** it.
  The allow-with-modified-input capability is part of the underlying
  protocol — even though current implementations primarily exercise plain
  allow/deny, the modify path is real and worth keeping in mind when
  designing new hook UX or features.
- **Stop hook** — runs after a turn ends. Useful for verification,
  notifications, or post-processing.

Distinct from the dev-tooling stop hook under `AGENTS.md` (the harness
verification gate for contributors).
