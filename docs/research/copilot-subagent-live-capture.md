# Copilot sub-agent live capture

Date: 2026-10-13. SDK 0.2.2, bundled CLI 1.0.25 (reported by `session.start`), model claude-haiku-4.5.

PR #2143 left four questions open about how Copilot reports sub-agents. Static reading of the SDK types could not answer them, so each was run against the live CLI. A local harness logged every raw SDK event to JSONL. It used a throwaway sandbox of three text files and approved all permissions.

## Runs

| Run | Setup | Events |
|-----|-------|--------|
| 1 | One sub-agent reads three files | 61 |
| 2 | A sub-agent is told to start its own sub-agent | 59 |
| 3 | `forceStop()` after the third child event, then `resumeSession` and "continue" | 84 |
| 4 | The harness kills its own CLI child PID after the first child event, then waits 90 s | 34 |

## Findings

**The `task` tool runs in background mode.** The parent's `tool.execution_complete` for `task` arrives right after `subagent.started`, with "Agent started in background". The sub-agent then works while the parent polls with `read_agent`. `session.idle` is documented as "no background agents in flight", and in every run it arrived only after the sub-agents finished.

**Child events carry `parentToolCallId` at runtime, including `tool.execution_complete`.** The SDK schema omits it on that event. Child `assistant.usage` also carries it. The mapper drops child usage, as the base did, so parent token totals exclude sub-agent tokens.

**There are no child reasoning events.** Across all runs, no `assistant.reasoning` or `assistant.reasoning_delta` event had a `parentToolCallId`. Child reasoning rides on the child `assistant.message` as `reasoningText`. The mapper does not show it.

**Child items always precede `subagent.completed`.** In runs 1 and 2, every child tool result and message arrived before its sub-agent's terminal event.

**Nested sub-agents work as the mapper assumes.** In run 2, the inner `task` start carries the outer id as `parentToolCallId`. The inner `subagent.started` carries no parent, so ancestry comes from the tool start. The inner task ran in the foreground. Its `tool.execution_complete` arrives after the inner `subagent.completed` and belongs to the outer child, which is still open.

**Copilot does not recover sub-agents.** After `forceStop` and `resumeSession`, the replayed history holds only parent events. It has the `subagent.started` but no child events and no terminal. `read_agent` returned "Agent not found", `list_agents` returned none, and the model started a new sub-agent under a new tool call id.

**An unexpected CLI exit emits no session event.** In run 4, four already-buffered events arrived right after the kill, then nothing for 90 s. The client state became `disconnected`. The SDK has no public disconnect event.

## Decisions

| Question | Verdict | Decision |
|----------|---------|----------|
| Nested shape | VERIFIED | No change. A server test replays the run 2 order and records both transcripts. |
| Late child item becomes a parent diagnostic | VERIFIED not observed live | The mapper drops observations for a closed child. A closed transcript is final, and the parent diagnostic offered a retry that cannot help. |
| Sub-agent resume | VERIFIED not supported | No change. A resumed session cannot reach the old sub-agent. |
| Child reasoning parent id | VERIFIED absent | Not shown. It needs a reasoning item kind in the child recorder. |
| Crash with open children | VERIFIED Copilot loses them | No server sweep. The provider closes open children on every turn exit path, including Stop. |

## Open

- A CLI crash leaves the parent turn waiting, because nothing settles it until the user presses Stop. This predates PR #2143 and is not specific to sub-agents. Fixing it needs a connection watchdog in the Copilot provider.
- Child reasoning and child token usage are not shown.
