# Product

*For contributors. The README tells you what Mcode is in a sentence. This document tells you why it exists, who it serves, what jobs it does, and the lines we choose not to cross. Read it once before you scope a feature.*

---

## 1. What Mcode Is

Mcode is a desktop app for running coding agents — many at a time, across many projects, against many branches. You point it at a folder, pick a provider (Claude, Codex, Copilot, Cursor, OpenCode), and you get a workspace where each conversation is a thread, each thread can have its own git worktree, and every tool call the agent makes is visible in real time.

It is not a chat client and it is not a wrapper. The CLIs already work. Mcode exists because *running eight agents in parallel from a terminal is unworkable* — you lose track of which one finished, which one errored, which branch each one is on, which diff each one produced. Mcode is the orchestration surface that sits above all of them.

## 2. Who It's For

One person, holding their attention:

- **Senior developers** who already use coding agents daily and have hit the wall of "how do I keep five of these going without losing my mind?"
- **Solo founders and indie engineers** running parallel experiments across multiple repos.
- **Power users** who keep an editor, a terminal, a browser, and a notes app open simultaneously and want Mcode to fit next to those, not replace them.

Not for:

- People who have never used Claude Code, Cursor, or Codex from a terminal. The mental model is too dense.
- Teams looking for ticket tracking, code review, or PR workflow inside the app.
- People who want a single chat box with no concept of branches, threads, or worktrees.

## 3. The Jobs Mcode Does

In rough order of frequency:

| Job | What happens | Why Mcode beats the CLI |
|-----|--------------|-------------------------|
| Run an agent on a fresh branch | Pick provider, choose **New worktree** mode, type the prompt, submit. A worktree is provisioned and the agent starts. | One action vs. five terminal commands. The worktree is named, tracked, listed. |
| Track multiple agents at once | Sidebar shows every thread across every project with a status dot (idle / running / errored). | A terminal cannot show eight sessions at a glance. |
| Review what an agent did | Diff panel renders per-turn file changes; side-rail jumps straight to the file in the user's editor. | The CLI's diff output scrolls past and is gone. |
| Follow up on a previous run | Fork a thread from any message, or attach a new thread to an existing worktree. | The CLI has no concept of "continue from message N." |
| Hand work between providers | Fork a Claude thread into a Cursor thread; a generated handoff doc carries context across. | Provider sessions don't talk to each other. Mcode's B/A/D ladder bridges them. |
| Inspect an agent's web preview | Preview panel renders the running app; captures regions or full screenshots straight into the next prompt. | No tab-flipping; the screenshot lands in the composer ready to send. |
| Plan before doing | Plan mode produces a structured plan and a question wizard before the agent edits anything. | The CLI just starts editing. |

## 4. The Wedge

The thing Mcode does that nothing else does:

> **It treats each agent run as a first-class object with state — branch, worktree, transcript, diff, status — that you can scan in one second.**

A Claude Code terminal session has no object. It's an ephemeral stream of text. When you start a second one, you're juggling two terminals. Five sessions and you're lost.

Mcode says: *every conversation is a thread, every thread has metadata, every thread sits on the sidebar with a dot showing its state.* Once you commit to that abstraction, everything else falls out — worktree isolation, fork and handoff, per-turn diffs, the preview panel, the command palette. They all reinforce one principle: **the agent's work is something you can hold and reason about, not just talk to.**

## 5. Product Principles

Five things that decide ambiguous design or scope calls:

### 1. The glance matters more than the conversation.

Most of the time, the user is not reading the agent's reply. They're glancing at the sidebar to see what's done, what's running, what errored. Optimize for the glance. A status dot you can read at flick-speed is worth more than a paragraph of agent prose.

### 2. Density over discovery.

Developers tolerate small type, tight rows, packed columns. Don't add tooltips to teach them what icons mean — they'll learn it once. Don't wrap things in cards to "make them feel safe." Tight is correct.

### 3. The agent is a peer, not an oracle.

The user is in charge. They edit the prompts, they pick the branch, they choose when to fork, they decide what to ship. The agent runs; the user steers. Mcode does not narrate the agent's wisdom or hide its mistakes — it shows what happened, exactly, in the order it happened.

### 4. Keyboard first, mouse fallback.

Every action has a keystroke. F2 renames in place, Cmd+1..9 switches threads, Cmd+K opens the palette, slash commands fire from the composer. If you design a feature without a keyboard path, you haven't finished it.

### 5. Quiet over loud.

The interface rewards inactivity. When nothing is happening, the app looks calm. When something is happening, exactly one element changes — a dot pulses, a row enters, a number ticks. Nothing else moves. Decoration that competes with the data is hostile.

## 6. The Surfaces

A user with Mcode open sees, in priority order:

