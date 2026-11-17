# Product

*For contributors. Read it once before you scope a feature. This file covers
intent: why Mcode exists, who it serves, how it decides ambiguous calls, and
what it will not do. It does not describe features. `CONTEXT.md` defines the
product terms.*

## 1. What Mcode Is

Mcode exists to reduce friction as much as possible while working with agents.
It is a desktop app for running many coding agents at once, across many
projects and branches, on whichever provider harness you choose. It is not a
chat client and not a wrapper; the CLIs already work. Running eight agents in
parallel from a terminal is unworkable: you lose track of which one finished,
which one errored, which branch each is on, and which diff each produced.

Mcode is the orchestration layer around an agent run. It covers the whole loop
(start, watch, steer, review, test, commit, hand on), so the user rarely has
to leave it. It is not the user's code editor; the editor stays open beside it.

## 2. Who It's For

One person, holding their attention:

- **Senior developers** who already use coding agents daily and have hit the
  wall of "how do I keep five of these going without losing my mind?"
- **Solo founders and indie engineers** running parallel experiments across
  multiple repos.
- **Power users** who keep an editor open all day and want Mcode to handle
  the agent loop beside it, not replace it.

Not for:

- People who have never used a coding agent from a terminal. The mental model
  is too dense.
- Teams looking for a multi-user review system, team policy enforcement, or
  repository administration.
- People who want a single chat box with no concept of branches, threads, or
  worktrees.

## 3. The Jobs

- Run many agents at once, isolated in their own worktrees when you want it.
- Know at a glance which agent needs you, which is running, and which is done.
- Review what an agent did, or a pull request, and act on it.
- Continue or hand work on across threads and providers.
- Plan before the agent starts changing files.

## 4. The Wedge

> **It treats each agent run as a first-class object with state (branch,
> worktree, transcript, diff, status) that you can scan in one second.**

A terminal agent session has no object. It is an ephemeral stream of text. Start
a second one and you are juggling two terminals; at five you are lost. Mcode
says every conversation is a thread, every thread has metadata, and every thread
sits on the sidebar showing its state. **The agent's work is something you can
hold and reason about, not just talk to.**

## 5. Product Principles

The stances that decide ambiguous design or scope calls:

1. **The glance matters more than the conversation.** Most of the time the user
   is glancing at the sidebar to see what is done, running, or errored, not
   reading the reply. A status you can read at flick-speed beats a paragraph
   of agent prose.
2. **Information density over uniform compression.** Keep rows compact within a
   related list; use stronger spacing between groups, task stages, and primary
   surfaces. Whitespace is structural when it shows hierarchy or ownership.
3. **The agent is a peer, not an oracle.** The user steers: prompts, branch,
   when to fork, what to ship. Mcode does not narrate the agent's wisdom or hide
   its mistakes; it shows what happened, in order.
4. **Keyboard first, mouse fallback.** Every action has a keyboard path. A
   feature without one is not finished.
5. **Quiet over loud.** The interface stays calm at rest. During a state change,
   one signal leads. Nothing competes with the data.
6. **Anticipate the next step.** Surface the one move the user most likely makes
   next. When the outcome is unambiguous, just do it; when there is a real
   choice, offer one primary action and keep the rest quiet. Suggestions are
   curated, not learned, so the same state always proposes the same move.
7. **Same tool, different posture.** A narrower container changes a tool's
   posture, not its powers. Responsive changes keep capability, context, and
   state; a tool never becomes a weaker version of itself.
8. **Needs you outranks done.** When threads roll up, needs you outranks
   running, which outranks failed, which outranks finished. Within one thread,
   a running turn shows before "plan ready", because a plan only matters once
   the turn that wrote it stops. Live waits (approval, answers, setup failed,
   plan ready) are not cleared by opening the thread; they hold until
   resolved. Settled outcomes (finished, failed, interrupted)
   clear once seen; an interrupted turn ranks as needs you until then. There
   is no separate thread notification log; the notifications bell covers
   provider status, not threads.
9. **Honest about each provider.** Providers differ, and Mcode says so instead
   of faking parity. A surface shows what the provider actually reports, and
   says when it reports less.
10. **Real actions, not requests to the agent.** When Mcode can do something
    itself, it does it rather than prompting the agent to do it and hoping. The
    agent's work and the user's own actions stay distinct in the history.
11. **Every way in has a way out.** Each state the user can enter has a visible
    exit and a visible marker. An option that applies but is unavailable right
    now stays visible, dimmed, with the reason one hover away; an option that
    does not apply is left out.
12. **Unsent work survives.** A draft the user has started should survive
    switching threads, closing panels, and restarting the app until they send
    or discard it. Where a draft does not yet (pull request review drafts, an
    unsent Browser note, unsaved project settings across a restart), treat
    that as a gap to close, not a precedent.
13. **Mcode's record is the source of truth.** Where the user and agent share an
    artifact, such as a plan, Mcode keeps the record and its versions, and the
    agent receives exactly the text the user approved.

## 6. What Mcode Doesn't Do

- **No ticket tracking.** We point at GitHub Issues, Linear, and Jira.
- **No team review policy or repository administration.** Mcode may act on
  pull-request review, but GitHub remains the system of record.
- **No team features.** Multi-user, shared workspaces, and roles are out.
- **No marketing surface.** No dashboards, stats, or "your week in Mcode."
- **No model abstraction layer.** We adapt to provider SDKs and surface their
  new features; we do not pretend providers are interchangeable.
- **No cloud sync, no accounts, no telemetry.** State lives on disk.
- **No clarifying chat in Build.** Mcode does not invite questions in Build;
  Plan mode is where clarification happens, and its questions may hold the
  turn until the user answers. If a provider asks anyway, Mcode should either
  show the question or settle it for the user, so a turn never waits on a
  question the user cannot see.
- **No code editor.** Mcode shows files and takes comments on them, but
  hand-editing code happens in the user's editor.

## 7. The Product Test

1. **Does it reduce friction across the whole agent loop?** Judge the whole
   task, including recovery when something goes wrong. Any step it adds must
   earn its cost.
2. **Does it earn its pixels?** If it adds chrome without making the glance
   faster or the loop tighter, cut it.
3. **Does it sound like Mcode in copy?** "Failed", "Idle", "Empty", not "Oops,
   something went wrong." Marketing voice in the diff is a bug.
4. **Would a senior developer at 11pm thank you for this, or scroll past it?**
