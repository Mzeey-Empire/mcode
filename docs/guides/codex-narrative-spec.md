# Codex narrative spec (Mcode)

This document states what “Codex in Mcode should feel like” in the chat narrative: narration, tools, sub-agents, and final reply. It is the product contract for server mapping, `agent-service`, and web narrative code.

For pipeline traps and shared behavior with Claude, see [narrative-pipeline.md](./narrative-pipeline.md). For implementation notes and experiments, see `apps/server/src/providers/codex/CODEX-NARRATIVE-NOTES.md`.

---

## 1. Goals

1. **Parity with Codex-style visibility**  
   While a turn is running, the user sees a chronological trail of what the agent is doing, not only the final assistant message.

2. **Thoughts**  
   Model reasoning or planning-style text that is not the user-facing answer appears as **narration** rows (non-final text deltas). Final answer text appears as normal assistant streaming / the committed bubble, not duplicated as narration.

3. **Sub-agent nesting**  
   When Codex runs collaboration / spawn flows (`collabAgentToolCall`), Mcode shows an **Agent** tool row. Shell commands, file changes, MCP calls, and other tools that belong to that sub-agent appear **nested under** that row via `parentToolCallId`.

4. **Stable ordering**  
   Timeline order matches user expectations: narration and tools interleave in a sensible way with respect to when the server emits events (see constraints).

5. **No Codex-specific `AgentService` fork**  
   One persistence and enrichment path. Codex differences stay in `CodexEventMapper` (and thin glue), unless a future spec explicitly requires otherwise.

---

## 2. User-visible behavior

| Element | Expected behavior |
|--------|-------------------|
| Narration rows | Dimmed / “thinking” style blocks built from `TextDelta` with `isFinalResponse: false`. |
| Final reply | Full-weight prose from `TextDelta` with `isFinalResponse: true`, then committed message on turn end. |
| Agent / sub-agent row | `ToolUse` with `toolName: "Agent"`; label may reflect Codex collab kind (e.g. spawn). |
| Child tools | Nested under the correct Agent row; expandable like today’s narrative. |
| Turn footer | Step / sub-agent counts and duration reflect nested tools and Agent rows (existing narrative rules). |

---

## 3. Technical contract (Mcode)

### 3.1 Events

- **Narration stream**: Any Codex notification that represents non-final model text must map to `AgentEventType.TextDelta` with `isFinalResponse: false`.  
  Known sources today: `item/reasoning/*`, `item/completed` with `type: "reasoning"`, and experimental `item/plan/delta` when the app-server uses it for live planning text.

- **Final answer stream**: `item/agentMessage/delta` and equivalent completed shapes map to `TextDelta` with `isFinalResponse: true`.

- **Sub-agent scope**: Child `ToolUse` events must include `parentToolCallId` set to the Codex collab item id when the work is under that sub-agent.

- **Agent row lifecycle**: Emit `ToolUse` for Agent when the collab starts or, in legacy ordering, when the collab completes in one shot; emit matching `ToolResult` when the collab finishes. Child tools must not be attributed to a closed collab scope incorrectly (see section 5).

### 3.2 Server enrichment

- `index.ts` may enrich missing `parentToolCallId` only when the turn buffer implies a **single** running Agent (see narrative-pipeline trap 1).  
- Codex must not rely on this for nested children: the mapper should set `parentToolCallId` explicitly whenever the protocol order allows it.

### 3.3 Client

- `threadStore` merges non-final deltas into `narrationSegmentsByThread` and final deltas into streaming assistant text, per existing rules.  
- `buildNarrativeItems` groups by `parentToolCallId` for sub-agent rows.

---

## 4. Success criteria (acceptance)

1. With **`MCODE_CODEX_TRACE=1`**, a dev can confirm which methods fire (`item/plan/delta` vs `item/reasoning/*` vs neither) for a real turn.

2. On a run that uses sub-agents, **at least one** child `commandExecution` (or equivalent) appears under an **Agent** row when the app-server delivers `item/started` for collabs **or** delivers collab completion before its children in the notification stream.

3. Narration rows appear when the app-server emits any mapped non-final stream; if the model never emits reasoning or plan deltas, an empty narration strip is **acceptable** (provider limitation).

4. Opening a thread after completion: persisted narrative matches what the server stored for that turn (no duplicate final text as narration, per existing dedupe rules).

---

## 5. Known constraints and non-goals

1. **Notification ordering**  
   If child tools complete **before** Mcode learns the collab id (no `item/started`, collab `item/completed` arrives late), nesting may be impossible without extra data (e.g. ordered `turn.items` or parent ids on each item). The spec treats that as a **protocol / ordering gap**, not a silent bug in the UI.

2. **Parallel sub-agents**  
   Without per-child parent ids from Codex, attribution under the wrong Agent row is a known limitation; fixing it may require protocol or heuristics called out in a future revision of this spec.

3. **Fast tier / model**  
   Some configurations may omit reasoning or plan streams; the spec does not require inventing text the API does not send.

4. **Typing cursor animation**  
   Optional polish for the final bubble is out of scope for this spec unless listed under goals.

---

## 6. Document maintenance

When behavior changes (new Codex notification types, nesting rules, or UX), update:

- This spec (contract and acceptance).
- `CODEX-NARRATIVE-NOTES.md` (attempts, traces, edge cases).

---

## Revision history (informal)

- **Initial**: Codex narrative parity goals, narration vs final reply, nesting contract, acceptance, and explicit limits.
