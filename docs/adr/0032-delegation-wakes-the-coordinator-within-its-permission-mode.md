# 0032: Delegation wakes the Coordinator and stays within its Permission mode

Status: Accepted

Date: 2026-10-20

Amends [ADR-0021](0021-thread-control-authority-and-lifecycle.md). It changes
how a Coordinator thread learns that delegated work ended, what makes the
tools available, and how a retried `delegate_task` call behaves.

## Context

ADR-0021 let a running Thread create and coordinate other normal Mcode
Threads. Three of its choices make the feature hard to use:

- A Coordinator thread learns that a Delegated thread finished only by calling
  the wait tool. An agent that ends its Turn never hears back, so the user has
  to prompt it again. ADR-0021 named automatic source resumption as a choice
  that needed a later decision. This ADR is that decision.
- The thread tools work only when the user's message passes a wording check
  (`isExplicitMcodeThreadRequest` in
  `packages/thread-orchestration/src/mcode-instructions.ts`). The check needs
  phrases such as "mcode thread" plus an action verb. A user who says "farm this out to Codex"
  gets no tools. The check also guards the wrong thing. It reads the user's
  words, not what the delegated work is allowed to do.
- The public contract has no model-managed request id. When a Provider retries
  a create call after a timeout, a second Delegated thread starts the same
  work.

## Decision

1. **Mcode notifies the Coordinator.** When a delegated task reaches a terminal
   state or waits for an answer, Mcode notifies its Coordinator thread. If the
   Coordinator has an active Turn and its Provider supports steering, Mcode
   steers the notification into that Turn. Otherwise Mcode delivers the
   notification as a new Turn when the Coordinator is idle. Mcode delivers each
   notification once. The wait tool can stay for use inside a Turn, but it is
   no longer the only way to learn the result.
2. **A Permission mode ceiling replaces the wording check.** The Delegation
   tools are available in every Thread whose Provider supports them, whatever
   the user's wording. A Delegated thread never runs
   with a broader Permission mode than its Coordinator. Mcode rejects a request
   for a broader mode. A request that names no mode inherits the Coordinator's
   mode. If the target Provider cannot run that mode, the Delegated thread
   steps down to the broadest mode that the Provider offers.
3. **`delegate_task` accepts a client request id.** A retried call with the
   same id from the same Coordinator thread returns the existing task and does
   not create a second one. This exception applies to `delegate_task` only.
   The other operations keep ADR-0021's rule of no model-managed request id.

The rest of ADR-0021 stands. Delegated threads are normal persisted Threads
with creator lineage. They stay visible in their destination Project and
survive the Coordinator stopping, disconnecting, or being deleted. Only the
human user resolves approvals. Paired external integrations keep their
current server and authority.

## Consequences

- A Coordinator can end its Turn after it delegates, and the tool descriptions
  tell it to do that instead of polling.
- Each Provider needs a way to deliver notifications. Mcode steers them into
  the active Turn where the Provider supports steering, and starts a new Turn
  otherwise.
- Delegation cannot raise access. A Supervised Thread cannot start a Full
  Delegated thread.
- The glossary names the capability Delegation and lists Thread control under
  _Avoid_. Launching an independent top-level Thread is a separate Thread
  launch tool.
