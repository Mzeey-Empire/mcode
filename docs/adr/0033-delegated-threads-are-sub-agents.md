# 0033: Delegated threads are sub-agents

Status: Accepted

Date: 2026-10-21

Amends [ADR-0021](0021-thread-control-authority-and-lifecycle.md) and
[ADR-0032](0032-delegation-wakes-the-coordinator-within-its-permission-mode.md).
It changes where a Delegated thread appears and what happens to it when its
Coordinator is deleted.

## Context

ADR-0021 and ADR-0032 treat a Delegated thread as an independent Thread that
stays visible in its Project and survives the Coordinator being deleted.

In use, `delegate_task` fills the same need as a provider-native sub-agent. It
hands one piece of work to another agent and reports back. Delegation exists
only because the native tool cannot reach another Provider or a model it lacks.
Showing these threads in the sidebar puts helper conversations next to the
user's own work, and gives the user two places to look for an agent's helpers:
the sub-agent view for native children and the sidebar for delegated ones.

Launching an independent Thread that the user wants as its own conversation is
a separate capability, Thread launch, and is not affected.

## Decision

1. **A Delegated thread is a sub-agent.** It appears in its Coordinator's
   sub-agent view with the native children. The timeline shows the
   `delegate_task` call as a sub-agent row. The roster entry shows the
   Delegated thread's Provider, live status, and transcript, and offers Stop.
   The roster reads status from the same task state as `task_status`, so the
   two cannot disagree.
2. **A Delegated thread never appears in thread lists or search.** The
   Coordinator link is written when the thread row is created, and the same
   visibility rule that hides native children hides it.
3. **The user's Stop needs no approval.** Stop in the sub-agent view cancels the
   task directly. An agent's `task_cancel` keeps the Coordinator's authority
   and approval policy.
4. **Deleting the Coordinator treats Delegated threads like native children.**
   Finished Delegated threads are deleted with it. Running ones lose their
   Coordinator link and become ordinary visible Threads, so no work disappears
   while it runs. A Delegated thread's worktree is removed only when the
   Delegated thread created it.

The rest of ADR-0032 stands: the Coordinator is notified when work ends, the
Permission mode ceiling applies, and `delegate_task` accepts a client request
id.

## Consequences

- One place shows an agent's helpers, whatever Provider runs them.
- Threads created by the older `thread_create_batch` tool keep their audit
  lineage but no longer carry a Coordinator link, so they stay visible.
- A Provider whose adapter does not report the `delegate_task` tool name shows
  the call as a plain tool row. The roster entry still appears. Cursor is in
  this state today.
