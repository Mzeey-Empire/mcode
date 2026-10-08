# Product

*For contributors. The README tells you what Mcode is in a sentence. This document tells you why it exists, who it serves, what jobs it does, and the lines we choose not to cross. Read it once before you scope a feature.*

---

## 1. What Mcode Is

Mcode is a desktop app for running coding agents — many at a time, across many projects, against many branches. You point it at a folder, pick a provider (Claude, Codex, Copilot, Cursor, Devin, OpenCode), and you get a workspace where each conversation is a thread, each thread can have its own git worktree, and every tool call the agent makes is visible in real time.

It is not a chat client and it is not a wrapper. The CLIs already work. Mcode exists because *running eight agents in parallel from a terminal is unworkable* — you lose track of which one finished, which one errored, which branch each one is on, which diff each one produced. Mcode is the orchestration surface that sits above all of them.

## 2. Who It's For

One person, holding their attention:

- **Senior developers** who already use coding agents daily and have hit the wall of "how do I keep five of these going without losing my mind?"
- **Solo founders and indie engineers** running parallel experiments across multiple repos.
- **Power users** who keep an editor, a terminal, a browser, and a notes app open simultaneously and want Mcode to fit next to those, not replace them.

Not for:

- People who have never used Claude Code, Cursor, or Codex from a terminal. The mental model is too dense.
- Teams looking for a multi-user review system, team policy enforcement, or repository administration.
- People who want a single chat box with no concept of branches, threads, or worktrees.

## 3. The Jobs Mcode Does

In rough order of frequency:

| Job | What happens | Why Mcode beats the CLI |
|-----|--------------|-------------------------|
| Run an agent on a fresh branch | Pick provider, choose **New worktree** mode, type the prompt, submit. A worktree is provisioned and the agent starts. | One action vs. five terminal commands. The worktree is named, tracked, listed. |
| Track multiple agents at once | Each sidebar row shows its thread's state: running, needs you (approval, answers, plan ready, interrupted), finished but not yet opened, or failed. | A terminal cannot show eight sessions at a glance. |
| Review what an agent did | The Review tab shows changes by turn, all turns, unstaged, staged, commit, or branch. The user reverts a file or a turn, comments on lines for the next message, and commits selected files directly. | The CLI's diff output scrolls past and is gone. |
| Review a pull request | The Pull requests surface groups authored, requested, and reviewed work, then exposes Summary, Timeline, Code, and an optional isolated Review task. | Remote review and local agent work stay in one explicit flow while GitHub remains the system of record. |
| Follow up on a previous run | Fork a thread from any message, or attach a new thread to an existing worktree. | The CLI has no concept of "continue from message N." |
| Hand work between providers | Fork a Claude thread into a Cursor thread; a generated handoff doc carries context across. | Provider sessions don't talk to each other. Mcode's B/A/D ladder bridges them. |
| Use the running app | The Browser tab opens the project's dev servers. Design notes on page elements and screenshots go into the next message. The agent can drive the page, and the user can take control back. | No tab-flipping; the notes and screenshots land in the composer ready to send. |
| Plan before doing | Plan mode asks its questions, then produces a versioned plan the user edits and comments on. Implement sends exactly the version on screen. | The CLI just starts editing, and its plan is a scrollback message nobody can edit. |
| Run the project's commands | Project actions (dev server, tests, build) run in real terminals. Startup actions run when a thread starts in a new worktree. | Ports, output, and exit codes stay attached to the thread instead of a stray terminal window. |

## 4. The Wedge

The thing Mcode does that nothing else does:

> **It treats each agent run as a first-class object with state — branch, worktree, transcript, diff, status — that you can scan in one second.**

A Claude Code terminal session has no object. It's an ephemeral stream of text. When you start a second one, you're juggling two terminals. Five sessions and you're lost.

Mcode says: *every conversation is a thread, every thread has metadata, every thread sits on the sidebar with a dot showing its state.* Once you commit to that abstraction, everything else falls out — worktree isolation, fork and handoff, per-turn diffs, the preview panel, the command palette. They all reinforce one principle: **the agent's work is something you can hold and reason about, not just talk to.**

## 5. Product Principles

The stances that decide ambiguous design or scope calls:

### 1. The glance matters more than the conversation.

Most of the time, the user is not reading the agent's reply. They're glancing at the sidebar to see what's done, what's running, what errored. Optimize for the glance. A status dot you can read at flick-speed is worth more than a paragraph of agent prose.

### 2. Information density over uniform compression.

Prefer high information density, not tight spacing everywhere. Keep rows compact within a related list, and use stronger spacing between groups, task stages, and primary surfaces. Whitespace is structural when it communicates hierarchy, focus, or ownership.

### 3. The agent is a peer, not an oracle.

The user is in charge. They edit the prompts, they pick the branch, they choose when to fork, they decide what to ship. The agent runs; the user steers. Mcode does not narrate the agent's wisdom or hide its mistakes — it shows what happened, exactly, in the order it happened.

### 4. Keyboard first, mouse fallback.

Every action has a keystroke. F2 renames in place, Cmd+1..9 switches threads, Cmd+K opens the palette, slash commands fire from the composer. If you design a feature without a keyboard path, you haven't finished it.

### 5. Quiet over loud.

The interface stays calm at rest. During a state change, one signal leads: a dot pulses, a row enters, or a number ticks. Nothing competes with the data.

### 6. Anticipate the next step.

