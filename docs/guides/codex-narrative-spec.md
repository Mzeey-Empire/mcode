# Codex narrative spec (Mcode)

This document states what “Codex in Mcode should feel like” in the chat narrative: thoughts, tools, sub-agents, and final reply. It is the product contract for server mapping, `agent-service`, and web narrative code.

For pipeline traps and shared behavior with Claude, see [narrative-pipeline.md](./narrative-pipeline.md). For observed Codex app-server protocol evidence, see [codex-app-server-trace.md](./codex-app-server-trace.md).

---

## 1. Goals

1. **Parity with Codex-style visibility**  
   While a turn is running, the user sees a chronological trail of what the agent is doing, not only the final assistant message.

2. **Thoughts**  
   Model reasoning or planning-style text that is not the user-facing answer appears as **thought** rows (non-final text deltas). Final answer text appears as normal assistant streaming / the committed bubble, not duplicated as thoughts.

3. **Sub-agent nesting**  
   When Codex runs collaboration / spawn flows (`collabAgentToolCall`), Mcode shows an **Agent** tool row. Shell commands, file changes, MCP calls, and other tools that belong to that sub-agent appear **nested under** that row via `parentToolCallId`.

4. **Stable ordering**  
   Timeline order matches user expectations: thoughts and tools interleave in a sensible way with respect to when the server emits events (see constraints).

5. **No Codex-specific `AgentService` fork**  
   One persistence and enrichment path. Codex differences stay in `CodexEventMapper` (and thin glue), unless a future spec explicitly requires otherwise.

---

## 2. User-visible behavior

Codex models come from the app-server `model/list` catalog. The model picker and Settings keep the provider's order and use readable display names without changing the model IDs. Hidden models are excluded. The existing model cache retains the last successful list when a refresh fails; static models remain the initial UI fallback. Model discovery uses the shared catalog connection, not the turn startup handshake.

| Element | Expected behavior |
|--------|-------------------|
| Thought rows | Dimmed / “thinking” style blocks built from non-final `TextDelta` events. |
| Final reply | Full-weight prose from the assistant item promoted by `AssistantMessageBoundary`, then committed message on turn end. |
| Agent / sub-agent row | `ToolUse` with `toolName: "Agent"`; label may reflect Codex collab kind (e.g. spawn). |
| Child tools | Nested under the correct Agent row; expandable like today’s narrative. |
| Turn footer | Step / sub-agent counts and duration reflect nested tools and Agent rows (existing narrative rules). |

---

## 3. Technical contract (Mcode)

### 3.1 Events

- **Thought stream**: Any Codex notification that represents non-final model text must map to `AgentEventType.TextDelta` with `isFinalResponse: false`.
  Known sources today: `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/completed` with `type: "reasoning"`, and experimental `item/plan/delta` when the app-server uses it for live planning text. Completed `plan` items stay silent.

- **Assistant stream**: `item/agentMessage/delta` and equivalent completed shapes map to non-final `TextDelta` events while the turn is running. At main turn completion, the mapper emits `AssistantMessageBoundary` with `isFinalResponse: true` for the last assistant item and persists that item as the final reply.

- **Sub-agent scope**: Child `ToolUse` events must include `parentToolCallId` set to the Codex collab item id when the work is under that sub-agent.

- **Agent row lifecycle**: Emit `ToolUse` for Agent when the collab starts or, in legacy ordering, when the collab completes in one shot. A `spawnAgent` collab's own completion means the child thread was created, not that the child finished, so the mapper suppresses that result. Emit the matching `ToolResult` from the child thread's `turn/completed` or from `wait` state. Child tools must not be attributed to a closed collab scope incorrectly (see section 5).

### 3.2 Server enrichment

- `index.ts` may enrich missing `parentToolCallId` only when the turn buffer implies a **single** running Agent (see narrative-pipeline trap 1).
- Codex must not rely on this for nested children: the mapper should set `parentToolCallId` explicitly whenever the protocol order allows it.
- Codex-specific behavior belongs in `CodexEventMapper`; do not fork `AgentService` for provider-specific narrative rules.
- The server-side `agentCallStack` pops an Agent when its `ToolResult` arrives, so stack fallback often cannot rescue Codex child tools. Prefer explicit `parentToolCallId` from the mapper.

