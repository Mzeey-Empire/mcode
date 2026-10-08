# 05 · Running turn: build brief

While a turn runs, the user sees the agent's work as quiet, collapsed rows (tools, Thought) between 16px prose, one honest status line under the work, subagent chips with the provider icon, and a composer tray that holds the task list and queued follow-ups. The thread overview shows the run's changes, task progress, subagents and usage. In-turn states (failed tool, compacting, rate limited, stopping) read on the status line instead of composer banners. Stop and Jump to latest are neutral.

Surfaces: `apps/web` (narrative timeline, status line, composer tray, overview rows, Stop, Jump to latest), `packages/contracts` (reasoning event, segment kind), `apps/server` (narrative turn state, canonical writer, display tables), `packages/providers` and `apps/server/src/features/providers/adapters/opencode` (reasoning, compaction, retry, task lists). Electron needs no desktop-specific change; it renders the web UI.

## Boards

Page "05 · Ready for build": https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0. Components page: https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-5-0.

| Board | Node | Shows |
|---|---|---|
| 05a · Running · Tools streaming · Dark | `213P-2` (p-6-0) | Narration prose, collapsed groups "Read 2 files, 1 search ›" and "Edited 1 file ›" (pencil), running shell header only "Running command `bun run lint` ›", status line "4 steps · Running bun run lint 0:42", tray task row 1/4, overview open (Changes, task row, Usage) |
| 05b · Running · Writing the answer · Dark | `28OG-2` (p-6-0) | "Ran command 0:02 `bun run lint` ›", answer streaming with amber caret, "6 steps · Answering 1:04", tray 3/4 |
| 05c · Running · Subagents · Dark | `29B3-2` (p-6-0) | Subagent chips (16px provider icon, "working"/"finished"), "8 steps · Waiting on subagents 1:20", overview Subagents row (20px discs, "1 active · 1 done") |
| 05d · Running · Scrolled up · Dark | `29MQ-2` (p-6-0) | "Jump to latest" pill (`29YT-2`) over a 56px fade above the tray (`29YR-2`) |
| 05e · Running · Queued follow-up · Dark | `28ZH-2` (p-6-0) | Tray: task row then queued row with Send now (arrow-up), Edit (pencil), Remove (x); composer `296A-2` |
| 05f · Running · In-turn states · Dark | `2CNV-2` (p-6-0) | 1 Edit failed, 2 Thought row then narration, 3 Stopping, 4 status labels through a turn, 5 command exit 1, 6 Compacting context, 7 Rate limited, retrying in 12s |
| Tool-call rows · Dark / Light | `129W-0` / `12QZ-0` (p-5-0) | Expanded group, tool detail rows, shell card states, chip overflow "+2 working, 1 finished", failed chip, "No transcript" copy |
| Composer · Dark → Running / Pending | `L95-0` / `L9T-0` (p-5-0) | Stop (ink circle), draft + queue (small ghost stop square, amber Send), Stop requested (grey circle, spinner) |
| Thread overview · Ship lane · Dark / Light | `ZEJ-0` / `ZU7-0` (p-5-0) | Overview rows incl. 3-disc subagent stack |
| Approval prompts · Composer dock · Dark | `13F0-0` (p-5-0) | Owned by S06; the tray stays above the dock |

Components-page drift (the 05 boards carry the later 2026-10-07 audit and win): Components shell rows still show "in 2.4s", red "Failed" badges and an auto-opened running card; Components queue rows show reply/trash/⋯; the Components status line still shows "1 subagent"; Components chips say "started working"/"updated".

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md` (all 2026-10-07 unless noted):

- Reasoning blocks (Claude thinking, Codex reasoning, Cursor thoughts, and the same for Copilot, Devin, OpenCode) render as a collapsed "Thought" row like a tool row. Narration (text before a tool call) and the final response render as prose. Steps count tool calls only.
- Prose is 16px (`--text-prose`, leading 28); code 14px. Timers read "0:42", no parens. Durations are mono m:ss.
- Tool rows are collapsed with an inline chevron; edit rows use a pencil.
- A running shell shows its header row only (code auto-opens an empty card and output does not stream until done).
- Status label while the answer streams is "Answering" (code says "Thinking..."). 05f adds command failed, compacting, rate limited, stopping.
- Subagents show the provider icon (sub-agent threads are provider-native, so it matches the parent thread), never generic coloured badges. Chips use the 16px provider icon; no inline child rail. The overview row overlaps at most 3 provider discs (20px, 12px step, panel-colour ring); the text ("1 active · 7 done") carries the total. The duplicate subagent count on the status line is dropped.
- Queue actions are Send now / Edit / Remove.
- Send now means steer (user, 2026-10-08, R2). While a turn runs, Send now steers the queued message into that turn, and it is shown only when the thread's provider can steer. There is no "send next" fallback under that name. While the thread is idle, Send now sends the message at once, for every provider (the paused queue in 08f relies on it).
- Full access and Stop are neutral, no amber or red. Stop = ink circle with a background-colour square.
- Task bubble docks on top of the composer in the same tray as the queue list, task row first, queued messages below. Collapsed row = task icon, task-list title with fade, completion indicator B (one segment per task: done ink, current muted, pending border), settled/total, chevron that expands the list upward. Task progress shows in both the overview and the tray.
- Task list title (user, 2026-10-08, R1): "Tasks" when no plan backs the list; the plan's title when the tasks come from implementing a plan; never the thread title.
- Truncation is a 24px right-edge fade, never an ellipsis. Overview width 280, open by default; it lists only what exists at that moment.
- Sidebar active-turn fade (~55%, spinner, no text) comes from "S01 thread row state model". The overview card shell comes from "S03 overview card shell".
- S06: the pending dock replaces the composer surface while the tray stays above it; status line becomes "Waiting for approval". S07: plan lives in the overview; plan row opens the Plan panel.

## How it works today

### Event to narrative

- Providers emit `AgentEvent`s (`packages/contracts/src/events/agent-event.ts:53-381`). There is no reasoning event. Text is `TextDelta` with optional `isFinalResponse` (`:176-194`); `AssistantMessageBoundary` is the authoritative classifier (`:329-353`).
- Server: `ProviderTurnEventApplication.applyTextDelta` routes `isFinalResponse: false` to `narrative.openOrExtendThought` and everything else to the streaming finalizer (`apps/server/src/features/agents/turns/provider-turn-event-application.ts:335-346`). Codex child threads use the same call (`apps/server/src/features/agents/execution/codex-live-event-reducer.ts:306`). Segments buffer in `NarrativeTurnState` (`apps/server/src/features/agents/conversation/narrative/narrative-turn-state.ts:273-313`) and persist to `thought_segments` (`apps/server/src/runtime/persistence/sqlite/schema.ts:506-532`), which has no kind column. The canonical store records every narration segment as item kind `"reasoning"` (`apps/server/src/features/agents/canonical/canonical-agent-store.ts:322-325`, `accepted-parent-events.ts:218-223`) with the segment record in the payload. The canonical writer allowlists live narrative event types (`apps/server/src/features/agents/canonical/canonical-execution-semantic-writer.ts:1656-1663`).
- Web: `stores/thread-store/narrative-projection.ts:19-65` builds `ThoughtSegment`s; `computeLiveStreamingText` sends the open, not-explicitly-non-final segment to the provisional answer slot (`apps/web/src/features/conversation/narrative/narrative-thought-classification.ts:5-29`). `virtual-items.ts:527-542` emits `narrative-flow`, the live response message, and `narrative-indicator`.
- Every thought segment renders as prose through `ThoughtBlock` at `text-sm` (`apps/web/src/features/conversation/narrative/ThoughtBlock.tsx:27-40`). The final answer is `text-sm` too (`apps/web/src/features/conversation/messages/MessageBubble.tsx:857-861`). Caret is 1.5px × 0.875em (`apps/web/src/index.css:874-882`).
- Bug (verified): Codex, Cursor and Devin send reasoning as non-final `TextDelta`, so reasoning renders as narration prose: Codex `mapReasoningDelta`/`mapCompletedReasoning` (`packages/providers/src/private/codex/codex-event-mapper.ts:1970-1976`, `2198-2202`), Cursor `agent_thought_chunk` (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts:159`, `199-207`), Devin (`packages/providers/src/private/devin/devin-acp-event-mapper.ts:131`, `151-156`).
- Gap (verified): Claude drops `thinking_delta`; `emitDelta` handles only `text_delta` and `input_json_delta` (`packages/providers/src/private/claude/claude-event-mapper.ts:496-531`). Copilot drops `phase: "thinking"` messages (`packages/providers/src/private/copilot/copilot-event-mapper.ts:61`). OpenCode ignores reasoning parts and `session.next.reasoning.*` (`apps/server/src/features/providers/adapters/opencode/opencode-event-mapper.ts:472`, `598-600`, `631`).

