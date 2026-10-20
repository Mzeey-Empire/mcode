# Context: Mcode Glossary

Domain terms used across this repo, resolved during design conversations.
This file is a glossary only. No implementation details, no architecture, no
specs. For those see `ARCHITECTURE.md` and `docs/internals/`.

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
default provider. Handoffs never use the utility provider; handoff v2 builds
them from stored messages without calling any provider.

### Session runtime
The per-Provider service for adapters with a persistent process per session. It owns the
lifecycle: the session pool, the lazy idle-eviction timer (60s sweep, 10min
default TTL) with a `lastUsedAt + isBusy` guard, Windows `JobObject`
attachment, the env snapshot, lazy spawn, provider protocol hooks, and the
graceful-interrupt-then-hard-kill (`taskkill /T /F` on Windows) close. It
treats per-session state as opaque (`SessionRuntime<TState>`). Each adapter using
this lifecycle holds its own instance, keeping its state type-isolated.
OpenCode instead uses a server pool shared across sessions in one working
directory.

### Provider reattachment
Restoring observation and control of the same still-running Provider thread
and turn after transport loss, without creating a new turn.

### Same-turn recovery
Provider-native continuation of an existing turn with the same turn identity
and preserved execution history, without a new user message.

### Replacement turn
A new attempt of an interrupted or errored turn, started explicitly when
same-turn recovery is unavailable. **Retry** replays an errored turn's user
message. **Resume** continues an interrupted turn with a hidden continuation
prompt: in the provider's saved session when it can, otherwise in a fresh
session seeded with a budgeted selection of the thread's conversation (handoff v2). If
the handoff preamble or the interrupted turn's own request cannot fit, the resume fails instead of sending a truncated
message. Either may repeat effects from the earlier attempt. The transcript shows the turn's user message once, then
only the latest attempt; earlier attempts' records stay persisted.

### Protocol adapter
The per-Provider seam carrying the protocol-specific I/O the Session runtime
delegates to: `spawn` (returning the session state plus any child PIDs the
runtime should attach/kill), `isBusy` (the eviction guard), `interrupt`
(protocol-level graceful stop), `close` (provider teardown short of the OS
kill), and `isStale` (whether a pooled session must be discarded before
reuse). Each Provider *is* its own Protocol adapter (the Provider class
implements the interface); composition with the Session runtime, not
inheritance.

### Provider runtime event
A provider-to-server event that can include provider-native evidence needed for
server-side interpretation. It is not a renderer event.

### Agent event
A provider-neutral event used by the server and renderer to represent a turn's
visible progress, such as text, tools, lifecycle, and errors. It excludes
provider-native identity and private child evidence.

## Workspaces and worktrees

### Platform command
A Project action's default script and optional operating-system overrides.
Mcode resolves one script for the current system and runs it from the Thread's
checkout root with the Project's configured terminal and normal environment.

### Workspace
The top-level container that owns a set of threads. Anchored 1:1 to a local
repository or folder path; a workspace cannot exist without one. The
workspace is the main folder the user set up first. Worktrees rooted under
that folder may host their own threads, but those threads still belong to
the parent workspace.