At every node of the loop, the app surfaces the one move the user is most likely to make next. When the outcome is unambiguous it just happens (add a project, land in a new chat on it); when there is a real choice it offers a single primary action and keeps the rest quiet (a finished turn offers Review; a failed one offers Retry; an interrupted one offers Resume). The suggestions are curated, not learned, so the same state always proposes the same move and the user comes to trust it. The goal is not cleverness. It is that the user rarely has to stop and ask "what now?"

### 7. Same tool, different posture.

Responsive changes preserve capability, context, and state. A narrower
container changes a tool's posture, not its powers. A file navigator docks
beside a diff when there is room and floats over it when there is not; it never
becomes a weaker picker.

### 8. Needs you outranks done.

A thread waiting on the user (an approval, plan questions, a plan ready to
implement, an interrupted turn) is never dimmed or hidden. It outranks a
finished thread, which outranks a running one. Each state holds on the thread's
sidebar row until the user opens the thread. Thread events reach the user as a
sidebar row state and, when another thread changes, a toast. There is no
separate thread notification log. The notifications bell covers setup:
providers that need signing in or updating, new models, and app updates.

### 9. Honest about each provider.

Providers differ, and Mcode says so instead of faking parity. A surface shows
what the provider actually reports. One provider streams a subagent's full
transcript; another reports only a summary, and the UI says which. "Allow for
this session" appears only where its scope can be stated. Provider quirks are
handled in the adapter, and the user sees the plain result.

### 10. Real actions, not requests to the agent.

When the user asks for something Mcode can do itself, Mcode does it. Commit
makes a commit, Revert this turn reverts the files, and project actions run in
real terminals. Mcode does not paste a prompt that asks the agent to do the work
and hope. The agent's work and the user's own actions stay distinct in the
thread's history.

### 11. Every way in has a way out.

Each state the user can enter has a visible exit and a visible marker. Start
has Stop or Cancel. Take control has Hand back. Allow has a receipt.
An unavailable option stays visible, dimmed, with the reason one hover away.

### 12. Unsent work survives.

Review comments, Browser design notes, file comments, and plan comments are
drafts. They survive switching threads, closing panels, and restarting the app
until the user sends or discards them. Unsaved project settings survive
switching tabs and threads; leaving them unsaved across a restart is not
supported, and the save bar says so.

### 13. Mcode's record is the source of truth.

Where the user and the agent share an artifact, such as a plan, Mcode keeps the
record and its versions. The user's edits create a new version, and the agent
receives exactly the text the user approved.

## 6. The Surfaces

A user with Mcode open sees, in priority order:

| Surface | What it does | Why it earns its space |
|---------|--------------|------------------------|
| **Sidebar** | Projects, threads, thread row states, drag-reorder. The footer holds the notifications bell and the app update button. | The thing the user scans first, every time. |
| **Conversation** | Narrative timeline of turns, tool calls, narration segments. Read-only; replies go through the composer. | The agent's stream, made legible. |
| **Composer** | Drafting surface at the bottom of the conversation. Owns the prompt, attachments, Plan mode, access mode, model, and reasoning level. Approvals and plan questions take its place while they wait. Persists drafts across thread switches. | The user's only input. Treat it like a workbench. |
| **Thread overview** | A card under the header. Before the first send it holds the workspace mode and branch; afterwards it lists what exists for the thread: changes, plan, subagents, browser pages, running terminals, usage. | The thread's state in one place, without scrolling the conversation. |
| **Pull requests** | Relationship inbox with Summary, Timeline, Code, explicit Remote effects, and Review Change Stack. | Review a remote Change stack or continue it in an isolated Review task without hiding which system changes. |
| **Command palette** | Cmd+K. Slash commands, actions, and a jump to Settings. | The keyboard discovery surface. |
| **Right panel** | Tools beside the conversation: Review, Browser, Terminal, Files, Plan, Subagents, and Project settings. | Review, run, and inspect the agent's work without leaving the thread. |
| **Settings** | Appearance, performance, model context overrides, provider keys, permission modes. Reached from the sidebar or the command palette. | Configuration without leaving the workspace. |

## 7. What Mcode Doesn't Do

Explicit non-goals. Saying no to these is what keeps the surface coherent.

- **No ticket tracking.** GitHub Issues, Linear, Jira exist. We point at them; we don't replace them.
- **No team review policy or repository administration.** Mcode may surface and act on pull-request review. GitHub remains the system of record; Mcode does not own team review policy or administer repositories.
- **No team features.** Mcode is a personal tool. Multi-user, shared workspaces, role-based access are out of scope.
- **No marketing surface.** No dashboards, no "stats", no "your week in Mcode." The app is a tool, not a thing to look at.
- **No model abstraction layer.** We do not reinvent the provider SDKs. We adapt to them. If Claude releases a new feature, we surface it. We do not pretend providers are interchangeable when they aren't.
- **No cloud sync, no accounts, no telemetry.** State lives on disk. Threads, worktrees, settings — all local.
- **No mid-turn chat with the user.** The agent does not ask clarifying questions during a turn. We disallow the `AskUserQuestion` SDK tool (commit 58e1fc39). Plan mode is the structured place for clarification.

## 8. The Product Test

Before shipping a feature, hold it against three questions:

1. **Does it earn its pixels?** If it adds chrome without making the glance faster or the loop tighter, cut it.
2. **Does it sound like Mcode in copy?** "Failed", "Idle", "Empty", not "Oops, something went wrong." Marketing voice in the diff is a bug.
3. **Would a senior developer at 11pm thank you for this, or scroll past it?** That's the audience. That's the test.