### Tool rows

- Groups render through `ToolSummaryLine` → `NarrativeSummaryLine` (full-width button, 12px icon, chevron at 30% opacity) with red/grey `StatusBadge`s (`apps/web/src/features/conversation/narrative/ToolSummaryLine.tsx:53-69`, `171-198`; `NarrativeSummaryLine.tsx:16-46`). Failed calls show a red `<pre>` (`ToolSummaryLine.tsx:114-121`).
- Shell: `ShellToolCallRow` opens while running (`open = manualOpen ?? status.isRunning`, `ShellToolCallRow.tsx:241`), shows "in {duration}" with `formatDuration` ("2s", "1m 2s") (`:20-24`, `138-142`), amber icon while running and red on error (`:50-54`), and a card with a "Running" footer (`:153-214`). Output arrives only with `ToolResult`; Codex buffers `outputDelta` until completion (`codex-event-mapper.ts:2006-2010`).
- Icons: Edit is already `Pencil` (`apps/web/src/components/chat/tool-renderers/constants.ts:34`); unknown names (Codex `fileChange`) fall back to `Wrench` (`:46`).
- Task-list tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `update_plan`) are not filtered from the timeline, so they render as generic rows ("1 todowrite" via `constants.ts:115`) and count as steps (inferred: no filter exists under `features/conversation`).

### Status line

- `NarrativeIndicator` renders "6 steps · 2 subagents · Thinking... (0:22)" with a mask-position shimmer and a "Done" exit label (`apps/web/src/features/conversation/narrative/NarrativeIndicator.tsx:112-165`). Labels come from `narrativeActivityLabel`: tool `description`, file verb, or `TOOL_PHASE_LABELS` with ellipses, else "Thinking..." (`activity-label.ts:41-49`; `constants.ts:69-84`).
- Stop-in-flight exists as `pendingStopCounts` (`apps/web/src/features/conversation/composer/Composer.tsx:414-416`) but only the Send button uses it.
- Compaction and retries render as composer banners: `CompactingBanner` and `RetryBanner` (`apps/web/src/features/conversation/composer/ComposerContentSurface.tsx:372-375`; `apps/web/src/components/chat/RetryBanner.tsx:3-54`, amber pulsing dot). `apiRetry` clears on the next event (`apps/web/src/stores/thread-store/agent-event-preflight.ts:131-134`).
- Bug (verified path): Claude maps `allowed_warning` to `RateLimited { active: true }` (`claude-event-mapper.ts:558-581`), so `RetryBanner` says "Rate limited - retrying in …" when nothing is blocked (`threadStore.ts:2611-2617`, `RetryBanner.tsx:9-10`).
- Dead code (verified by search, no constructor): virtual item types `indicator`, `streaming`, `active-tools` (`apps/web/src/features/conversation/messages/virtual-items.ts:281-288`) and their renderers `StreamingIndicator`, `StreamingCard`, `ToolCallCard` (`apps/web/src/features/conversation/messages/timeline/TranscriptItemRenderer.tsx:73-87`).

### Subagents

- `SubagentRow` renders up to two ghost buttons with `SubagentIdentityGlyph` (palette-seeded coloured badge) and "started working"/"updated"/"finished", plus an aggregate "+N working, M finished" button (`apps/web/src/features/conversation/narrative/SubagentRow.tsx:65-78`, `211-327`). Child calls are already hidden (no inline rail; `:14`); the `children`, `hooks`, `depth`, `toolCall` props are unused in render.
- Overview: a "Subagents" label, up to 4 identity glyphs and "1 active, 2 done" (`apps/web/src/components/chat/ThreadOverview.tsx:2509-2523`, `2822-2853`). The glyph also appears in `features/subagents/roster/SubagentsPanel.tsx:153,257,324` and `features/subagents/detail/NarrativeDetailView.tsx:67`; palette vars live at `apps/web/src/index.css:63-67`, `136-140`.
- Provider icons exist per provider in `apps/web/src/components/chat/ProviderIcons.tsx:9-132`; F-06 wraps them.

### Tasks and queue

- Tasks are projected twice from tool names: web `projectTaskToolUse` (`apps/web/src/stores/threadStore.ts:1925-1940`) and server `task-tool-intent-reducer.ts` for persistence (`apps/server/src/features/agents/tasks/task-persistence-service.ts:16-41`). Sources: Claude native tools; Codex `turn/plan/updated` → synthetic `update_plan` (`codex-event-mapper.ts:1983-1991`); Cursor ACP `plan` → `TodoWrite` snapshot (`cursor-acp-event-mapper.ts:160`, `cursor/events/cursor-todo-snapshot.ts:231`). Devin drops ACP `plan` updates (`devin-acp-event-mapper.ts:128-135`). OpenCode treats `todo.*` as noise (`opencode-event-mapper.ts:608`). Copilot maps no task list (verified: nothing in `copilot-event-mapper.ts`). No source carries a task-list title.
- `TaskBubble` is a hover-open outline pill "3/4 steps" with a progress ring and `FileEffectFacts` (`apps/web/src/components/chat/TaskBubble.tsx:161-250`), mounted above the composer (`ComposerContentSurface.tsx:173-186`). `TaskPanel`/`TaskGroup` have no consumers (`apps/web/src/components/tasks/index.ts:1`). `TaskItem` uses amber, green and `animate-ping` (`components/tasks/TaskItem.tsx:12-40`).
- `ComposerQueueList`: "QUEUED" header with Continue and Clear all, drag handle, Send now (Zap, Claude only), Edit, Remove (`apps/web/src/components/chat/ComposerQueueList.tsx:118-405`; gate `apps/web/src/lib/model-registry.ts:405-415`).
- Bug (verified): while a turn runs, Send now only moves the message to the head of the queue (`apps/web/src/features/conversation/composer/queue/useQueuedMessageDispatch.ts:56-63`); the list's docstring says it stops the agent (`ComposerQueueList.tsx:44-49`), and so does the Claude-only gate's (`model-registry.ts:396-415`, read at `ComposerQueueList.tsx:109`).
- Nothing steers into a running turn today (verified: no steer path in `packages/providers` or `apps/server`). A send while a turn runs fails at the thread's mutation reservation (`turn-runtime-controller.ts:486,500-507`; `thread-control-mutation-reservation-service.ts:24-32` returns null while one is held), which is why the client queues follow-ups.
- Queued messages are deleted when a turn errors (`threadStore.ts:2688`). S08 (08f) should decide whether they survive.

### Overview, scroll, Stop

- Overview Changes: green/red mono counts (`ThreadOverview.tsx:2633-2645`) resolved by up to four RPCs (`:884-958`) and re-resolved on every `files.changed` push (`apps/web/src/transport/ws-events.ts:383-390` bumps `diffRevision`). With the overview open by default, this runs throughout a turn (inferred frequency).
- Overview Plans: "Plans" + latest plan title (`ThreadOverview.tsx:2655-2676`). Usage: collapsible, green/amber/red fills (`:563-575`, `649-790`).
- Jump: `ScrollToBottomButton`, 28px icon, amber when new content (`apps/web/src/features/conversation/messages/ScrollToBottomButton.tsx:13-29`; mounted `MessageListOverlays.tsx:115-125`, `MessageList.tsx:516-517`).
- Stop: red `bg-destructive` send-position button and red inline stop (`ComposerContentSurface.tsx:397-420`, `520-527`). Full access chip is already muted (`apps/web/src/features/conversation/composer/ComposerOptionControls.tsx:65`); its picker check is amber (`:98`), which S06 owns.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Thought row (all six providers) | Reasoning shows as prose (3 providers) or not at all (3) | `reasoningDelta` event, segment `kind`, collapsed Thought row | contracts, server, providers, web |
| Narration and answer at 16/28 | `text-sm` | `--text-prose` / `--leading-prose`; 2×18 amber caret | web |
| Collapsed tool rows, inline chevron | Full-width, badges, red output | Fit-content 28px row, muted failures, chevron after content | web |
| Running shell header only | Auto-opens empty card | No auto-open; header "Running command `cmd` ›" | web |
| Durations m:ss | "in 2.4s", "(0:22)" | One `formatClock` helper | web |
| Status labels incl. Answering, Waiting on subagents, Stopping, Compacting, Rate limited | "Thinking...", subagent count, banners | `deriveRunStatus` + spinner icon for holding states | web, providers (signals) |
| Subagent chips with provider icon | Coloured identity glyph | Bordered pill with `ProviderIcon` | web |
| Overview Subagents (3 discs) | Label + 4 glyphs | Disc stack (F-06) + "1 active · 7 done" | web |
| Tray task row with segments | "3/4 steps" pill | Tray row, segments B, upward list; titled "Tasks" or the plan's title (R1) | web |
| Task lists for Devin, OpenCode | None | Adapter snapshots as `TodoWrite` | providers |
| Queue rows Send now / Edit / Remove | Header, drag, Zap, Claude-only; Send now while running only reorders | Three icon buttons in the tray; Send now steers while running, shown only where the provider declares `turn-steer` (R2) | contracts, server, providers (Claude, Codex), web |
| Overview Changes / Tasks / Usage | RPC chain, "Plans", collapsible colour bars | Live counts while running, task row, neutral bars | web |
| Jump to latest pill + fade | 28px icon | Labelled pill, neutral | web |
| Stop neutral | Red | Ink circle, background square | web |