| Surface | What it does | Why it earns its space |
|---------|--------------|------------------------|
| **Sidebar** | Projects, threads, status dots, drag-reorder | The thing the user scans first, every time. |
| **Conversation** | Narrative timeline of turns, tool calls, narration segments. Read-only — replies go through the composer. | The agent's stream, made legible. |
| **Composer** | Drafting surface at the bottom of the conversation. Owns mode (Plan / Build), branch, worktree, attachments, model, reasoning level. Persists drafts across thread switches. | The user's only input. Treat it like a workbench. |
| **Plan-mode wizard** | When Plan mode is active, the composer transforms into a step-by-step question flow before any work begins. | Structured planning, not free-form chat. |
| **Preview panel** | Embedded browser pointed at the running app. Has a **design mode** (manual inspection, gates the main submit button) and a **capture dock** (screenshot regions or elements into the composer). | Visual loop without leaving the app. |
| **Diff panel** | Per-turn file changes, side-rail to open in editor, whole-file Markdown preview. | Reviewing what the agent did is the second most common action after sending a prompt. |
| **Command palette** | Cmd+K. Slash commands, actions, and a jump to Settings. | The keyboard discovery surface. |
| **Right panel** | Terminal as a tab; other auxiliary tabs alongside. | Drop into a shell without leaving the workspace. |
| **Settings** | Appearance, performance, model context overrides, provider keys, permission modes. Reached from the sidebar or the command palette. | Configuration without leaving the workspace. |

## 7. What Mcode Doesn't Do

Explicit non-goals. Saying no to these is what keeps the surface coherent.

- **No ticket tracking.** GitHub Issues, Linear, Jira exist. We point at them; we don't replace them.
- **No code review workflow.** PRs happen on GitHub. The diff panel is for *the agent's work in flight*, not for reviewing teammates' PRs.
- **No team features.** Mcode is a personal tool. Multi-user, shared workspaces, role-based access are out of scope.
- **No marketing surface.** No dashboards, no "stats", no "your week in Mcode." The app is a tool, not a thing to look at.
- **No model abstraction layer.** We do not reinvent the provider SDKs. We adapt to them. If Claude releases a new feature, we surface it. We do not pretend providers are interchangeable when they aren't.
- **No cloud sync, no accounts, no telemetry.** State lives on disk. Threads, worktrees, settings — all local.
- **No mid-turn chat with the user.** The agent does not ask clarifying questions during a turn. We disallow the `AskUserQuestion` SDK tool (commit 58e1fc39). Plan mode is the structured place for clarification.

## 8. Where We Are

The roadmap lives on a GitHub Project board. Four broad phases, executed solo:

1. **Foundations** — multi-provider runtime, worktree isolation, narrative timeline. *Largely shipped.*
2. **The orchestration loop** — fork and handoff (B/A/D ladder), plan mode, per-turn diffs, preview panel. *In flight.*
3. **The drafting surface** — composer as workbench, slash commands, skills, hooks. *In flight.*
4. **Polish and integrations** — auto-updater, signing, packaging, deeper editor integration. *Backlog.*

In flight as of May 2026:

- **Whisper narrative redesign** — prose-first rendering, vertical rail reserved for nested tool calls. See commit c906a265.
- **Preview panel refinements** — capture dock, design-mode pill, split between main toolbar and dev / debug tools. See commit 91e37a36.
- **Plan-mode wizard** — composer takeover, durable lifecycle, structured question flow. See commit 82fd5eb2.
- **Cursor handoff via provider-generated path** — B/A/D ladder with sessionless B-prime fallback. See commits fb4e7123 and 8bc66d23.

## 9. How to Read the Other Docs

| Doc | When to open it |
|-----|----------------|
| `README.md` | Install, run, prerequisites. |
| `AGENTS.md` | Repo conventions, workflow gates, where `bun run verify` lives. |
| `CONTEXT.md` | Domain glossary. If you don't know what a "worktree" or "narration segment" means here, read this first. |
| `ARCHITECTURE.md` | IPC flow, data model, directory layout. |
| `docs/guides/ui-design-spec.md` | Designer-facing spec. How Mcode should look and feel. |
| `.impeccable.md` | Condensed design context for LLMs doing UI work. Mirrors the spec but optimized for code-generating agents. |
| `docs/specs/` | Formal product specs for individual features (markdown rendering, usage tracking, context window, sort order). |

## 10. The Product Test

Before shipping a feature, hold it against three questions:

1. **Does it earn its pixels?** If it adds chrome without making the glance faster or the loop tighter, cut it.
2. **Does it sound like Mcode in copy?** "Errored", "Idle", "Empty" — not "Oops, something went wrong." Marketing voice in the diff is a bug.
3. **Would a senior developer at 11pm thank you for this, or scroll past it?** That's the audience. That's the test.