### 3.3 Client

- `threadStore` merges non-final deltas into `thoughtSegmentsByThread` and final deltas into streaming assistant text, per existing rules.
- `buildNarrativeItems` groups by `parentToolCallId` for sub-agent rows.

---

## 4. Success criteria (acceptance)

1. With **`MCODE_CODEX_TRACE=1`**, a dev can confirm which methods fire (`item/plan/delta` vs `item/reasoning/*` vs neither) for a real turn.

2. On a run that uses sub-agents, **at least one** child `commandExecution` (or equivalent) appears under an **Agent** row when the app-server delivers `item/started` for collabs **or** delivers collab completion before its children in the notification stream.

3. Thought rows appear when the app-server emits any mapped non-final stream; if the model never emits reasoning or plan deltas, an empty thought strip is **acceptable** (provider limitation).

4. Opening a thread after completion: persisted narrative matches what the server stored for that turn (no duplicate final text as thought, per existing dedupe rules).

---

## 5. Known constraints and non-goals

1. **Notification ordering**
   If child tools complete **before** Mcode learns the collab id (no `item/started`, collab `item/completed` arrives late), nesting may be impossible without extra data (e.g. ordered `turn.items` or parent ids on each item). The spec treats that as a **protocol / ordering gap**, not a silent bug in the UI.

2. **Parallel sub-agents**
   Without receiver thread ids or per-child parent ids from Codex, attribution under the wrong Agent row is a known limitation; fixing it may require protocol or heuristics called out in a future revision of this spec. When more than one parent-thread collab is open, the mapper must omit stack-derived nesting rather than guess.

3. **Provisional spawn rows**
   Codex can emit `spawnAgent` starts with empty `receiverThreadIds` and empty `agentsStates`. Those rows are provisional. They must not produce synthetic "finished" results unless a child thread completion or `wait` state confirms the child finished.

4. **Fast tier / model**
   Some configurations may omit reasoning or plan streams; the spec does not require inventing text the API does not send.

5. **Plan and reasoning overlap**
   `item/plan/delta` may duplicate or overlap with reasoning in some Codex versions. Tune mapping if the timeline becomes noisy.

6. **Typing cursor animation**
   Optional polish for the final bubble is out of scope for this spec unless listed under goals.

---

## 6. Document maintenance

When behavior changes (new Codex notification types, nesting rules, or UX), update:

- This spec (contract and acceptance).
- [codex-app-server-trace.md](./codex-app-server-trace.md) when the change depends on observed Codex protocol behavior.

---

## Stop and session reuse

Stop cancels the current Codex turn through `turn/interrupt` and keeps the
app-server available for the next message. A stop during startup cancels the
staged turn or waits for its native turn ID before interruption. Pending approval
cards clear before the interrupt request. Shutdown, eviction, and explicit
session discard still close the app-server.

Normal turn completion also keeps the app-server available. Stop during settings
or input preparation cancels that request before dispatch, including on a reused
session. An interrupt timeout rejects Stop without an unhandled promise rejection.

Late events from a previous main turn cannot reset the next turn's mapper.

## Reasoning effort and token usage

Codex uses the selected reasoning effort in both standard and proactive
orchestration. Proactive orchestration does not select Ultra automatically.
If no effort is selected, Mcode leaves the effort field unset.

Mcode reads `thread/tokenUsage/updated` for native token usage. The latest
request's input count represents context usage. Turn totals exclude previous
turns and include cached tokens once. Duplicate updates do not add consumption.
Usage updates reach the context tracker before completion. Failed and cancelled
turns retain their reported usage without a successful completion event. The
reported context count persists for reconnect.

The Composer context ring has no center label. Hover or keyboard focus opens a
usage bar with used tokens, capacity, and remaining tokens. The card separates
processed tokens from current context usage.

Routine provider warnings, configuration notices, deprecation notices, and
authentication-recovery notices do not appear in chat or above Composer. This
also applies to subagent chat. Notices remain persisted. Security warnings,
model changes, actionable diagnostics, approval requests, and errors retain
their existing surfaces.

## Revision history (informal)

- **Initial**: Codex narrative parity goals, thought vs final reply, nesting contract, acceptance, and explicit limits.