The only workspace-level setting is the chosen [project icon](#project-icon).
All other user-facing settings (default provider, utility provider, etc.) are
global (user-level) today. Providers are installed on the user's machine, not
on the workspace.

**Project** is the user-facing name for a Workspace. Every UI string ("Add
project", "Recent Projects", "No projects yet") says _project_; the code and
this glossary say _Workspace_. They are the same thing.
_Avoid_: using "project" in code or schema; reserve it for user-facing copy.

### Project icon
The small image that identifies a project in the sidebar, the new-thread
breadcrumb, and the project chooser. A file the user chose inside the project
wins. Otherwise Mcode looks for a favicon or logo in common places, such as
`public/favicon.svg` or the icon an `index.html` links to. With neither, the
project shows a monogram of its name's first letter. The icon always comes from
the workspace folder, so every worktree of a project shows the same one.
_Avoid_: "favicon" for the general idea; a favicon is only one source.

### Worktree
A git worktree provisioned under a workspace so a thread can run against
an isolated checkout of the repo. Standard git semantics, one repository
with multiple working directories, applied as an isolation primitive: each
worktree-mode thread runs against its own files and, in dev mode, its own
database. A worktree-mode thread may start without its own branch; the user
can create that branch later from the Overview.

**A worktree is not 1:1 with a thread.** Multiple threads can share the
same worktree via the composer's "Existing worktree" mode. A thread can
also run *without* a worktree, directly against the workspace's main
checkout. See "Direct mode" below.

Mcode removes a worktree in its sandbox when cleanup starts only if no active
thread links to it. It then removes every linked thread that is not active.
If an active thread links to the worktree, Mcode keeps both. It removes only the
selected completed thread. Mcode keeps a checkout outside its
sandbox or on the repository default branch, then removes only the selected
thread data. When a user deletes a thread manually, they can choose whether
to schedule worktree cleanup.

### Branchless worktree
A worktree that has no named branch yet. It starts from a selected base
branch and lets the thread run in isolation before the user decides whether
the work needs a branch. In branch-facing UI, the checkout is shown as
`detached at <hash>` using the short commit hash of its HEAD, falling back to
`detached from <base>` while the hash is unread and `detached` when no base is
recorded either. The hash tells apart two detached threads on the same base.
In Review comparisons, the compare side is shown as `HEAD` and the base remains
the selected base branch for that worktree.
_Avoid_: Headless worktree

### Start from origin
An option for New worktree mode that fetches the selected branch from `origin`
and starts a branchless worktree at that remote tip. Local branches never move.
If fetching fails, startup waits for Retry or Continue from the local branch.
The selected branch remains the worktree's review and pull-request base.

### Thread checkout state
The thread's current git position. A worktree thread is either on a named
branch or in a branchless worktree with a base branch and current `HEAD`;
callers must not infer this state from the branch label alone.
_Avoid_: Treating `HEAD` as a branch name

### PR-able thread
A thread the app can open a pull request from. A thread is PR-able only
when it runs in an isolated worktree on a named branch; direct-mode and
branchless worktree threads are not PR-able yet. This single notion gates
background PR and commits-ahead polling. A branchless thread can still use
the Create PR entry point, but that flow must ask for a branch name and
create the branch before opening the pull request.

## Composer

### Composer mode
The mode the composer is in when the user creates a new thread, determining
whether the thread runs against the workspace's main checkout or against a
worktree, and whether that worktree is new or pre-existing. Three modes:
**Direct**, **New worktree**, **Existing worktree**. Once a thread has been
created, its mode is fixed for the life of the thread. The composer shows
the chosen mode in read-only form rather than as a fourth mode.

### Direct mode
Composer mode where the thread runs against the workspace's main checkout.
No isolation: file edits affect the user's primary working directory and
current branch. The default when a workspace is not a git repo.

### New worktree mode
Composer mode where the thread provisions a fresh git worktree from a
selected base branch without requiring the user to name a new branch first.
Used when the user wants isolation before deciding whether the work needs a
branch. Code identifier: `"worktree"`.

### Existing worktree mode
Composer mode where the thread attaches to a worktree that already exists.
Enables multiple threads to share one worktree, such as follow-up work on
the same branch without re-creating the directory. Existing worktree mode can
also attach to a branchless worktree.

### Composer session
The composer's per-thread state, treated as one value: draft text,
attachments, model, provider, reasoning level, composer mode,
access/permission mode, context window, orchestration mode, and provider-specific toggles. Owned
by one module whose interface is **snapshot** (save the outgoing thread's
session) and **restore** (install the incoming thread's session as a single
state transition). Switching threads is one restore; the editor update is an
implementation detail behind the seam. (Epic #649, slice #655.)

## Interaction modes and composer capabilities

Build and Plan remain mutually exclusive provider behaviors. The composer
presents Build as the default and Plan as an attachable capability. Users add
Plan from the plus menu or `/plan`; its chip can be removed before sending.

### Plan mode
A thread state where the agent produces a structured plan instead of
executing changes. The agent reasons, searches the codebase, drafts a plan
document, and presents it for the user to approve, revise, or reject.
Distinct from the Plan tab, which is a right-panel surface for viewing saved
plan documents.

### Build mode
The implicit default where the agent performs the work: editing files,
running tools, and making changes. Build does not occupy a composer chip.

### Goal capability
A removable composer capability for installing an objective immediately
before the next turn. Users attach it from the plus menu or `/goal`. An active
provider goal remains visible as a compact chip with its lifecycle details.

> **Codebase mismatch (rename pending).** The `AgentDefaultModeSchema`
> still exposes a deprecated third `"agent"` value that should be dropped;
> the product has only Plan and Build.

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
`max`, `xhigh`. Each provider maps the value to whatever its
SDK supports. Claude uses these directly (with `max` mapping to extended
thinking on supported models), Codex maps `none`/`minimal` to its own
presets, and Copilot honours the level per model capability. The Cursor
provider does not expose a reasoning-level selector; its models manage
reasoning internally.

### Orchestration mode
A per-thread setting with `standard` and `proactive` values. The composer
exposes proactive orchestration as a removable provider-specific capability:
**Ultra** for supported Codex models and **Ultracode** for supported Claude
models. Ultra maps to the Codex app-server's native `ultra` effort. Ultracode
enables Claude's session-scoped dynamic workflow orchestration. Neither value
is a reasoning tier.

## Chat threading

### Thread
A single chat conversation between a user and an AI agent. Threads belong to
workspaces and run against a provider. Distinct from a git branch even though
threads can be associated with a worktree.

### Thread conversation residency
The renderer's single client authority for a selected Thread's conversation.
It activates and revalidates the selected transcript, retains inactive
transcripts within a bounded cache, routes pagination and prefetch work, and
routes refresh work. `threadStore` projects validated AgentEvents into resident
Thread records. Server messages and narrative metadata remain durable data;
live Turn state remains client memory.

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

### Create branch
An [[Overview]] action that runs `git checkout -b <name>` in the active thread's
own working directory: it creates a branch at the current HEAD and switches the
thread onto it. **Same thread, same worktree, new branch** - no child thread, no
handoff; the thread's `branch` updates in place. Backed by a net-new
`git.createBranch` RPC (create + checkout); the app otherwise only checks out
*existing* branches.

Not to be confused with [[Fork]]. The two share one git primitive (a branch
pointer) in exactly one case, which is why they are easy to collapse, but they
are different actions: Create branch moves *this* thread onto a new branch right
here, whereas Fork spawns a *new* thread - and only its new-worktree variant
also creates a separate worktree; existing-worktree reuses that worktree's
branch, and new-local does no branch op at all. One line each:
Create branch = "this thread, new branch, here"; Fork = "a new thread, possibly
elsewhere."

## Chat lifecycle

### Setup gate
The Thread-owned decision that holds the first Turn while startup actions run
in a worktree. All startup actions exiting 0, or **Skip setup**, releases the
gate permanently for that Thread. A detected port never releases the gate.
_Avoid_: Setup status

### Setup attempt
One frozen, ordered sequence of startup actions for a Thread. The attempt
records its state and failed action id; the startup step holds action ids,
script hashes and run ids. Retry freezes the current configuration again,
skipping earlier exit-zero actions whose scripts have not changed. The gate
records whether the first Turn may start.
_Avoid_: Setup gate, Setup run status

### Startup action
A Project action marked **Run on startup**, run before the first Turn of a
Thread starting in a worktree. It is done only when its command exits 0.
A detected port never counts as completion. An action that keeps running
holds the gate until it exits or the user picks **Skip setup**, which leaves
the action running.

### Turn
One round of agent execution within a thread, bounded by a `TurnStarted`
event and a `TurnCompleted` event. A turn may be triggered by a user, provider,
or child and records its trigger provenance; provider- and child-triggered
turns do not require a user message. The agent then does whatever work it
needs (streaming thoughts, calling tools, reading files, dispatching
sub-agents) before producing its final response. Everything from the trigger
to the final agent response is the **same turn**, no matter how many
intermediate steps occurred. Costs, token counts, and tool-call sequences are
attributed per-turn, and several pieces of client-side state are scoped to the
current turn.

### Turn attempt
One provider dispatch within a Turn. A transient retry starts another attempt
but keeps the same Turn identity.
_Avoid_: Retry turn

### Tool call
A single tool invocation the agent makes during a turn (e.g. `Read`,
`Bash`, `Grep`, `Edit`). Each tool call has an input, a result, and a
completion status, and renders as one row in the narrative timeline.
Multiple tool calls can run in parallel within the same turn. All
user-visible tool calls are domain tool calls; internal SDK plumbing is
not.

### Sub-agent thread
A provider-native child conversation created from the current turn and
persisted as a normal Mcode thread. Sub-agent threads may run in parallel and
may themselves dispatch further sub-agents (nested). A sub-agent thread is
distinct from a [[Delegated thread]] created through [[Delegation]].

### Sub-agent call
The parent-turn tool or action that creates or contacts a [[Sub-agent thread]].
It remains part of the parent Turn. Each sub-agent call's events are attributed
to its parent via `parentToolCallId` so the narrative timeline can nest them
correctly. The phrase “use a sub-agent” means this provider-native behavior
when the Provider supports the chosen model. For another Provider, or a model
the native tool lacks, the agent uses [[Delegation]] instead.

Provider-native identity evidence links a sub-agent thread to its sub-agent
call. A name or a heuristic alone does not establish that relationship.

Sub-agent calls are **always shown** in the user's timeline; the user
should be able to tell when the agent has handed work to a sub-agent. From
the user's point of view, a sub-agent call is still part of the same turn as
the parent.

A sub-agent call counts as **running until its work finishes**, regardless of
how the provider signals dispatch. Some providers (Codex `spawnAgent`)
report the dispatch call itself as complete the moment the child is created;
the timeline must not show the sub-agent as done until the child actually
reports back. The sub-agent thread's own narration is not streamed into the
parent timeline; child detail separately shows its full timeline.

### Coordinator thread
A thread that assigns work to one or more delegated threads. Mcode notifies it
when a delegated task finishes, fails, or needs an answer, so it does not poll.
_Avoid_: Parent agent, orchestrator session

### Delegated thread
A normal Mcode thread created by a coordinator thread to perform an explicit
assignment. It remains visible and controllable as its own thread.
_Avoid_: Sub-agent thread, hidden child session

### Thread delegation
The durable assignment and relationship between a coordinator thread and a
delegated thread. It records which Thread and Turn created the assignment but
does not make the delegated thread part of the coordinator's Turn. The
delegated thread has its own lifecycle and survives the coordinator stopping or
disconnecting.
_Avoid_: Sub-agent call, conversation fork

### Delegation
The capability of handing one task to a [[Delegated thread]], reading the
task's status, and cancelling it. A Provider running inside an authenticated
Mcode Thread reaches Delegation through its session's `mcode` MCP server, the
same server that carries Browser automation. The Delegated thread works in
the Coordinator's checkout or in a new Worktree, and never runs with a broader
[[Permission mode]] than its Coordinator. A Thread cannot delegate to itself.
_Avoid_: Thread control, Internal thread control, sub-agent control, Provider
subagent API

### Thread launch
The creation of an ordinary top-level Thread, with an explicit Workspace
choice, for work the user wants as its own conversation. A launched Thread is
not a [[Delegated thread]], so Mcode does not notify its creator when it
finishes.
_Avoid_: Delegation, Thread control

### Paired external integration
An external integration paired with Mcode that finds, creates, reads, sends
work to, and stops Threads. It is limited to selected Projects, granted
operations, and ownership rules.
_Avoid_: Paired external thread control, unrestricted MCP access

### Message origin
The durable source of an inbound user-role Message. A Message comes from the
composer, another Thread, or a legacy row created before origin was recorded.
A Thread origin identifies the source Thread, Turn, and Provider. It does not
label the sender as human or agent.
_Avoid_: Message author type

### Text delta
A streaming text chunk emitted by the provider as the agent types its
output. Many text deltas accumulate during a turn. At emission time the
deltas are unclassified — the system does not yet know whether they will
become part of the final response or get grouped as preamble narration.
Classification is resolved later by the `AssistantMessageBoundary` signal.

### Reasoning block
The model's own thinking, as distinct from the text it says to the user.
Providers stream it as `reasoningDelta` events, never as text deltas. Codex
reasoning items carry a native id, and the item's completion closes the
block. Cursor and Devin thought chunks carry no id. The timeline shows a
reasoning block as a collapsed **Thought** row that the user can open to
read. Claude `thinking` content blocks are not yet surfaced.

A reasoning block is never narration and never the final response. It does
not merge with neighbouring narration and does not supply the live activity
label. It persists as a `thought_segments` row with `kind = 'reasoning'`.
Rows without a kind are narration.

### Narration segment
A contiguous group of text deltas the agent emitted **before** a tool call
within a turn — the agent's narration of what it is about to do. Distinct
from the final response (text deltas emitted *after* all tool calls have
resolved) and distinct from a reasoning block (the model's thinking, which
arrives as `reasoningDelta`). Classification happens at the `AssistantMessageBoundary`
event: a `stop_reason` of `tool_use` closes the buffered deltas as a
narration segment; `end_turn` / `stop_sequence` / `max_tokens` / `refusal`
reclassifies them as final-response text instead.

Providers without a stop-reason concept (Codex) classify by **retroactive
promotion**: every assistant message streams as narration while the turn
runs, and the last one is promoted to final response when the turn ends.
The boundary signal is the same either way; only the moment of certainty
differs.

> **Codebase mismatch (rename pending).** The code currently calls this
> concept `ThoughtSegment` (table: `thought_segments`). The same type and
> table also hold reasoning blocks, told apart by `kind`. A follow-up
> rename to `NarrationSegment` is planned.

### Final response
The text the agent produces after all tool calls in a turn have resolved,
intended as the user-facing reply for that turn. Identified by the SDK's
terminal `stop_reason` (`end_turn`, `stop_sequence`, `max_tokens`,
`refusal`) and persisted as the assistant message's `content`. Distinct
from narration segments (which are persisted to a separate table) and from
reasoning blocks.

### Streaming checkpoint
A server-owned durable record of user-visible output accepted during an
unfinished turn. Distinct from a finalized Message, which represents the
completed conversation record.

### Message
A persisted unit of conversation in a thread. Each message has a **role**
(`user`, `assistant`, or `system`), a sequence number, and an optional
`is_internal` flag that excludes it from user-visible queries. User and
assistant messages drive the normal turn flow. System-role messages anchor
synthetic context — today used for the handoff document at sequence 1 in
a child thread and for the "Context compacted" marker placed after
compaction runs. Messages are what `forked_from_message_id` points to and
what hidden messages exclude themselves from in user-visible queries.

### Conversation page
The unit a thread's visible conversation loads in: one pagination window of
messages together with their narrative (tool calls, narration segments, hook
executions), served by a single request whose cost is a fixed number of
queries regardless of how many turns the page spans. Loading a thread means
loading its latest conversation page; paging back loads older pages through
the same interface. (Epic #649, slices #650/#651.)

### Streaming vs settled rendering
Two adapters at one rendering seam for agent text. While text deltas are
arriving, a block renders through the **streaming adapter**: only the
paragraphs a blank line or closing fence has finished, as markdown re-parsed
once per finished paragraph, with the typing cursor after them. Once the block
settles (its deltas stop, classification resolved), it renders through the
**settled adapter**: the full text as markdown with code highlighting. The
user sees the same final result; only the cost during streaming differs.
(Epic #649, slice #658.)

### Turn outcome
How a turn ended, as one of four mutually-exclusive states:
**completed** (the agent finished its work normally), **cancelled** (the user,
or Mcode itself, explicitly stopped the turn), **interrupted** (infrastructure
or a process disappeared before a terminal outcome, or a provider usage limit
paused work the user can resume once it resets), or **errored** (a known
terminal provider or turn failure). Users see these as Stopped, Interrupted
and Failed; a cancelled turn records whether the user or Mcode stopped it.

### Thread attention
Server facts combining a live wait, the last settled turn outcome, and a
seen marker. The marker is an acknowledged server message sequence and
the server time it advanced. A turn ends at its newest persisted message,
including its user prompt when no assistant output was saved. A focused,
visible client acknowledges only server-confirmed messages it has rendered,
up to the newest settled message or the last turn's ending sequence.

### Needs you
A live condition waiting for the user's input, such as an approval.
Viewing the thread acknowledges settled outcomes but does not resolve
the pending request.

### Recovery incident
The exact set of active turns that one backend restart interrupted. The server
creates the incident at startup and stamps each affected turn with its
identity, as provenance only. Clients do not read incidents: each interrupted
turn shows its own Interrupted notice, with Resume on the thread's latest turn.
_Avoid_: Interrupted-turn history, recovery error list

### Terminal proof
Authoritative provider or system evidence that confirms one [[Turn outcome]].
A final-looking assistant response is not terminal proof.
_Avoid_: Final response

### Empty turn (recordable activity)
A turn that produced nothing worth keeping: no tool call, no assistant body,
no narration segment, and no hook. **Recordable activity** is the named
predicate for the inverse — a turn has recordable activity when any one of
those contributors is present. A turn with no recordable activity should
leave no assistant row, so the thread is not cluttered with hollow entries.

> **Behaviour pending.** Today a turn that produces nothing recordable can
> still write a hollow assistant row, because the row is committed on a
> separate event before anything decides the turn was empty.

### Transient failure (auto-retry)
A turn failure that a second attempt would plausibly clear — a stale pooled
session, a subprocess spawn race, a brief network blip — as distinct from a
fatal failure that will recur. A transient failure prioritizes provider-native
same-turn recovery, with a replacement turn only as an explicit fallback when
same-turn recovery is unavailable. Which signatures count as transient is a
small explicit allowlist, not a heuristic.

> **Behaviour pending.** Today every turn failure is treated as terminal and
> costs a manual re-send, transient or not.

### Turn revert
Puts the files a finished turn changed back to their state before that turn,
using the turn's snapshot. It writes the working tree only; the index and
commits are untouched. It is the same for every provider, because it reads
Mcode's own snapshots and file attribution, not the provider's history. Files
a turn changed through commands cannot be attributed and are not reverted.
Edits a later turn or the user made to the same files are removed too, and the
confirm says so before anything is written.
_Avoid_: rollback, undo turn, checkpoint restore

### Revert receipt
The timeline row a turn revert leaves where it happened, such as "Reverted
Turn 3 · 7 files". It offers Undo until the revert is undone or its recovery
material expires. An undo leaves its own receipt, and a revert interrupted by
a crash leaves a receipt that says which files were put back.
_Avoid_: revert message, revert toast

## Handoff

### Handoff
A deterministic, budgeted selection of stored conversation history delivered
with the next turn. Handoff v2 supports three kinds: **switch** continues the
same thread with another provider, **fork** starts a child from a chosen
message, and **recovery** seeds a replacement session. Selection does not call
the outgoing provider or change the saved conversation.

### Scoped pre-grant
A one-shot permission to read one exact file during one turn, such as the plan
file supplied to an implementation turn. Other reads follow the thread's
permission mode. Handoff v2 delivers history inline and needs no file grant.

## Budgeted transcript selection

History retains whole user and assistant messages and compact records of file
changes and commands. Selection prioritizes the latest user and assistant
messages, then the first user message, then recent history. Selected items stay
in conversation order and retain their role, provider, and sequence. The
preamble identifies omitted sequences. Reasoning, tool-output bodies, and
attachment contents are not replayed.

The budget reserves room for the target context window, the new message and
attachments, and the response. It conservatively counts one token per UTF-8
byte, applies the configured caps, and also respects the target's input
character limit. If even the preamble cannot fit, the operation fails with
`handoff_budget_exhausted`. The user's new message is never shortened to
make room. See [ADR 0031](docs/adr/0031-handoff-v2-budgeted-transcript-selection.md)
and the [v2 implementation](apps/server/src/features/handoff/v2/).

## Handoff delivery

Switch, fork, and recovery prepend history to the next provider input inside a
fence with a fresh random boundary. The preamble distinguishes historical text
from the user's new request. The timeline keeps the user's original text.

The same history is saved for inspection at
`<MCODE_DATA_DIR>/threads/<threadId>/handoffs/<ulid>/handoff.md`. Its
`schemaVersion: 2` frontmatter records the kind, providers, covered and
omitted sequences, budget, and dropped options. This is an audit copy, not a
file the provider must read. See [handoff constraints](docs/internals/conversation/chat-fork-handoff.md).

## Provider capabilities

### Native session continuity
Each provider keeps its own native session identity and last-seen message
sequence on the thread. Returning to a provider can resume that session and
replay only the missed messages. A fork always starts a fresh child session.

### Per-turn input cap
The maximum input characters a provider accepts per turn, declared as
`maxInputCharactersPerTurn`. Handoff v2 also bounds Codex inline input to
14,000 characters and uses the smaller limit when selecting history.

### Goal support
The ability to set, inspect, and clear a standing **goal**: a thread-scoped
completion condition exposed through `/goal`. A goal belongs to the thread's
provider runtime rather than a single chat message. Mcode may render
transcript receipts for goal events, but the active goal state is provider
metadata.

Goal support is a **capability a provider has**, not a provider it is: a
provider either implements Mcode's goal capability, exposes a native goal API
that Mcode can bridge, or lacks goal support. On a provider that lacks it,
`/goal` passes through to the model as plain text so the model still sees what
the user typed.

## Server runtime

### Thread-scoped push
The routing rule for server-pushed events: a client declares which threads
it is watching, and an event carrying a thread id is delivered only to
clients subscribed to that thread. Events without a thread id remain
broadcast to every client. A window's bounded watch set contains its selected
thread and any threads with running agents, which keeps their live layers warm
during a switch. Unrelated idle threads remain excluded. Payload validation at
this seam has two adapters: validating (dev, logs schema drift) and pass-through
(production). (Epic #649, slices #656/#657.)

### Grace period
The countdown between the last client session disconnecting and the server
shutting itself down. It only starts when the server is not busy; a busy
server never begins the countdown, no matter how long clients stay away.
A new session connecting cancels it. Distinct from session-runtime idle
eviction (which retires pooled provider CLI sessions, not the server).

### Busy (server)
The server is busy while any agent turn is in flight or any integrated
terminal is running. Busy suppresses the grace period and is the condition
under which the desktop app holds a power-save blocker so the machine does
not suspend mid-work. Connected-but-idle clients do not make the server
busy.

### Git executor
The single module that owns running git as a child process on the server:
asynchronous execution, queueing per repository, timeouts, and caching of
repeated repository-discovery results. Every git caller — file watching,
workspace enrichment, worktree cleanup, branch listing — goes through it,
so a slow git command never blocks the event loop. In tests, a fake executor
adapter stands in for real process spawns. (Epic #649, slice #659.)

### Snapshot dirtiness gate
The short-circuit inside turn-snapshot capture: when the working tree is
clean, the snapshot ref resolves from HEAD with one cheap status check
instead of staging the whole tree; when dirty, capture behaves as before.
Turn views and the Cumulative comparison are unaffected — only the cost of
capturing on a clean tree changes. (Epic #649, slice #660.)

## Internal / hidden state

### Internal message
A message persisted with `is_internal: 1`. Excluded from the user-visible
timeline and from queries by default. Used for the synthetic system message
anchoring a handoff at sequence 1 in a child thread.

### Provenance metadata
The `handoff.json` sidecar accompanying every `handoff.md`. Records which
path produced the doc, when, against which provider, with which classified
error (if any). Used by the View doc dialog and by the fallback banner copy.

## Related but distinct

### Cross-provider switch
A send to a different provider continues the same idle thread with its existing
messages and worktree. Handoff v2 supplies a budgeted, fenced history preamble
without calling the outgoing provider. The timeline shows the user's original
message.

The thread keeps its active provider, model, and session until the incoming
provider accepts the turn. Each provider's native session remains recorded.
Switching back resumes the returning provider and sends the delta after its
last-seen sequence. When the gap exceeds `MAX_DELTA_TURNS` or native resume
fails, a fresh session receives a budgeted selection of the full history.
Unsupported composer options are dropped and recorded in the
`schemaVersion: 2` audit with kind `switch`. Fork and recovery use the
same selection and delivery primitive with their own kinds.

### Compaction
A separate mechanism that summarizes a thread's older turns into a single
compact summary stored on the thread itself, used to keep long threads
within their own provider's context window. Distinct from a handoff, which
selects stored messages verbatim and never reads the compact summary.

## Pull request review

### Pull request inbox
The workspace-level surface that gathers pull requests the user authored or was
asked to review across connected repositories. It is independent of the active
thread and groups review work by the user's relationship to each pull request.
The All relationship view presents Review requested, Previously reviewed, and
Authored as one ordered set of subsections. Fresh loaded rows are reused across
covered relationship views and local search or filters refine that snapshot
without replacing the inbox with a loading state.
_Avoid_: PR tab, Review tab

### Pull request review
The read-and-respond workflow for one remote pull request: inspect its summary,
conversation, checks, and code changes, then optionally submit a review. It does
not require a local thread or worktree.
_Avoid_: Checkout

### Remote effect
The named GitHub change a Pull request mutation would make: post an issue
comment, submit a review, change readiness, close, or merge. The interface shows
the Remote effect before confirmation. Pull request mutation names the confirmed
attempt; Remote effect names what that attempt changes.
_Avoid_: Action, when it hides what would change

### Review draft
A session-local inline comment, thread reply, or overall review body tied to one
base and head snapshot. A Review draft does not exist on GitHub until the user
confirms Submit review. It becomes outdated, rather than moving silently, when
the Change stack changes. A failed, conflicted, or rate-limited submission keeps
the draft available for correction or retry.
_Avoid_: Pending review, which is a provider-side object used only during submission

### Change stack
The complete set of changes proposed by a pull request, viewed as one reviewable
unit across its summary, timeline, checks, comments, commits, and file diffs.
_Avoid_: Diff, when referring to the whole pull request

### Review worktree
An isolated local worktree created from a pull request's head branch so the user
can ask an agent to inspect or modify the proposed changes. It belongs to a new
thread and does not alter the source pull request until the user explicitly
commits, pushes, comments, reviews, or merges.
_Avoid_: Checkout, pull into a worktree

### Review task
The thread created to work on a pull request's Review worktree. It carries the
pull request as its starting context and follows the normal thread lifecycle
after creation.
_Avoid_: Pull request thread

### Review Change Stack
The local continuation action that creates or reuses a Review worktree and
Review task for a pull request. It may fetch refs and update local Git and Mcode
state, but it never posts, reviews, closes, merges, commits, or pushes.
_Avoid_: Checkout, Submit review

### Pull request mutation
An explicit remote write against one pull request: post a comment, submit a
review, change draft or ready state, close, or merge. Each mutation names its
effect before confirmation and rechecks current GitHub state before writing.
Reading, refreshing, and Review task creation are not mutations.
_Avoid_: Action, when the remote effect is the important distinction

### Mutation outcome unknown
A pull request mutation result used when GitHub may have accepted a write but
the response did not establish the outcome. The user must refresh remote state
before choosing another effect. Retrying the same attempt keeps its identity.
_Avoid_: Failed, which states that the write did not happen

## Thread overview

### Overview
The card that recaps the active thread's working context (its changes, current
branch, and pull-request state) and hosts the git actions for that thread
(Commit…, Create PR), modelled on Codex's "Environment" panel. Its rows
group into four sections: lane, activity, terminals, and summary. Code symbol:
`ThreadOverview`.

**Docked or overlay.** The card docks in the chat canvas's top-right corner by
default, and the timeline and composer make room for it, whenever the canvas is
wide enough and the right panel is closed. Otherwise the header button opens it
as an overlay at the same corner, which closes on Escape or an outside press.
Closing a docked card with the header button is remembered per thread for the
session.

**Thread-scoped.** The Overview lives in the chat header, which renders only
when a thread is active. With no thread open there is no Overview; the
workspace-root view of changes and branches stays the Review tab's job.

The Overview offers two ways to take the thread further, split by what each does
to *this* thread. Both anchor at the thread tail (not a picked message):

When a thread has a plan, the Overview shows a plan row with the plan title
and the latest version number. Clicking it opens the Plan tab. Older versions
stay in the Plan tab.

For branchless worktrees, the Overview shows the checkout as `detached at <hash>`
(or `detached from <base>` before the hash is read) and makes Create branch the next git action. After Create
branch succeeds, the Overview shows the named branch like any other worktree
thread.

**[[Fork]]** - spawns a *new* child thread; this thread stays untouched. Three
targets:

- **New worktree** - child thread in New-worktree mode + handoff.
- **Existing worktree** - child thread in Existing-worktree mode + handoff.
- **New local thread** - child thread in Direct mode + handoff.

**Switch provider** - a [[cross-provider switch]]: *this same thread* continues
(id, history, worktree unchanged) and only the provider driving it swaps. The
incoming provider gets a handoff built from the stored history without calling
the outgoing one. Swap-back is the same process.

Handoff is always-on for both - it is the mechanism, not a standalone menu item.
The split keeps "spawn a copy" (Fork) visually distinct from "change this
thread's driver" (Switch provider); the two can re-merge into one list later if
the distinction does not earn its place.

The Overview is a status-and-actions card.

### Recap
A short AI-generated one-line "what you're working on" for the active thread,
shown at the top of the [[Overview]]. Produced by a stateless server RPC (our
utility model) and cached **in memory per thread, never persisted** (resets on
restart). Generation is deliberately frugal: user-triggered from the row, or
automatic only when the user re-orients to a stale thread. Re-orientation means
returning to the app, switching back to a thread, or opening the Overview. A
thread is stale for Recap when its last completed turn is old enough (default:
about five minutes), the conversation signature changed, and no turn is
running. See ADR-0013.

The Recap summarizes **conversational intent**. [[Overview]] is the **surface**
that hosts the Recap, not the recap text itself.

### Re-orientation
The moment a user returns to a thread and needs to remember what it is about.
In Mcode this is broader than terminal focus: it includes the app regaining
focus, the user switching back to a thread, and opening the thread's
[[Overview]]. Recap auto-generation keys off re-orientation rather than a timer
that runs while the user is already watching the thread.

## Right panel

### Right panel
The surface docked to the right of the chat, hosting typed tabs such as Browser,
Terminal, Review, Plan, and Files. Visibility, width, active tab, and open-tab
order belong to the thread. A thread without its own saved panel state inherits
the workspace fallback and gets its own record when it changes the panel.
The fallback also owns the panel when no thread is active. Each tab type sets
its content scope and availability. Browser and Terminal can use the workspace
root without a thread; Plan requires a thread.

### Tab availability
The rule set governing which tools a user can open at a given moment. The rail
lists each open tool once: Browser, Terminal, Review, Plan, and Files. The set
of **creatable** tools is filtered by **scope** (tools needing a thread are
dropped when no thread is active) and by whether the tool is already open.
When exactly one tool is creatable, the add affordance opens it directly
instead of showing a menu; when none are, the add affordance is hidden. The
empty panel and the add menu present this same creatable set. Tools share one
creation-ordered sequence; the user can reorder any tool by pointer drag or
keyboard movement without changing its content or the panel's size. Each
thread preserves its own order. The workspace-level panel used with no active
thread preserves a separate order.

Terminal and Browser hold several items, shown as row-1 tabs inside the tool
with a round + that adds one. Terminal allows eight **terminal records** per
terminal scope, counting shells and Project Action runs alike; at that limit
its + is disabled and says why. See ADR-0026.

### Plan tab
The right-panel tab that shows a thread's plan as a read-only document. Its
header names the viewed version, such as "v2 Codex", and lists every version.
The latest version shows unless the user picks an older one. It is
thread-only and contains the plan artifact itself, not the agent's live task
list.
_Avoid_: Scope tab

### Task row
The row in the composer tray, docked on top of the composer, that shows the
agent's current task list for the active thread. Collapsed, it shows the list
title, one segment per task (done, current, or pending), and a settled-over-total
count, where settled means completed or cancelled. The title is the title of the
plan version the list's turn implemented, else "Tasks"; it is never the thread
title. Expanding it grows the tray upward, so the composer does not move. It
shows only parent-agent tasks; sub-agent task groups stay with the narrative
timeline where delegated work is attributed. When the user sends a new turn, a
fully settled list clears; an unsettled list stays until the new turn writes
its own parent tasks, and clears if that turn ends without doing so. It is
separate from the Plan tab.
_Avoid_: Task bubble, Scope task list

### Terminal tab
A row-1 tab inside the Terminal tool that represents one **terminal record**
in the active **terminal scope** (a thread when one is active, otherwise the
workspace root): a **shell session** or an **action terminal**. Selecting a
Terminal tab shows only that record. Closing a Terminal tab terminates the
entire process tree rooted at its shell, after asking when the user's
`confirmOnKill` setting says so: by default only while the shell has child
processes, and never for a shell that already exited. If the process tree
cannot be inspected, it asks. A close that fails keeps the tab and reports
it. Closing the last Terminal tab closes the Terminal tool. Closing the
Terminal tool from the rail hides it without
stopping its records. When a shell exits on its own, its Terminal tab keeps
the exit status and retained output until the user closes it or deletes its
scope.

### Action terminal

A terminal that runs a Project Action's resolved script, then opens a
fresh interactive shell in the same folder. The terminal identity and replay
survive the command's exit and subsequent runs. Unlike typing the command into
the shell, the script is not in shell history, and its working-folder and
environment changes do not carry into the shell that follows.

### Cleanup action
A Project Action marked **Run on cleanup**. Before Mcode removes a Thread's
worktree, it runs each cleanup action from that worktree in list order, without
a terminal, for at most two minutes each. A failing action is logged and does
not keep the worktree. An In repo action that was never approved is skipped.
Retained worktrees and Direct threads run no cleanup actions.
_Avoid_: Teardown script, cleanup hook

### Terminal scope
The thread, workspace, or home scope a shell session runs against. When a
thread is active, shells open in that thread's working directory (worktree or
workspace root per composer mode). With no thread, the scope is the
workspace and shells open at the workspace root. The home scope belongs to no
project: provider sign-in opens its shell in the user's home directory and
shows it in a Sign in dialog, with or without an open project. Closing that
dialog kills the shell and re-checks provider status.
_Avoid_: Using "thread id" alone when the scope may be a workspace or home.

### Shell session
A running shell process (e.g. PowerShell, bash) tied to one terminal scope.
Survives thread switches and terminal-tab hides; the process keeps running
until the user kills it or closes its Terminal tab. Closing it terminates the
shell and every descendant process that it started. Output keeps draining
into server-side scrollback even when no terminal view is mounted.
_Avoid_: PTY (implementation term), terminal instance (ambiguous with the view).

### Active shell
The shell session represented by the selected Terminal tab. At most one
terminal view exists in the app. Its view may stay warm while its Terminal tab
or the right panel is hidden; all other shells run without a view.
_Avoid_: Mounting a view for every open shell (background shells stay
server-side only).

### Terminal view
The in-app rendering of one shell session's output in the Terminal tool.
Only the **active shell** has a view; others keep running without one. Hiding
the terminal surface preserves that view for a fast return. Switching shells
replaces it. A returning view follows the latest output when the user was at
the tail, or restores the same retained content when the user was reading
history. Restoration preserves terminal text and ANSI styling without exposing
control-sequence fragments as visible characters.
_Avoid_: xterm (implementation term), conflating with shell session.

### Scrollback
How many lines of shell output are retained for a shell session, set by
`terminal.scrollback`. The same limit applies on the server (for replay when
the terminal view remounts) and in the mounted terminal view. Output beyond
the limit is dropped oldest-first.
_Avoid_: Treating scrollback as a client-only display setting.

### Review tab
The right-panel tab that shows code changes. **Dual-scope**: its
git-working-tree views (Unstaged, Staged, Commit, Branch) read the
**workspace root** and need no thread; its turn views (Turn, All turns) need
a thread. Each view renders exactly one diff; there is no eager render of
every turn's diff. A names-only view menu picks the view. A view that cannot
load stays in the menu, dimmed with its reason, and the default view is
never one of those.

### Commit sheet
The sheet over the Review tab where the user picks uncommitted files, edits a
generated message, and commits, optionally pushing. A floating Commit button
opens it while the checkout is dirty, and the overview's **Commit…** row opens
Review with it. It always lists every uncommitted file, whatever view Review
shows. Tracked files start checked and untracked files start unchecked. One
commit request keeps its `requestId` until the server answers, so a dropped
connection resends it instead of committing twice. A rejection or a hook
failure leaves the checked files and the message in place.
_Avoid_: Commit dialog, Commit-or-push (the old action that asked the agent to commit)

### Files tab
The right-panel tool that shows every project file in the panel scope: the
thread's checkout when a thread is active, otherwise the workspace root. Each
open file is a row-1 tab; closing the last one shows the tree. The tree docks
beside the code when both fit and otherwise replaces it in the body. Files
changed since HEAD carry M or A marks, folders containing them carry a dot, and
changed lines carry a bar. **Go to file** (Ctrl/Cmd+P) fuzzy-finds a path;
Enter opens it, Ctrl/Cmd+Enter opens it beside the current tab without
switching. The view is read-only; Open in editor hands the file to the user's
editor.
_Avoid_: Files navigator (the changed-files tree inside Review)

### Files navigator
The collapsible file-tree surface within Review, labelled **Files** in the UI.
When sourced from a [[Comparison]], it lists only that comparison's changed
files and navigates within the same diff. The Files navigator is distinct from
the Comparison and its diff, and from the [[Files tab]], which lists every
project file.
_Avoid_: Worktree files, Changed files (names for a source, not the surface)

### Comparison
What a Review view *is*: a **base** (before) and a **compare** side (after)
that resolve to exactly one diff. Some comparisons have **fixed** operands the
user cannot change (Unstaged = index→worktree; Staged = HEAD→index); others
have **picked** operands the user chooses through a picker that still
resolves to a single diff, never N diffs at once. The picked comparisons
are **Branch** (`compare → base`: both sides pickable from local or origin
refs, sent as `base...compare`; local `main` and `origin/main` are separate
choices; see ADR-0028), **Commit** (one commit from the commits since the
fork, searched on the server; default is the latest commit), and the turn
**picker** (one turn's diff).

### Turn view
One turn's diff. Its operand either **follows latest**, the default, which
moves to each newer turn as it appears, or **pins** one turn. The turn picker
lists the thread's turns that changed files plus the latest turn; choosing
the newest row follows latest, and choosing an older row pins it. The change
summary on a transcript turn opens this view too: the latest turn's summary
follows latest, and an older turn's summary pins that turn.

### Cumulative
A thread's **net effect since it started**, committed *and* uncommitted, as
one diff (the turn-snapshot before the thread's first turn → the snapshot
after its last). A different **axis** from Branch: Cumulative is measured on
the turn-snapshot timeline and includes uncommitted work, whereas Branch is
measured between git refs and shows committed history only. The two coincide
only when the thread committed everything and its base has not moved.
_Avoid_: "net diff versus base" (that phrasing collides with Branch).

**All turns** is the user-facing label for this view; the view menu
says _All turns_, while the code, the view id (`cumulative`), and this
glossary keep the name _Cumulative_, mirroring the _Project_ (UI) /
_Workspace_ (code) split.

### Since you looked
The [[Cumulative]] diff of only the turns that settled after this visit's
seen baseline: the [[Thread attention]] seen marker as it stood when the
visit first advanced it. Whole turns are kept, so a turn retried after the
baseline includes its earlier attempts. A live turn is left out until it
settles. The view is available only when such a turn changed files, is never
the default view, and resets when the user leaves the thread.
_Avoid_: Unread changes, new since last visit (the baseline is per visit, not per user).

## Open-in app

### Open-in app
An external application mcode can open the current working directory in: an
**editor** (VS Code, Visual Studio, Cursor, Zed), a **terminal** (Windows
Terminal, Git Bash, WSL), a **git GUI** (GitHub Desktop), or the system
**File Explorer**. Distinct from the in-app right-panel tabs — an open-in
app launches a separate program against the directory, it does not embed.

### Default open-in app
The open-in app that the dedicated shortcut and the split button's primary
action open without the user choosing from the menu. Resolved per thread in
three tiers: a **thread override** (the app last picked from *that thread's*
menu, sticky to the thread) wins; otherwise the **global default** from user
settings; otherwise an **auto-resolution** to the highest-priority installed
editor, falling back to File Explorer. Choosing an app from a thread's menu
sets the thread override only; it never changes the global default, which is
configured in Settings.

## In-app browser preview

### Preview
The embedded in-app browser panel that renders a web URL or a local file.
It is the **Browser** tab type within the workspace-global right panel.
Distinct from opening the page in the user's external browser.

### Browser automation
Provider-neutral agent control of a live Preview tab. Browser automation uses
the same page the user can see, so agent actions, page state, and debugging
evidence stay attached to one shared browser session.
Providers reach the typed, scoped Browser v2 tools through their session's
`mcode` MCP server. It is the only supported automation path.
_Avoid_: a hidden agent-only browser

### Browser automation host
The running Mcode client that makes its live Preview tabs available for Browser
automation. A host advertises only tabs that it currently owns and can stop
advertising a tab when that page is replaced, discarded, or closed.
_Avoid_: treating a saved Preview tab record as a live automation target

The host routes every Browser v2 command through one client-side
`BrowserSessionDriver`. The driver selects the web or Electron runtime adapter;
the adapter owns runtime execution while the Electron kernel retains Chromium
and CDP mechanics. `BrowserTargetRegistry` owns logical target identity outside
React. React attaches or detaches runtime handles and projects registry state;
ordinary remounts do not release a logical target. Authoritative tab, thread,
and workspace deletion releases the record. The broker remains responsible for
credentials, routing, cancellation, capacity, and liveness, while MCP remains
schema and authority translation.

### Browser controller
The current actor with control of a Preview tab: the user, an agent, or neither.
Direct user input, or the Take control pill, takes control from the agent and
stops the active Browser automation action. The user then holds the thread's
Browser until they press Hand back; sending a message does not release it.
_Avoid_: allowing agent input to compete with user input

### Browser automation snapshot
A bounded, point-in-time description of a Preview tab for an agent. It can
include visible text, interactive elements, accessibility information,
diagnostic entries, recent actions, and a screenshot. Truncation is part of the
snapshot so the agent can tell when it received a partial view.
_Avoid_: treating a snapshot as a permanent page model

### Browser diagnostic entry
A bounded console or network observation captured from a live Preview tab for
agent debugging. Sensitive URL details are removed before the entry crosses the
Preview boundary.
_Avoid_: exposing raw browser debugging protocol traffic to a provider

### Preview annotation
A saved note anchored to part of the Preview page. Every new annotation carries
note text. The annotation bubble is the editor, and an unsaved bubble is not a
Preview annotation yet. Its delete control belongs inside the opened annotation
bubble so passive markers are
harder to remove accidentally.
_Avoid_: treating annotation-bubble styling as the requested page change

### Draft annotation
An unsaved annotation bubble on the Preview page. It has no display number,
does not belong to the Preview annotation set, and can become a Preview
annotation once it has note text.
_Avoid_: treating draft annotations as sendable annotations

### Annotation display number
The number on a Preview annotation marker. It counts from 1 on each page in
creation order, so a page's markers never skip a number because of notes on
other pages. Editing an annotation does not move it. The Annotation bundle
carries that per-page number, so two pages can each hold a note 1. A legacy v1
bundle keeps the thread-wide numbers it was sent with.
_Avoid_: treating the display number as the annotation identity

### Preview annotation snapshot
One marked screenshot per annotated page, not per annotation. It is the page's
viewport as the user last saw it with every note on that page drawn on it, each
box carrying that note's number. The Browser redraws it in the renderer after a
note is added, edited or removed, so a removed note's number leaves the image
without another capture. A page keeps one snapshot, replaced whenever the page
gets a new note. Several notes on one page share it.
_Avoid_: capturing a separate screenshot for each annotation

### Preview page identity
The normalized page target used to decide where Preview annotations appear.
It ignores fragments, query order, and tracking noise while still separating
distinct page states such as different product or route parameters.
_Avoid_: exact raw URL matching for annotation visibility

### Preview annotation set
The saved Preview annotations waiting to be sent with the next user message.
Each annotation is displayed only on its saved Preview page identity; the set
remains available when Preview navigates elsewhere, Design mode exits, or the
page refreshes. The Preview header can discard annotations for the current page
identity. The set clears after the annotated message sends successfully, and
returns when that send fails, so a failed send never loses a note.
_Avoid_: clearing saved annotations before send success

### Annotation bundle
The structured set of notes one message carries, with one Preview annotation
snapshot per annotated page. In the composer it is the Browser notes tile, a
single stack that shows the page annotated last and a stack edge when several
pages have notes. Hovering the tile lists the notes grouped by page. A note
opens its page in the Browser, and hovering a row reveals its remove control.
Removing a note renumbers its page. Removing the tile drops every Browser note
and leaves Review and Files comments in the bundle alone. A bundle written
before page snapshots existed (schema version 1) still reads and renders from
history. There is no user-facing count limit for annotations in the bundle.
_Avoid_: showing each annotation snapshot as a separate composer attachment

### Annotation payload
The structured information sent to the agent for an Annotation bundle. It pairs
each Preview annotation with its display number, page context, target context,
note text and snapshot. Bounds are in document pixels, and the page snapshot rides beside it. Historic messages may carry a generated change summary
and style edits instead of note text.
_Avoid_: relying on screenshots alone for annotation intent

### Preview annotation mode
The Preview state where the user creates and edits Preview annotations. The UI
labels this state **Design** and turns the toolbar button amber; the product
concept is annotation because the notes are sent as page-specific change
requests. Design needs a thread to attach notes to, so a Browser without one
disables the button.

Hovering shows an amber box and a `tag · label` tip on the element under the
pointer. A click opens the note bubble under that element. Enter saves, mod+Enter
saves and sends, and Esc closes the bubble. A second Esc leaves Design. Saving
re-arms the picker once, so the user can keep annotating without leaving the
mode. Saved notes stay on the live page as a dim amber outline with a numbered
marker, and clicking a marker reopens its note. Markers are anchored to the
element in page coordinates, so they follow scrolling and show only on the page
they were made on. The normal browser header stays in place throughout.
_Avoid_: treating Design as a separate interaction mode

### Preview rendering host
The BrowserSurfaceHost owns each preview tab's live Chromium page. Electron
uses renderer-owned `webview` elements. The web runtime uses iframes. There is
no runtime host setting or compatibility fallback.

### Preview tab
One navigable page within the preview, belonging to a thread. A thread can
hold several tabs; exactly one is the active tab at a time.

### Active tab
The preview tab currently shown to the user. The other tabs in the thread
are background tabs.

### Panel visibility
Whether the preview panel is currently in view. When the user collapses or
navigates away from the preview, the panel is **hidden** even though its
tabs still exist. Visibility is distinct from which tab is active: the active
tab of a hidden panel is not on screen.

### Warm tab
A preview tab that holds a live page in memory and is instant to view.
Background warm tabs keep their page intact (scroll position, form input)
but are throttled while not in view.

### Cold tab (discarded tab)
A preview tab reduced to placeholder information - its title, URL, and
favicon - with its in-memory page released to reclaim memory. Reopening a
cold tab reloads the page from scratch, so scroll position and form input do
not survive. This is the same idea modern browsers call a *discarded* or
*sleeping* tab; Mcode uses **cold** / **discarded**, never "disabled".

### Tab discard
Demoting a warm tab to cold to save memory. The inverse - showing a cold tab
again - is **re-warming**, which reloads the page. The active tab is never
discarded while the panel is visible; once the panel is hidden it may be
discarded like any other tab.

### Preview page state
The status of a preview tab's page from the user's point of view:
**loading**, **loaded**, **error**, or **discarded**. Exactly one applies at
a time.

### Preview error state
The page state shown when a tab fails to display a live page: the site is
unreachable (network or TLS failure), the server returned an HTTP error
(404, 500, and similar), the local file is missing, or the page crashed. The
user is offered recovery actions (retry, edit the address, go back, open
externally) rather than a raw browser error page.

## App-side extensibility

Three end-user-facing extensibility surfaces inside the running Mcode app.
Each shares a name with a dev-tooling concept used by contributors who
develop Mcode itself (documented in `AGENTS.md`); the entries here refer
to the runtime, user-facing version only.

### @ mention
A composer reference inserted from the `@` mention picker. Mentions are typed
and rendered as highlighted references in the composer and user transcript: a
file mention references a workspace file, while a sub-agent mention requests a
provider agent for part of the turn.
_Avoid_: treating every `@...` string as a file path.

### Selectable provider agent
A provider-defined agent offered through the `@` mention picker. The list may
combine provider-returned registrations with standalone agent definitions,
but Mcode does not invent provider-internal built-ins that the provider did not
return. Suggestion metadata helps the user choose an agent; the provider remains
authoritative when resolving the selected agent name.
_Avoid_: Sub-agent run, built-in agent

### Provider catalog entry
An invocable provider-owned item offered through the composer. Each entry is
exactly one Skill, provider plugin, Codex custom prompt, or provider command.
Mcode-level commands are not provider catalog entries. Entries of different
kinds may share a native name and remain distinct.

### Provider plugin
A provider-distributed bundle of reusable instructions and integrations. Mcode
exposes an installed and enabled plugin as one provider catalog entry while
keeping its constituent Skills distinct.
_Avoid_: Skill, plugin marketplace entry

### Provider catalog snapshot
The last provider-confirmed set of catalog entries for a workspace context. A
snapshot remains available across app restarts and is marked stale whenever
Mcode cannot confirm it against the provider. Age alone does not expire a
snapshot.

### Catalog refresh
A background reconciliation between a visible catalog snapshot and its
sources. Cached entries remain usable during refresh, and additions, changes,
removals, and diagnostics are applied by stable entry identity.

### Skill
A reusable agent capability the end user can attach to their threads
inside the Mcode app — domain knowledge or a multi-step workflow the
agent loads on demand. Skills are surfaced via `SkillInfo` records and
the skills store. Distinct from the dev-tooling skill concept under
`AGENTS.md` (which is for contributors developing Mcode itself).

A provider may be the **authoritative source of its own skill catalog**
(Codex exposes one natively, including skills bundled inside provider
plugins). When the Codex catalog is temporarily unavailable, Mcode serves
the last confirmed catalog snapshot and marks it stale. Without a snapshot,
the catalog is unavailable. Mcode does not reconstruct the Codex skill
catalog with a filesystem scan. Skills the user disabled in the provider's
own config do not appear in Mcode. An installed and enabled **provider
plugin** is a distinct provider catalog entry. Skills contributed by that
plugin remain separate Skill entries.

### Slash command
A short command the user types in the composer (e.g. `/something`) that
the Mcode app expands into a richer prompt or action. Editor integration
lives in the composer's Lexical plugin (`SlashCommandPlugin`,
`SlashCommandNode`, `SlashCommandTray`). Distinct from the dev-tooling
slash commands under `.claude/commands/` etc. (which are for
contributors).

### Codex custom prompt
A deprecated Codex prompt template that the user invokes explicitly through
the slash-command gesture. Mcode continues to support custom prompts as a
compatibility surface, while Skills remain the preferred Codex surface for
reusable instructions.
_Avoid_: Skill, Mcode-level command

### Provider command
A reusable command defined by an agent provider, such as a Claude command.
Provider commands are distinct from Codex custom prompts, even when both use
the slash-command gesture in the composer.
_Avoid_: Codex custom prompt, Skill

Slash commands use `/` as their composer gesture. Providers with their own
native invocation syntax (Codex's `$` mentions) get a translation at the
provider boundary; the user never types the native syntax in Mcode.

Slash commands sit in one of three availability layers:

- **Provider-scoped command** — native to a single provider, discovered by
  the server skill scan. Each `SkillInfo` carries the provider(s) that own
  it in `providers[]`, and the server (`skill-service.ts`) filters the list
  by the active provider before it reaches the client. The composer does
  **not** re-filter these; they arrive already scoped.
- **Multi-provider command** — offered to an explicit, growing set of
  providers. `/goal` is backed by provider goal support, while `/plan`
  applies to every provider except Copilot, which has its own native plan mode.
  Capability availability is resolved once by `resolveComposerCapabilities`
  and shared by the plus menu, slash commands, and attached chips.
- **Mcode-level command** — app-level, offered for every provider regardless
  of which one is active (e.g. `/compact`).

Built-ins are the only commands the client gates by provider; provider-scoped
skills are gated server-side. An empty `providers[]` on a `SkillInfo` means
*no* provider, not "all" — universal availability is the Mcode-level layer.

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

## In-app browser preview

### Discarded tab (memory saver)
A background preview tab whose renderer has been killed to reclaim memory,
keeping only a cold placeholder (title, URL, favicon). Reopening reloads the
page; scroll position and form state are not preserved. Governed by
`preview.memorySaver.*` settings and ADR 0002.

## Release channels

### Stable release
A supported Mcode version published for general use.
_Avoid_: Major release, production release

### Nightly release
A prerelease build published from ongoing development for early use and
testing.
_Avoid_: Stable release

### Superseded nightly
A nightly release whose intended version has since shipped as a stable release.
It has no continuing rollback or support role.
_Avoid_: Supported release, archived nightly