## Backend architecture

### 1. Reasoning as its own event and segment kind (one seam)

Contract (`packages/contracts/src/events/agent-event.ts`):

```ts
AgentEventType.ReasoningDelta = "reasoningDelta";

z.object({
  /** Provider reasoning (Claude thinking, Codex reasoning, ACP agent_thought_chunk). Never final-response text. */
  type: z.literal(AgentEventType.ReasoningDelta),
  threadId: z.string(),
  /** Reasoning text; "" when the provider reports reasoning without text (redacted or omitted thinking). */
  delta: z.string().max(65_536),
  /** Provider-stable id of one reasoning block in this execution. A new id closes the previous block. */
  reasoningItemId: z.string().min(1).max(256).optional(),
  /** Provider's explicit end of this block. Otherwise the block closes at the next non-reasoning semantic event. */
  done: z.boolean().optional(),
})
```

Record (`packages/contracts/src/models/thought-segment.ts`): add `kind: z.enum(["narration", "reasoning"]).optional()`; absent means narration (legacy rows). DB: `thought_segments.kind text not null default 'narration'` via a generated Drizzle migration (next file after `apps/server/drizzle/0068_tricky_morg.sql`).

Server:
- `NarrativeTurnState.openOrExtendReasoning(threadId, delta, reasoningItemId)` and `closeOpenReasoning` mirror `openOrExtendThought`/`closeOpenThought` (`narrative-turn-state.ts:273-313`). Opening reasoning closes open narration and the reverse; `done` or any `ToolUse`/`TextDelta`/turn end closes it. Reasoning segments never enter `settleAssistantTextItem` or the final-response suffix safeguard (`:1262-1274`). Recovery items carry `kind`.
- `ProviderTurnEventApplication.applyNarrativeEvent` and `codex-live-event-reducer.ts:306` add the `ReasoningDelta` case. `validNarrativeEvent` adds `"reasoningDelta"` (`canonical-execution-semantic-writer.ts:1656-1663`). The canonical item kind stays `"reasoning"` for both segment kinds; `record.kind` disambiguates, and the display materializer copies it.
- New ADR (next free number at merge; 0022 is already taken): reasoning keeps the narrative persistence path, not the text sidecar. Each `reasoningDelta` is a semantic event, so pending answer text flushes before it; reasoning and answer text rarely interleave, so the cost matches today's non-final text path.
- Idempotency: same `reasoningItemId` re-delivered is a no-op once closed (same rule as `textItemId`, `narrative-turn-state.ts:275-276`). No backfill: legacy reasoning rows stay prose because nothing in them reliably marks reasoning.

Web: `ThoughtSegment.kind`; `narrative-projection.ts` appends reasoning; `NarrativeItem` gains `{ type: "reasoning"; segment; isActive }`; `computeLiveStreamingText` and `currentActivityHeading` skip reasoning segments; step counts never include segments.

Per provider (see the decision table for citations):

| Provider | Emit |
|---|---|
| Claude | `content_block_start` thinking/redacted_thinking opens (block index → id), `thinking_delta` text, `content_block_stop` → `done`. Redacted → `""` delta (duration only). Verify whether the Agent SDK returns thinking text for adaptive thinking on current models (inferred: may be summarized or omitted). |
| Codex | `item/reasoning/textDelta` and `summaryTextDelta` with `itemId`; `item/completed` reasoning → `done`. Check for doubled text when both delta kinds stream for one item (inferred risk; today both append to one buffer). `item/plan/delta` is S07's, unchanged. |
| Cursor | `agent_thought_chunk` → `reasoningDelta` (no explicit end). |
| Copilot | Map SDK reasoning events and `phase: "thinking"` messages (event names inferred, `assistant.reasoning_delta`/`assistant.reasoning`; `node_modules` is absent in this worktree, so confirm against pinned `@github/copilot-sdk ^0.2.2`). |
| Devin | `agent_thought_chunk` → `reasoningDelta`. |
| OpenCode | `reasoning` parts (part id → `reasoningItemId`) and `session.next.reasoning.started/delta/ended` (`ended` → `done`). |

### 2. Run status (pure derivation, no new wire data)

```ts
/** Single source for the status line label and icon. */
type RunStatus = { label: string; icon: "layers" | "spinner" };

function deriveRunStatus(input: {
  stopPending: boolean;                       // threadStore.pendingStopCounts
  compacting: boolean;                        // record.isCompacting
  retry?: { rateLimited: boolean; retryAt?: number }; // RateLimited(active) or ApiRetry, retryAt = receivedAt + delay
  waitingFor?: "approval" | "answers";        // S06 / S07 own these inputs
  activeTool?: ToolCall;                      // latest incomplete top-level, non-Agent
  subagentsRunning: boolean;                  // subagent-lifecycle, not raw Agent completion
  answering: boolean;                         // provisional answer slot non-empty
  reasoningOpen: boolean;
  now: number;
}): RunStatus;
```

Precedence (first match wins):

| State | Label | Icon | Owner |
|---|---|---|---|
| Stop in flight | Stopping | spinner | S05 |
| Compacting | Compacting context | spinner | S05 |
| Rate limited / retrying | Rate limited · Retrying (no countdown; S08F-09's quiet line under the work carries the attempt and countdown, decision R7) | spinner | S05 |
| Pending approval | Waiting for approval | layers | S06 |
| Plan questions / planning | Waiting for your answers · Planning | layers | S07 |
| Shell running | Running `<command, one line, bounded>` | layers | S05 |
| Read / Edit / Write running | Reading `<file>` · Editing `<file>` · Writing `<file>` | layers | S05 |
| Other tool running | Present label without ellipsis (Searching the codebase, Searching the web, Fetching a page …) | layers | S05 |
| Only subagents running | Waiting on subagents | layers | S05 |
| Answer streaming | Answering | layers | S05 |
| Default (incl. open reasoning) | Thinking | layers | S05 |

"Answering" uses the same predicate as the provisional answer slot, so the label never disagrees with the screen. Claude narration before a first tool call can read "Answering" briefly before the tool label replaces it (inferred; this matches where the text renders today). The shell label uses the command for every provider, not Claude's `description`, so all providers read alike.

Computed in `virtual-items.ts` `narrativeIndicatorItem`, so `NarrativeIndicator` only renders `{ stepCount, label, icon, startTime }`. Countdown uses the indicator's existing 1s tick.

### 3. Adapter signals for in-turn states

No contract change. Adapter fixes: Claude emits `RateLimited { active: true }` only for `rejected` (a warning is usage, not a block). Codex maps the `contextCompaction` item to `Compacting` start/end (today silent). OpenCode maps `retry` parts and `session.next.retried` to `ApiRetry`. Others: see table.

### 4. Task lists (no new contract)

Keep the existing tool-name protocol and both reducers. Add one shared constant `TASK_LIST_TOOL_NAMES` in `packages/contracts` used by the server reducer, the web projection, and a timeline filter that drops these calls from rows and step counts. Devin and OpenCode normalize to `TodoWrite` snapshots in the adapter (S05-13).

Title (R1). No provider supplies one, so the client derives it: the plan's title when the task list belongs to a turn that implements a plan version, else "Tasks". It never uses the thread title. A turn implements a version when that version's `acceptedMessageId` (S07-07, `07-plan-mode.md` Data shapes) equals the turn's user message id; for a retried turn, its first attempt's message (E2). Until S07-07 lands, every list reads "Tasks".

Tray and overview read one selector:

```ts
interface TaskProgress {
  title: string;              // the implemented plan version's title, else "Tasks" (R1)
  settled: number;            // completed + cancelled
  total: number;
  segments: readonly ("done" | "current" | "pending")[]; // completed|cancelled, in_progress, pending
}
```

### 5. Shell output (not built)

Running shells show the header only for every provider. A future `ToolOutputDelta` would draw on Codex `item/commandExecution/outputDelta` (buffered today, `codex-event-mapper.ts:2006-2010`), ACP `tool_call_update` content (Cursor, Devin; inferred), and OpenCode running tool state (inferred). Claude reports only `tool_progress` heartbeats (`claude-event-mapper.ts:546-556`). No ticket now.

### 6. Send now steers (S05-10)

Steering adds the user's message to the turn that is running, without stopping it (R2). One capability gates it: `turn-steer`, added to `ProviderCapabilityNameSchema` (`packages/agent-model/src/capabilities.ts:5-21`). The web shows Send now on a queued row while a turn runs only when the thread's provider declares it `supported`.

```ts
// packages/contracts/src/ws/methods.ts
"agent.steer": {
  params: z.object({
    threadId: z.string().min(1).max(256),
    turnExecutionId: z.string().min(1).max(256),   // the running turn the user saw; a precondition
    messageId: z.string().uuid(),                  // client id: a replay returns the first result
    // plus the message fields agent.send takes (content, mentions, attachments), with the same schemas and bounds
  }).strict(),
  result: z.object({ messageId: z.string() }).strict(),
}
// Failures: turn_not_running (the turn ended or another turn runs), steer_unsupported.

// packages/contracts/src/providers/interfaces.ts, next to sendTurn (:178)
steerTurn?(input: Pick<TurnRequest, "threadId" | "message" | "attachments"> & { turnExecutionId: string }): Promise<void>;
```

- Server: `TurnRuntimeController.steer` checks that `turnExecutionId` is the thread's running turn and that the adapter declares `turn-steer`, then calls `steerTurn`. It does not take the mutation reservation the running turn already holds. The steered text persists as a user message inside the running turn, so the transcript shows it at the point it was sent and it survives a reload (inferred: no canonical event carries a mid-turn user message today; the ticket adds one with the canonical writer).
- A failed steer never loses the message: the client keeps the row queued and shows the error on it. A turn that ended first returns `turn_not_running`, and the row then behaves as an idle Send now.
- Removed: the Claude-only `PROVIDERS_WITH_SEND_NOW` gate (`model-registry.ts:396-415`) and the head-of-queue move (`useQueuedMessageDispatch.ts:56-63`). Nothing called "Send now" sends next.

Per adapter. Evidence is the code as it is today; where a provider's native protocol is not vendored in this worktree, the source is named.

| Provider | Native steer | How Mcode sends a turn today | `turn-steer` |
|---|---|---|---|
| Claude | Yes, inferred: an `SDKUserMessage` with `priority: "now"` pushed into the live query. T3 Code steers this way (cached source `.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7518-7550`, declared at `:200-202`) on SDK `^0.3.276`; Mcode pins `^0.3.212` (`packages/providers/package.json:18`), so confirm the field exists or bump the SDK in the ticket. The steer aborts the current stream or tool, and the query ends that segment with `terminal_reason` `aborted_streaming` or `aborted_tools`, which must not read as an interrupted turn (same file, `:2426-2430`). | One long-lived `query()` fed by a prompt queue (`claude-provider.ts:200-279`); each turn pushes a message (`:1405`, `:1906`) built without `priority` (`:282-292`). Pushing mid-turn without `priority` would queue the message for after the turn (inferred). | supported after S05-10 |
| Codex | Yes: app-server `turn/steer` with `expectedTurnId` (cached source `.opensrc/repos/github.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/common.rs:1056-1061`, params at `v2/turn.rs:308-333`). | `turn/start` (`codex-app-server.ts:1191`) and `turn/interrupt` (`:1136`); the adapter already tracks `activeTurnId` (`:963`, `:1088`), which `expectedTurnId` needs. It never calls `turn/steer`. | supported after S05-10 on CLIs that accept `turn/steer`; the ticket measures the minimum version and records it next to `CODEX_MIN_VERSION` (`codex-provider.ts:98`); older CLIs declare it unsupported |
| Cursor | No: ACP has one `session/prompt` per turn and no way to add input to it. T3 Code declares Cursor and its generic ACP adapter unable to steer (cached `CursorAdapterV2.ts:106`, `AcpAdapterV2.ts:562`). | One ACP prompt per turn (`cursor-turn-executor.ts:161`). | unsupported: Send now hidden while a turn runs |
| Copilot | Unknown: SDK `^0.2.2` (`packages/providers/package.json:20`) is not vendored here, and no evidence shows it accepting input into a running turn. | `session.send` per turn (`copilot-provider.ts:222`). | unsupported until a captured trace proves it |
| Devin | No: the same ACP rule as Cursor. | One ACP prompt per turn (`devin-provider.ts:601`). | unsupported |
| OpenCode | Unknown for the server Mcode drives: newer OpenCode accepts a prompt with `delivery: "steer"` (cached T3 Code `OpenCode2AdapterV2.ts:8-10`), but Mcode's adapter targets `prompt_async`, and no trace shows that endpoint steering. | `prompt_async` (`opencode-http-client.ts:320-325`). | unsupported until a captured trace on Mcode's supported OpenCode version proves it |

Capability declarations to extend: Claude `claude-provider.ts:471-475`, Codex `codex-provider.ts:116-130`, Cursor `cursor-provider.ts:149-156`, Copilot `copilot-provider.ts:37`, Devin `devin-provider.ts:159-168`, OpenCode `opencode-provider.ts:47,257`. Unsupported providers declare `turn-steer` as `unsupported`, so the decision is written down per adapter.

### Per-provider decision table

| Capability | Claude | Codex | Cursor | Copilot | Devin | OpenCode |
|---|---|---|---|---|---|---|
| Reasoning → Thought row | Change: map thinking blocks (`claude-event-mapper.ts:515-531` drops them) | Change: re-route reasoning (`codex-event-mapper.ts:1970-1976`, `2198-2202`) | Change: re-route (`cursor-acp-event-mapper.ts:159`) | Change: map reasoning (`copilot-event-mapper.ts:61` drops) | Change: re-route (`devin-acp-event-mapper.ts:131`) | Change: map (`opencode-event-mapper.ts:472`, `631`) |
| Task list | No change (native tools) | No change (`update_plan`, `:1983-1991`) | No change (`TodoWrite` snapshot) | No change: none available (inferred), no tray | Change: ACP `plan` → `TodoWrite` (S05-13) | Change: todos → `TodoWrite` (S05-13; event shape inferred) |
| Subagent chips, provider icon | No change (icon and status from the S12P-08 roster entry) | No change | No change; late metadata is S12's | No change in S05; child roster is S12's (`copilot-provider.ts:489-493` tracks, never emits `Agent`) | No change (`devin-acp-event-mapper.ts:386-394`) | No change; `subtask` parts are state-only (`opencode-event-mapper.ts:267-268`), S12 decides |
| Compacting | No change (`claude-event-mapper.ts:360-370`) | Change: map `contextCompaction` (`codex-event-mapper.ts:67-70` silent) | No change: no signal (`cursor-acp-session-trace.ts:89-94` only summarizes) | No change (`copilot-event-mapper.ts:109-112`) | No change: no signal | No change (`opencode-event-mapper.ts:603-606`, `632-636`) |
| Rate limited / retry | Change: warning is not a block (`:558-581`); ApiRetry no change (`:381-390`) | No change: ApiRetry without delay (`:2108-2115`), label "Retrying" | No change: no signal | No change: no signal (inferred) | No change: no signal | Change: map retries (`:268`, `588`; fields inferred) |
| Live shell output | Not built | Not built | Not built | Not built | Not built | Not built |
| Steer (Send now while running, section 6) | Change: `priority: "now"` push, declare `turn-steer` (S05-10) | Change: `turn/steer`, declare `turn-steer` on CLIs that accept it (S05-10) | No change: cannot steer; declare `unsupported` | No change: unproven; declare `unsupported` | No change: cannot steer; declare `unsupported` | No change: unproven; declare `unsupported` |

### Streaming performance (zero-lag pillar)

- Collapsed Thought rows must not re-render per reasoning delta: compare `startedAt`, `endedAt`, `isActive` and `hasText`, not `segment` identity (today `NarrativeRow.tsx:50-55` compares identity). Text renders only when expanded.
- The status line tick stays local to `NarrativeIndicator`; `deriveRunStatus` runs in `virtual-items.ts` where the item equality already guards re-renders (`virtual-items.ts:651`).
- The overview is open by default, so its new rows must subscribe through selectors that return primitives (`{active, done}`, `TaskProgress` fields) with shallow equality, never to streaming text or the whole record. `ThreadOverview.tsx` is 2,954 lines; one broad subscription re-renders all of it per event.
- Changes row: while a turn runs, read the live `fileEffectSummary` (already pushed, no RPC) instead of re-running the four-RPC resolver on every `files.changed` push; run the resolver on settle, debounced.
- Drop the mask-position shimmer from the status label and "Running command" label (pending the user's answer): it repaints every frame for the whole turn (`apps/web/src/index.css:656-666`). Keep the layers icon's transform/opacity motion. Also drop `animate-ping` in task rows.

## Components

### New

- `NarrativeToolRow` primitive (web, `features/conversation/narrative/`): 28px tall, inline-padding 8, gap 8, radius `--radius-6`, `width: fit-content`; 14px icon (`--color-muted`, stroke 1.5); label 14/500 muted; optional detail (file: mono 12 muted; command: mono 13 ink); optional duration mono 12 muted; 14px chevron-right muted right after content, rotates open. Used by tool groups, shell header, Thought row (05a `2192-2`, 05f `2CNZ-2`, `2CQ2-2`, `2COB-2`).
  - Running shell: "Running command" + command, no duration. Done: "Ran command" + `0:02` + command. Failed: "Ran command" + command + `exit 1 · 0:03` (05f `2CQ2-2`; Paper puts the duration after the command here and before it on 05b, so use the 05b order for success and the 05f order for failure). Single failed call: "<Verb> failed" + detail ("Edit failed `ThreadActionsMenu.tsx`"). Multi-call group with failures: summary + " · 1 failed" muted (proposal, not drawn).
- `ThoughtRow`: brain icon (05f `2COB-2`), "Thought" + duration mono; active reads "Thinking" with no timer; chevron hidden when no text; expanded body is the reasoning text in the settled markdown adapter at 14px muted (proposal, not drawn).
- `formatClock(seconds)`: `m:ss`, `h:mm:ss` from one hour (the hour form is a proposal).
- `deriveRunStatus` (pure) and the restyled status line: 24px row, padding-left 8, gap 6 (05a; 05f uses 8); 14px icon (amber layers `--color-primary`, or muted spinner for holding states); "N steps ·" 12 muted (hidden at 0); label 12/500 ink; timer mono 12 muted.
- `ComposerTray`: width = composer − 28 (732 at 760), centred, `--color-panel`, top radii 12, padding 4/8, 40px rows, flush on the composer top (`296A-2`). Task row first, queue rows below. Hidden when empty.
  - Task row: 16px list-checks icon muted; title 14 `--weight-label` ink in an F-02 fade clip; segments 12×4, radius 2, gap 2 (done `--color-ink`, current `--color-muted`, pending `--color-border`); count 14 sans tnum muted ("3/4"; Paper uses sans with tabular numbers, not mono); 32px round chevron-up (F-03). Click or Enter expands the list upward inside the tray; Esc collapses.
  - Queue row: 16px corner-down-right icon muted; text 14 ink with fade; 96px action slot of three 32px icon buttons: arrow-up Send now, pencil Edit, x Remove (16px muted icons, tooltips name the action).
- `SubagentChip`: 28px, radius full, 1px `--color-border`, padding 6/10, gap 6; 16px provider icon in a 16×20 slot; title 12/500 ink; status 12 muted from S12P-08's `subagentChipWord` ("working", "finished", "stopped"; "failed" in `--color-error` per `129W-0`); chips gap 8; overflow chip "+2 working, 1 finished" (`29HO-2`, `129W-0`).
- Overview rows (inside the S03 shell): 32px, gap 8, 16px icon slot, title 14 ink with fade, meta 12 muted.
  - Changes: plus-minus icon, "Changes", "+4 −9" (U+2212), hidden when zero (`21DN-2`).
  - Tasks: list-checks icon, task-list title, "3/4" tnum (`29LT-2`). S07 swaps in the doc icon and plan title when a plan backs the tasks.
  - Subagents: F-06 disc stack of the roster entries' providers (max 3, 20px, 12px step, 1.5px `--color-panel` ring, `--color-selected` fill, 12px ink icon) + "1 active · 7 done" 12 muted from S12P-08's `countSubagents` (`29M1-2`). Click opens the Subagents panel.
  - Usage: "Usage" 12/500 muted header (24px); per category label and "62% · resets 16:00" 12 muted; 4px bar, track `--color-hover`, fill `--color-muted`, radius 2; gap 12 between categories, 6 within; always expanded (`21E5-2`).
- `JumpToLatestPill`: 32px, radius full, `--color-selected`, 1px `--color-border`, shadow `#00000059 0 8px 24px`, padding 10/12, gap 6, 14px arrow-down ink, "Jump to latest" 12/500 ink; centred on the conversation column above a 56px gradient from `--color-background` to transparent that ends at the tray top (`29YT-2`, `29YR-2`, `29YS-2`).

### Changed

- `NarrativeIndicator`: renders `RunStatus`; no subagent count, no parens, no "Done" swap.
- `ToolSummaryLine`, `ShellToolCallRow`, `ActiveToolRow`, `NarrativeSummaryLine`: use `NarrativeToolRow`; shell never auto-opens; expanded shell card keeps the Components "Shell" anatomy (`129W-0`) with `formatClock`.
- `ThoughtBlock` → narration prose at `--text-prose`/`--leading-prose`; `MessageBubble` assistant body the same; `.typing-cursor` 2px × 18px `--color-primary`.
- `SubagentRow` → `SubagentChip`s that read their S12P-08 roster entry. The glyph-to-`ProviderIcon` swap in every caller is F-06's.
- `ComposerQueueList` → queue rows inside `ComposerTray`. Send now while idle dispatches immediately (as today); while a turn runs it steers (section 6) and shows only for a provider that declares `turn-steer`.
- Composer send position: Stop = 40px `--color-ink` circle with a 14px `--color-background` square (radius 2); with a draft, a ghost square stop beside the amber Send (`L95-0`); stop requested = muted circle with spinner (`L9T-0`).
- `CONTEXT.md` "Reasoning block" and "Task bubble" entries, and `docs/internals/conversation/narrative-pipeline.md` (lines 1-7 status line, 16-31 shell rows, 207-210 shimmer, invariant 6) are rewritten by the tickets that change them.

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| Legacy item types `indicator`, `streaming`, `active-tools` and `StreamingIndicator`, `StreamingCard`, `ToolCallCard` | `virtual-items.ts:281-288`, `TranscriptItemRenderer.tsx:73-87`, `message-list-virtualization.ts:21-23`, `components/chat/` | Nothing (dead) | S05-01 | `rg -n "StreamingIndicator\|StreamingCard\|ToolCallCard\|\"active-tools\"" apps/web/src` returns nothing |
| `TaskPanel`, `TaskGroup`, `components/tasks/index.ts` | `apps/web/src/components/tasks/` | Nothing (no consumers) | S05-01 | `rg -n "TaskPanel\b\|TaskGroup" apps/web/src` returns nothing |
| Ellipsis phase labels, "Thinking...", subagent count, "(m:ss)", "Done" swap, status-label shimmer | `NarrativeIndicator.tsx:122-162`, `activity-label.ts:41-49`, `constants.ts:69-84`, `components/chat/tool-renderers/AgentRenderer.tsx:15` | `deriveRunStatus`, `formatClock` | S05-02 | `rg -n "Thinking\.\.\.\|Thinking deeper\|Running a command\.\.\." apps/web/src` returns nothing |
| `CompactingBanner` and its composer mount | `components/chat/CompactingBanner.tsx`, `ComposerContentSurface.tsx:7,372` | Status line "Compacting context" | S05-02 | `rg -n "CompactingBanner" apps/web/src` returns nothing (`RetryBanner` is S08F-09's row in section 04-08f) |
| `StatusBadge`, red collapsed output, shell auto-open, "in {duration}", amber/red shell icon | `ToolSummaryLine.tsx:53-69,114-121`, `ShellToolCallRow.tsx:50-54,138-142,241` | `NarrativeToolRow` | S05-04 | `rg -n "StatusBadge\|in \{duration\}\|manualOpen \?\? status\.isRunning" apps/web/src/features/conversation/narrative` returns nothing |
| Task-list tools as timeline rows and steps; TodoWrite branch of `GenericRenderer` if then unused | live/persisted timeline builders, `GenericRenderer.tsx:20-21` | Tray and overview task row | S05-04 | `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/build-narrative-counts.test.ts` passes, including "a turn with TodoWrite and Read yields one row and one step" (`TodoWrite` stays a tool name the task projection reads) |
| `text-sm` narration/answer prose, 1.5px caret | `ThoughtBlock.tsx:29`, `MessageBubble.tsx:857-861`, `index.css:874-882` | Prose tokens | S05-05 | `rg -n "text-sm" apps/web/src/features/conversation/narrative/ThoughtBlock.tsx` returns nothing |
| Reasoning as non-final `TextDelta` | Codex `:1970-1976,2198-2202`; Cursor `:199-207`; Devin `:151-156` | `reasoningDelta` | S05-06 | `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts src/private/cursor/acp/__tests__/cursor-acp-event-mapper.test.ts src/private/devin/__tests__/devin-acp-event-mapper.test.ts` passes, each asserting `reasoningDelta` and no `textDelta` for reasoning input (the mappers keep their reasoning handlers) |
| Copilot thinking drop, OpenCode `reasoning-not-surfaced` | `copilot-event-mapper.ts:61`, `opencode-event-mapper.ts:472,598-600,631` | `reasoningDelta` | S05-07 | `rg -n "reasoning-not-surfaced" apps/server/src` returns nothing |
| Chip lifecycle words "started working" and "updated", unused `SubagentRow` props (`children`, `hooks`, `depth`, `toolCall`), overview "Subagents" label and 4-icon stack with comma copy | `SubagentRow.tsx:10-20,66-67`, `ThreadOverview.tsx:2509-2523,2822-2853` | `SubagentChip` words from S12P-08's `subagentChipWord`, `ProviderDiscStack` with `countSubagents` | S05-08 | `rg -n "started working\|subagentGlyphRows" apps/web/src` returns nothing |
| `TaskBubble` pill, `ProgressCircle`, `FileEffectFacts`, `TaskPanelHeader`, hover popover, `animate-ping` task mark | `components/chat/TaskBubble.tsx`, `FileEffectFacts.tsx`, `components/tasks/TaskPanelHeader.tsx`, `TaskItem.tsx:30-40` | `ComposerTray` task row | S05-09 | `rg -n "TaskBubble\b\|FileEffectFacts\|TaskPanelHeader\|ProgressCircle\|bg-primary/25 animate-ping" apps/web/src/components` returns nothing (the banners' `motion-safe:animate-ping` goes with their own rows) |
| Queue header (QUEUED, Continue, Clear all), Zap icon, drag handle and dnd-kit reorder (R3), the Claude-only Send now gate and the head-of-queue move that Send now makes while a turn runs (R2) | `ComposerQueueList.tsx:109,118-405`, `model-registry.ts:396-415`, `useQueuedMessageDispatch.ts:56-63` | Tray queue rows; Send now steers (section 6) | S05-10 | `rg -n "Clear all queued messages\|PROVIDERS_WITH_SEND_NOW\|providerSupportsSendNow" apps/web/src` returns nothing (`Zap` and `GripVertical` stay legitimately in other components); `bun run --cwd apps/web test -- src/features/conversation/composer/queue/useQueuedMessageDispatch.test.tsx` passes, including "Send now while a turn runs steers and never reorders the queue" |
| Overview "Plans" text row, green/red change counts, collapsible coloured usage | `ThreadOverview.tsx:2655-2676,2633-2645,563-575,649-790` | Tasks, Changes, Usage rows | S05-11 | `rg -n "usageCategoryFillClass\|usageCategoryMetricClass\|>Plans<" apps/web/src` returns nothing |
| `ScrollToBottomButton` and its amber variant | `messages/ScrollToBottomButton.tsx`, `MessageListOverlays.tsx:115-125` | `JumpToLatestPill` | S05-12 | `rg -n "ScrollToBottomButton" apps/web/src` returns nothing |
| Red Stop styles | `ComposerContentSurface.tsx:411,523-524` | Neutral Stop | S05-12 | `rg -n "bg-destructive text-white\|text-destructive/60" apps/web/src/features/conversation/composer` returns nothing |
| Inline child rail | Already absent in chat (`SubagentRow.tsx:14`) | Chips | S05-08 keeps it absent | `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/SubagentRow.test.tsx` passes, including "renders no child rows" |

## Proposed tickets

### S05-01 Delete dead transcript renderers and the orphan task panel

- **Blocked by:** None (can start immediately).
- **Boards:** none (prefactor)
- **Delivers:** No visible change; removes code later tickets would otherwise have to edit.
- **Build notes:** web only. Remove the three legacy `ChatVirtualItem` variants, their equality functions (`virtual-items.ts:597-605,656`), size estimates, renderers and components; remove `TaskPanel`, `TaskGroup`, `components/tasks/index.ts`, `TaskGroup.test.tsx`.
- **Deletes:** ledger rows 1-2.
- **Acceptance criteria:**
  - [ ] Both proof commands return nothing.
  - [ ] `bun run typecheck` and `bun run lint` pass for `apps/web`.
- **Verify:** `bun run --cwd apps/web test -- src/__tests__/virtual-items.test.ts src/__tests__/virtual-items-render.test.tsx`; live: `agent:up`, run one turn on `.dev/fixture-repo`, transcript renders as before.

### S05-02 Status line: labels, clock and holding states

- **Blocked by:** S05-01 Delete dead transcript renderers and the orphan task panel; F-01b Token vocabulary rename.
- **Boards:** 05a `213P-2`, 05b `28OG-2`, 05c `29B3-2`, 05f `2CNV-2` (states 3, 4, 6, 7)
- **Delivers:** The status line reads "4 steps · Running bun run lint 0:42", "Answering", "Waiting on subagents", "Stopping", "Compacting context", "Rate limited" or "Retrying", with a spinner icon for the last three. The countdown and attempt live on S08F-09's quiet line under the work (R7), so the status line never repeats them. The compacting banner is gone; the retry banner is replaced by S08F-09's provider retrying line.
- **Build notes:** web. Add `formatClock` (`lib/time.ts`) and `deriveRunStatus` (precedence table above); compute in `narrativeIndicatorItem` (`virtual-items.ts:538-542`) and extend its equality. Store `retryAt` on receipt in `handleRateLimited`/`handleApiRetry` (`threadStore.ts:2611-2622`). Accept `waitingFor` as an input S06/S07 fill later. Remove the shimmer only if the user agrees (open question). Rewrite `narrative-pipeline.md` lines 1-7 and 207-210.
- **Deletes:** ledger rows 3-4.
- **Acceptance criteria:**
  - [ ] Each precedence row has a unit test; "Answering" is true exactly when the provisional answer slot is non-empty.
  - [ ] Timer reads m:ss with no parens; no subagent count.
  - [ ] While the provider waits to retry, the status line reads "Rate limited" or "Retrying" with no number, and clears on the next event.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/NarrativeIndicator.test.tsx src/features/conversation/narrative/__tests__/activity-label.test.ts`; live (Electron harness): run a Claude turn that reads a file and runs `bun run lint`; status line shows "Reading …", "Running bun run lint", then "Answering"; press Stop and see "Stopping" with the spinner.

### S05-03 In-turn state signals per adapter

- **Blocked by:** S05-02 Status line: labels, clock and holding states.
- **Boards:** 05f `2CNV-2` (states 6, 7)
- **Delivers:** Compacting and retry states appear for every provider that can report them, and a Claude usage warning no longer reads as rate limited.
- **Build notes:** providers. Claude `rateLimit` (`claude-event-mapper.ts:558-581`): active only for `rejected`. Codex: map `contextCompaction` start/complete to `Compacting` (`codex-event-mapper.ts:67-70`; confirm `item/started` fires for it with a fixture). OpenCode: `retry` part and `session.next.retried` → `ApiRetry` with attempt and delay where present. Cursor, Copilot, Devin: no change (table).
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] Claude `allowed_warning` emits no active `RateLimited`; `rejected` does.
  - [ ] Codex compaction emits `Compacting` true then false.
  - [ ] OpenCode retry emits `ApiRetry`.
- **Verify:** `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-event-mapper.test.ts src/__tests__/codex/codex-event-mapper.test.ts`; `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-event-mapper.test.ts`; live: trigger `/compact` in a Codex thread, status line shows "Compacting context".

### S05-04 Collapsed tool rows with inline chevron

- **Blocked by:** S05-02 Status line: labels, clock and holding states; F-01b Token vocabulary rename.
- **Boards:** 05a `213P-2`, 05b `28OG-2`, 05f `2CNV-2` (states 1, 5); Components `129W-0`
- **Delivers:** Tool groups, edits (pencil) and shells read as quiet one-line rows; a running shell shows only "Running command `bun run lint` ›"; failures are muted text, not red badges; task-list tools no longer appear as rows or steps.
- **Build notes:** web. Build `NarrativeToolRow`; port `ToolSummaryLine`, `NarrativeSummaryLine`, `ActiveToolRow`, `ShellToolCallRow`. Map Codex `fileChange`/`apply_patch` and ACP edit kinds to `Edit` in `resolveToolName` (`constants.ts:48-61`) so edits get the pencil. Add `TASK_LIST_TOOL_NAMES` to `packages/contracts` and use it in the live and persisted builders, the server task reducer and `projectTaskToolUse`. Keep virtual expansion and row-position retention (`narrative-pipeline.md:102-108`). Rewrite `narrative-pipeline.md` lines 16-31.
- **Deletes:** ledger rows 5-6.
- **Acceptance criteria:**
  - [ ] Running shell row is collapsed until clicked; a manual open survives output arrival.
  - [ ] Durations read `0:02`; failed command reads `exit 1 · 0:03`; single failed edit reads "Edit failed `<file>`".
  - [ ] A turn with `TodoWrite` and one `Read` shows one row and "1 step".
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/ShellToolCallRow.test.tsx src/features/conversation/narrative/__tests__/tool-row-overflow.test.tsx src/features/conversation/narrative/__tests__/build-narrative-counts.test.ts`; live: Codex turn on the fixture repo that edits a file and runs a failing command; rows match 05a and 05f state 5.

### S05-05 Narration and answer as 16px prose

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** 05a `213P-2`, 05b `28OG-2` (`28UX-2`)
- **Delivers:** Narration and the streaming and settled answer read at 16/28 ink; the caret is a 2×18 amber bar.
- **Build notes:** web. `ThoughtBlock.tsx:29`, `MessageBubble.tsx:857-861`, `DeltaBlock` paragraph classes (`DeltaBlock.tsx:300,347,419`), `.typing-cursor`. Narration wrapper padding-top 4; turn item gap 12. Code blocks stay 14px. Check the virtual-row height estimate for streaming text.
- **Deletes:** ledger row 7.
- **Acceptance criteria:**
  - [ ] Live and persisted narration and answer use `--text-prose`/`--leading-prose`.
  - [ ] Caret stays inline at the end of the last word (Trap 4 rule kept).
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/DeltaBlock.test.tsx`; live: stream a long answer and confirm no scroll jump at the swap to the persisted message.

### S05-06 Reasoning seam and collapsed Thought row (Codex, Cursor, Devin)

- **Blocked by:** S05-02 Status line: labels, clock and holding states; S05-04 Collapsed tool rows with inline chevron.
- **Boards:** 05f `2CNV-2` (state 2, `2COB-2`)
- **Delivers:** Codex, Cursor and Devin reasoning shows as a collapsed "Thought 0:04 ›" row in order with tools and narration, live and after reload; it never shows as prose and never counts as a step.
- **Build notes:** contracts (`reasoningDelta`, `ThoughtSegmentRecord.kind`), server (DB migration, `NarrativeTurnState`, `ProviderTurnEventApplication`, `codex-live-event-reducer.ts`, `validNarrativeEvent`, display materializer, `turn.load`/page reads include `kind`), providers (three re-routes), web (`narrative-projection.ts`, `parent-narrative-recovery.ts:85`, `NarrativeItem` `reasoning`, `ThoughtRow`, live and persisted builders, memo by timing not identity). Update `CONTEXT.md` "Reasoning block".
- **Deletes:** ledger row 8.
- **Acceptance criteria:**
  - [ ] Reasoning between two tools renders as one Thought row between them, live and after app restart.
  - [ ] Reasoning never reaches the answer slot or the final-response safeguard.
  - [ ] The collapsed row does not re-render per reasoning delta (profiler or render-count test).
  - [ ] Legacy rows without `kind` render as narration.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/conversation/narrative/__tests__/narrative-store.test.ts src/features/agents/conversation/migrations/__tests__/conversation-display-materializer.test.ts`; `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts src/private/cursor/acp/__tests__/cursor-acp-event-mapper.test.ts src/private/devin/__tests__/devin-acp-event-mapper.test.ts`; live: Codex at High reasoning on the fixture repo, Thought rows appear collapsed; reload the thread, they persist.

### S05-07 Reasoning capture for Claude, Copilot and OpenCode

- **Blocked by:** S05-06 Reasoning seam and collapsed Thought row (Codex, Cursor, Devin).
- **Boards:** 05f `2CNV-2` (state 2)
- **Delivers:** The same Thought row for the three providers that drop reasoning today.
- **Build notes:** providers. Claude: track content blocks by index in `streamEvent` (`claude-event-mapper.ts:496-503`); redacted or empty thinking emits `""` so the row shows duration only. Copilot: map reasoning events (names to confirm against the pinned SDK) and the `phase: "thinking"` message; add the first `copilot-event-mapper` test file. OpenCode: reasoning parts and `session.next.reasoning.*`.
- **Deletes:** ledger row 9.
- **Acceptance criteria:**
  - [ ] Each adapter's test turns native reasoning input into `reasoningDelta` with a stable id and an end.
  - [ ] A Claude turn with thinking on shows Thought rows; with omitted text the row has no chevron.
- **Verify:** `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-provider-stream-mapping.test.ts`; `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-event-mapper.test.ts`; live: Claude turn at High effort shows Thought rows.

### S05-08 Subagent chips and overview Subagents row with provider icons

- **Blocked by:** F-06 Provider icon and disc stack; S03-02 Overview card shell; S12P-08 Subagent roster: one contract, server projection, push.
- **Reconciled:** Consumes the S12P-08 roster entry's provider and normalized status; no second status model in the chips or overview.
- **Boards:** 05c `29B3-2` (`29HO-2`, `29M1-2`), 05d `29MQ-2`; Components `129W-0`, `ZEJ-0`
- **Delivers:** Subagents show as bordered chips with each subagent's own provider icon and its status word ("working", "finished", "failed", "stopped"), the same status the Subagents list shows; the overview shows up to three overlapping provider discs and "1 active · 7 done".
- **Build notes:** web only. Each chip finds its roster entry through S12P-08's `entryForToolCall(threadId, toolCallId)` and renders `entry.provider` and `subagentChipWord(entry.status)`. The provider is the entry's, not the thread's current one, so a thread that switched providers shows each subagent under its own icon. There is no status model in this section: no `subagentStatusWord`, no status read from tool-call state. Before the roster answers, a chip shows its title only. The overview row reads `countSubagents` and the entries' providers through a selector that returns primitives. F-06 has already replaced the identity glyph with `ProviderIcon`.
- **Deletes:** ledger rows "Chip lifecycle words..." and "Inline child rail".
- **Acceptance criteria:**
  - [ ] Chip anatomy matches `29HO-2`; overflow chip reads "+N working, M finished".
  - [ ] A chip's word and the Subagents list's status for the same entry always agree, also after a reconnect.
  - [ ] Mixed providers: in a thread that switched from Claude to Codex, the Claude subagents' chips keep the Claude icon.
  - [ ] Overview stack never shows more than 3 discs; text carries the total.
  - [ ] Proof commands return nothing.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/SubagentRow.test.tsx src/features/conversation/narrative/__tests__/parallel-subagent-nesting.test.ts` with a fake roster store holding mixed-provider entries; live: a Claude turn that dispatches two parallel subagents; chips and overview row match 05c.

### S05-09 Composer tray with the task row

- **Blocked by:** S05-01 Delete dead transcript renderers and the orphan task panel; F-02 Fade truncation primitive; F-03 Button primitives.
- **Boards:** 05a `213P-2` (`21AF-2`), 05b `28OG-2`, 05e `28ZH-2` (`296A-2`)
- **Delivers:** The task list docks on the composer as a tray row: icon, faded title, one segment per task, "3/4", and a chevron that expands the list upward inside the tray.
- **Build notes:** web. `ComposerTray` replaces the task-bubble and queue mounts in `ComposerContentSurface.tsx:173-210` (queue rows join in S05-10). `selectTaskProgress(threadId)` returns `TaskProgress` with shallow equality; the title follows R1 (section 4): the implemented plan version's title, else "Tasks", never the thread title. Expanded list: 40px rows, neutral status marks (proposal). Keep `prepareTaskBubbleForNewTurn` lifecycle (`taskStore.ts:116-144`). Segment lane behaviour past ~20 tasks per the open question. Rewrite `CONTEXT.md` "Task bubble". The tray stays above the S06 approval dock.
- **Deletes:** ledger row 11.
- **Acceptance criteria:**
  - [ ] Segment colours follow done/current/pending; count is settled/total.
  - [ ] Chevron, Enter and Esc expand and collapse; the list grows upward without moving the composer.
  - [ ] No task list: no tray row.
  - [ ] A task list from an ordinary turn is titled "Tasks", even in a thread with a title; a task list from a turn whose user message is a version's `acceptedMessageId` is titled with that version's title. No case shows the thread title.
- **Verify:** `bun run --cwd apps/web test -- src/components/chat/TaskBubble.test.tsx src/stores/taskStore.test.ts` (rename the first to the tray test; add the three title cases to the selector test); live: Claude turn that writes a 4-item todo list; tray matches 05a then 05b, titled "Tasks" (the boards show a plan's title, which applies only to an Implement turn).

### S05-10 Queue rows in the tray: Send now, Edit, Remove

- **Blocked by:** S05-09 Composer tray with the task row; F-03 Button primitives.
- **Boards:** 05e `28ZH-2` (`296A-2`)
- **Delivers:** Queued follow-ups sit under the task row with arrow-up Send now, pencil Edit, x Remove. While a Claude or Codex turn runs, Send now steers the message into that turn, and it shows in the transcript where it was sent. For Cursor, Copilot, Devin and OpenCode, Send now is hidden while a turn runs. While the thread is idle, Send now sends the message at once, for every provider.
- **Build notes:** a vertical slice (R2, section 6).
  - Web: restyle rows; drop header, Continue, Clear all, Zap and drag reorder (R3). Edit keeps `onLoadIntoComposer`; Remove keeps `removeFromQueue`. Send now while idle dispatches now (existing `sendNow`). While running, it calls `agent.steer` with the running `turnExecutionId` and shows only when the thread's provider declares `turn-steer` (from the provider descriptor the client already loads). Delete the Claude-only gate and the head-of-queue move. Rewrite the `ComposerQueueList` docstring to match.
  - Contracts: the `turn-steer` capability, `agent.steer`, and the optional `steerTurn` on the provider interface.
  - Server: `TurnRuntimeController.steer` with the running-turn precondition and no new reservation; the steered message persists in the running turn.
  - Claude: push the message with `priority: "now"`; treat `aborted_streaming` and `aborted_tools` results after a steer as part of the same turn. Confirm the SDK field on the pinned version or bump the SDK, and record the decision in the PR.
  - Codex: `turn/steer` with `expectedTurnId` from `activeTurnId`; measure the minimum CLI version and declare `turn-steer` only at or above it.
  - Cursor, Copilot, Devin, OpenCode: declare `turn-steer` `unsupported`.
- **Deletes:** ledger row 12.
- **Acceptance criteria:**
  - [ ] Three actions, keyboard reachable, tooltips name them.
  - [ ] During a running Claude or Codex turn, Send now steers: the provider receives the text inside the same turn, no second turn starts, the queue does not reorder, and the message appears in the transcript at its place and after a reload.
  - [ ] During a running Cursor, Copilot, Devin or OpenCode turn, the row shows Edit and Remove only.
  - [ ] A steer that loses a race with the turn's end returns `turn_not_running`; the message stays queued and is never lost or sent twice.
  - [ ] A Codex CLI below the measured minimum declares `turn-steer` unsupported and hides Send now while running.
  - [ ] While the thread is idle, Send now sends the message for every provider and resumes auto-drain (S08F-05 relies on this).
- **Verify:** `bun run --cwd apps/web test -- src/components/chat/__tests__/ComposerQueueList.lifecycle.test.tsx src/features/conversation/composer/queue/useQueuedMessageDispatch.test.tsx`; `bun run --cwd apps/server test -- src/features/agents/transport/__tests__/agent-rpc-route.test.ts` (the `agent.steer` route and its preconditions); `bun run --cwd packages/providers test -- src/__tests__/codex/codex-provider-lifecycle.test.ts src/private/claude/__tests__/claude-provider-stream-mapping.test.ts` (the `turn/steer` request with `expectedTurnId`; the `priority: "now"` push and an aborted segment that does not end the turn). Live: queue a follow-up during a Codex turn in `.dev/fixture-repo` and press Send now; the agent picks it up in the same turn. Repeat on Claude. On a Cursor turn, confirm Send now is absent while running and present once the turn ends.

### S05-11 Overview Changes, Tasks and Usage rows

- **Blocked by:** S05-09 Composer tray with the task row; S03-02 Overview card shell.
- **Boards:** 05a `213P-2` (`21DN-2`, `21E5-2`), 05b `28OG-2`, 05c `29B3-2` (`29LT-2`); Components `ZEJ-0`
- **Delivers:** The overview shows Changes "+12 −9" (updating as edits land), the task row "Tidy thread actions menu 3/4", and neutral always-open Usage bars.
- **Build notes:** web. Changes: during a running turn read `fileEffectSummary`; on settle run `resolveThreadOverviewChangeSummary` once, debounced on `diffRevision`. Tasks row uses `selectTaskProgress`; click expands the tray list (proposal); S07 owns the plan-backed variant. Usage drops the collapsible and colour classes. Rows hide when empty.
- **Deletes:** ledger row 13.
- **Acceptance criteria:**
  - [ ] No overview RPC runs on `files.changed` while a turn is running (spy test).
  - [ ] Counts use U+2212 and muted colour.
  - [ ] Overview re-renders do not follow text deltas (render-count test).
- **Verify:** `bun run --cwd apps/web test -- src/components/chat/ThreadOverview.branchless-pr.test.tsx` plus a new overview rows test; live: run an editing turn with the overview open; Changes updates without a network burst (DevTools Network).

### S05-12 Neutral Stop and Jump to latest

- **Blocked by:** F-03 Button primitives.
- **Boards:** 05a `213P-2`, 05d `29MQ-2` (`29YT-2`, `29YR-2`); Components `L95-0`, `L9T-0`
- **Delivers:** Stop is an ink circle with a background-colour square (ghost square beside amber Send when a draft exists; muted spinner while stopping). Scrolling up shows a "Jump to latest" pill over a fade above the tray.
- **Build notes:** web. `ComposerContentSurface.tsx:397-420,520-527`; replace `ScrollToBottomButton` and its mount; position from the tray top. No amber "new content" variant.
- **Deletes:** ledger row 14 and the red Stop row.
- **Acceptance criteria:**
  - [ ] No red or amber on Stop in any state.
  - [ ] Pill appears only when not at the tail and returns to it on click; tail-follow resumes.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/composer/ComposerContentSurface.send-button.test.ts`; live: scroll up during a long Claude turn, pill appears; click returns to the tail.

### S05-13 Task lists for Devin and OpenCode

- **Blocked by:** S05-09 Composer tray with the task row.
- **Boards:** 05a `213P-2` (tray row)
- **Delivers:** Devin and OpenCode threads show the tray task row and overview task row.
- **Build notes:** providers. Move the Cursor ACP plan → `TodoWrite` snapshot helper (`cursor-todo-snapshot.ts`) to `private/protocols/acp`; call it from Devin's `session/update` handler. OpenCode: map todo updates (event shape to confirm) to a `TodoWrite` snapshot. Copilot: no change.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] Devin ACP `plan` update and OpenCode todo update each produce a `TodoWrite` snapshot in tests.
- **Verify:** `bun run --cwd packages/providers test -- src/private/devin/__tests__/devin-acp-event-mapper.test.ts src/private/cursor/acp/__tests__/cursor-acp-event-mapper.test.ts`; `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-event-mapper.test.ts`; live: Devin turn with a plan shows the tray row.

## Tests

- Highest seams: adapter mapper tests (native input → `AgentEvent[]`), `narrative-store.test.ts` and the display materializer test for segment kind round-trips, `virtual-items.test.ts` for `deriveRunStatus` and item equality, component tests under `features/conversation/narrative/__tests__`, `ComposerQueueList.lifecycle.test.tsx`, `taskStore.test.ts`.
- Render-count tests for the collapsed Thought row and the overview rows protect the streaming budget.
- Live proof: `.agents/skills/verify-mcode/SKILL.md` and the Electron live-testing skill, against `.dev/fixture-repo` only. Codex at High reasoning and Claude with parallel subagents cover most boards; Devin and OpenCode need their CLIs (report skips).

## Risks and open questions

1. Task-list title source. Decided (user, 2026-10-08, R1): "Tasks" when no plan backs the list, the plan's title when the tasks come from implementing a plan, never the thread title (section 4). No new model calls.
2. Send now while running. Decided (user, 2026-10-08, R2): Send now means steer into the running turn. It is hidden while a turn runs when the provider cannot steer, and there is no "send next" fallback under that name (section 6). Today that means Claude and Codex steer; Cursor, Copilot, Devin and OpenCode do not.
3. Drag reorder of queued messages (user). Paper shows none. Recommendation: drop it with the header.
4. Status-label shimmer (user). It repaints every frame for the whole turn. Recommendation: drop it; keep the icon motion.
5. Thought duration format (user). 05f `2COB-2` reads "4s"; the locked rule says m:ss. Default in tickets: "0:04".
6. Not drawn (user or design): expanded Thought body, active Thought label, expanded task list rows, multi-call failed group text, segment lane past ~20 tasks, `h:mm:ss` timers. Tickets carry proposals.
7. Usage near the limit. Decided (R6, default stands, user 2026-10-08): neutral until 90%, then amber; no red. Paper's neutral 62% fits that rule.
8. Retry line (S05 and S08). Decided (R7, default stands, user 2026-10-08): the provider retrying shows on its own quiet line under the work, as 08f draws it, with the attempt and countdown. The status line keeps only the short label ("Rate limited" or "Retrying"), so 05f state 7's "retrying in 12s" is not built on the status line.
9. Components page drift (design owner): tool rows, queue icons, status line subagent count, chip status words differ from the 05 boards.
10. Claude thinking text availability (fact to check in S05-07): current models may summarize or omit thinking text. The row works either way.
11. Copilot reasoning and OpenCode todo/retry event shapes are inferred; S05-07 and S05-13 confirm them against the pinned SDK and a captured OpenCode stream.
12. Queued messages are deleted on an errored turn (`threadStore.ts:2688`); S08 (08f) decides whether they survive.
13. Slash list (07h) and the tray share the composer-top slot; S07 decides stacking.
