# 04 · 08f · Thread start and turn endings: build brief

When this ships, a first send moves the composer to its dock in one 240ms motion. A quiet steps trail then shows each startup step with its own duration: fetch, worktree, setup, start. The trail holds on "Starting thread" until the provider sends its first frame, and Stop or Esc cancels at any point. Setup output, failures and approvals stay inside the trail, so the in-chat setup card and `StartupProgressCard` go away.

A turn that does not finish now ends with one notice above the composer. The notice names the cause and offers one next step: Retry, Resume, Retry at a reset time, or Sign in. Provider errors carry a classified kind on the wire, and the sidebar and toasts say "Failed" instead of "Errored".

Surfaces: contracts (startup record, error event, canonical turn, recovery commands), server (startup coordinator, environment service, turn runtime, recovery service, a retry scheduler), all six provider adapters, and web (conversation, composer, sidebar inputs). Electron needs no desktop-specific code.

## Boards

All boards are on page p-6-0: https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

| Board | Node | Shows |
|---|---|---|
| `04a · Thread starting · New worktree · Dark` | `20U9-2` | Trail mid-setup (Fetched, Created worktree, Running setup with chevron, pending Start thread), overview open, composer in starting state (dimmed placeholder, spinner, Stop) |
| `04b · Thread starting · New worktree · Setup output · Dark` | `29YX-2` | Setup output expanded: script header with Open terminal and Edit script icon buttons, 160px bottom-anchored transcript with top fade |
| `04c · Thread starting · New worktree from PR · Dark` | `2AEY-2` | Fetch step for a PR: `Fetched #1804 · feat/sidebar-resize 0:03` |
| `04d · Thread starting · Existing worktree · Dark` | `2AMW-2` | `Opened worktree mcode-9c1d` (no duration), then setup runs |
| `04e · Thread starting · Local · Dark` | `2A7M-2` | One step only: `Starting thread 0:03` |
| `04f · Thread starting · Step states · Dark` | `2BW7-2` | 11 states: fetching, running setup, starting, started (collapsed), setup failed, setup needs approval, fetch failed, worktree failed, thread didn't start, cancelled, existing worktree with setup skipped |
| `04g · Thread starting · First send motion · Dark` | `2CQU-2` | Keyframes 0/60/240ms, a 0 to 420ms timeline, easing, reduced motion, build note |
| `08f · Turn did not finish · Stopped, interrupted, failed · Dark` | `2C3A-2` | Stopped by you, stopped before the provider started, interrupted, provider retrying, failed (retryable, details open, usage limit, signed out), sidebar rows |
| `05f · Running · In-turn states · Dark`, state 7 | `2CQL-2` | Related only: section 05 owns the short "Rate limited" status label; the countdown and attempt are on this section's quiet retry line (S08F-09, decision R7) |

Exact values below come from `get_jsx` and `get_computed_styles` on these nodes.

### Startup trail values (04a, 04b, 04f)

- Trail block: column, row gap 2px, placed 16px under the user bubble block (conversation column gap 16).
- Step row: height 24, gap 8. Icon slot 16x16 centered. Label 12/16 sans, then argument 12/16 mono muted, then duration 12/16 mono muted.
  - Done: 12px check, `--color-muted`. Label muted, regular weight.
  - Live: 14px arc spinner in `--color-primary`. Label `--color-ink`, weight 500.
  - Pending: 4px `--color-muted` dot. The whole row has opacity 0.5. Label muted.
  - Failed: 14px warning circle in `--color-error`. Label `--color-error`, weight 500.
  - Needs approval: 14px warning circle muted. Label ink, weight 500.
  - Skipped: 12px minus, muted. Label muted. The argument holds the reason ("thread running here").
  - Cancelled: 14px x-circle muted. Label muted, weight 500.
  - Expandable live setup step: trailing 12px caret, right when collapsed and down when open.
- Detail line under a failed or blocked step: mono 12/16 muted, padding 4 top, 8 bottom, 24 left.
- Action row:
  - Failed states: padding-left 16, text buttons of height `--size-control-compact` with 8px inline padding, 12px ink at `--weight-button`. Button text therefore lines up at 24.
  - Approval: padding-left 24, gap 4. Amber primary "Run setup" (`--color-primary` fill, `--color-primary-ink` text, 12px padding), then text button "Skip setup".
- Collapsed after start (04f state 4): 12px right caret, "Started in" sans muted, "0:22" mono muted, "· mcode-3f2a · bun install" mono muted. The turn's live status row ("Thinking 0:03") follows it.
- Setup output card (04b, node `2A50-2`):
  - Placement: padding 4 top, 6 bottom, 24 left (under the step label). Card: 560 wide, `--color-panel` fill, 1px `--color-border`, `--radius-8`, overflow clip.
  - Script header: padding 10/12, bottom border. One line per command (`$ bun install`) in 12/20 mono ink.
  - Header buttons: two 24x24 icon buttons, `--radius-6`, gap 2, absolute at top 8 and right 8. Terminal icon is Open terminal, pencil is Edit script. Hover adds `--color-hover` fill and an ink icon.
  - Tooltip "Edit script": `--color-panel`, 1px border, `--radius-8`, min-height 32, padding 7/12, caption type.
  - Transcript: fixed height 160, `justify-content: end` (newest line at the bottom), padding 0 12 10, 12/20 mono muted. Lines that echo a command (`$ tsc -b ...`) are ink.
  - Top fade: 32px gradient from `--color-panel` to transparent.
- Durations are mono `m:ss` ("0:14"). Steps that do no work (Opened worktree, Skipped setup) show no duration.

### Composer while starting (04a to 04e)

The placeholder "Do anything" is muted at opacity 0.5. The footer keeps `+`, Full access and the model picker. A 32x32 spinner frame sits beside a 40x40 Stop (ink circle with a 14x14 square). There is no Send.

### End notice values (08f)

- Quiet notice (You stopped, Stopped before Codex started, Codex is retrying): no fill, padding 4 top and bottom, 10 right, gap 12. 16px icon. Title 14/20 `--color-muted`, regular weight. The retry line adds a 13/18 muted detail. The retry icon is a `--color-border` track with a muted arc.
- Filled notice (Interrupted, Failed, Usage limit, Signed out):
  - Box: `--color-panel`, `--radius-14`, padding 10 top and bottom, 14 left, 10 right, gap 12, centered. Wraps so Details can take a full row.
  - Icon: 16px circle at stroke 1.6. `--color-error` with an exclamation for failed and signed out. `--color-primary` with pause bars for interrupted and with clock hands for usage limit.
  - Text column: title 14/20 ink weight 500, detail 13/18 muted, gap 2.
  - Secondary text button: height 28, padding 10, 13/18 weight 500 muted ("Details", "Hide details", "Switch model").
  - Primary pill: height 28, padding 12, `--color-selected` fill, `--radius-full`, 13/18 weight 500 ink. Amber is not used in end notices.
  - Details panel: `flex-basis: 100%`, `--color-background`, `--radius-10`, padding 10/6/10/12. Raw text in 12/18 mono muted with `white-space: pre-wrap`. A 24px copy icon button sits top right.
- Work fold header (owned by section 05, see S05 work fold): height 32, bottom border, "Interrupted after 30s" 14/20 muted, 14px chevron.
- Sidebar rows (owned by section 01, see S01 thread row state model):
  - Interrupted: 8px ring with a 1.5px `--color-primary` border, and a third line "Interrupted" in `--color-primary`.
  - Failed: 8px `--color-error` fill, and a third line "Failed" in `--color-error`.
  - Stopped: nothing.

### First send motion (04g)

| Track | What | Time |
|---|---|---|
| Heading and hint | opacity out | 0 to 120ms |
| Composer | `translateY` to the bottom dock | 0 to 240ms |
| New sidebar row | opacity in, sibling rows shift | 0 to 180ms |
| Your message | opacity in, 8px up | 120 to 300ms |
| Startup steps | opacity in, 8px up | 240 to 420ms |
| Overview selectors | become read-only | instant at 0 |

- Easing on every track: `cubic-bezier(.2, 0, 0, 1)`.
- Reduced motion: the composer appears docked, and the message and steps fade in over 120ms.
- Build note on the board: "FLIP: measure both composer rects, animate transform only. The motion never blocks the send."

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md`. Do not reopen these.

- 2026-10-07: a steps trail replaces `StartupProgressCard` and the in-chat setup card.
- 2026-10-07: "Starting thread" holds until the first provider frame.
- 2026-10-07: per-step timestamps are new.
- 2026-10-07: a fetch step appears when Start from origin is on.
- 2026-10-07: expanded setup output shows the script and the live transcript, capped at 32 entries and 16KB. These are the existing limits `THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES` and `THREAD_STARTUP_TRANSCRIPT_MAX_CHARS` (`packages/contracts/src/thread-startup.ts:5-9`).
- 2026-10-07: "Open terminal" means `openAutomaticSetupTerminal`, the recovery shell. After the section 12 switch (S12T-11) it opens the startup action's own terminal.
- 2026-10-07: Existing worktree runs setup on every thread start, but skips setup while another thread is live in that worktree.
- 2026-10-07: Esc or Stop cancels startup. This is new.
- 2026-10-07: no queueing during startup. Send stays disabled and the placeholder "Do anything" is dimmed on all 04 boards.
- 2026-10-07: the startup step shows the worktree folder name (`mcode-3f2a`), and a copy button copies the full path.
- 2026-10-07 (04g): the composer is 760 wide everywhere and never resizes, so first send is a `translateY` only.
- 2026-10-07: the mode and branch rail above the composer disappears after first send. The thread overview is open by default.
- Section 12 (2026-10-07/08): the setup command becomes project actions marked "Run on startup". The server runs them in setup order, in real terminals, with one terminal renderer for everything.
- 08f (added 2026-10-07): the work fold names the ending ("Stopped after 48s", "Interrupted after 30s", "Failed after 1m 02s"). Partial answers and the changes bar stay. One end notice closes the turn with an icon, a cause, a detail and one primary action. The mapping from outcome to notice lives in one table.
  - Stopped: a quiet "You stopped" with no button. Revert this turn lives in the turn's ⋯ menu (section 08e).
  - Stopped before the provider started: no work fold. The user bubble stays with a quiet "Stopped before Codex started" and no action (user, 2026-10-07). That ending is the only result: the composer is not refilled with the prompt (user, 2026-10-08, E6).
  - Interrupted: amber pause icon, "Mcode closed while Codex was working", Resume. Resume continues the same session when the provider can resume it. Otherwise it starts a new session seeded with the thread.
  - Failed, retryable: clay icon, a plain cause with the status ("Codex stopped responding", "502 Bad Gateway after 3 retries"). Details expands the raw error in mono with Copy, in place. Retry sends the same prompt as a new attempt of the same turn, and the agent sees the partial edits.
  - Failed, usage limit: amber clock, "Claude usage limit reached · 5-hour limit, resets 16:00", Switch model, and "Retry at 16:00". That retry is scheduled, not immediate.
  - Failed, signed out: "Cursor is signed out" and Sign in. Once signed in, the button becomes Retry. This is the same action as the bell's Providers row.
  - Provider retrying: a quiet line with a spinner, "Codex is retrying · 502 Bad Gateway · attempt 2 of 10 · next in 8s". No action and no red. It clears when output resumes and becomes Failed if retries run out.
  - Retry and Resume replace the attempt (user, 2026-10-08, E2). The transcript shows the user message once, then the latest attempt only. Once a replacement attempt exists, the failed or interrupted attempt's work fold, partial answer, changes bar and end notice are not rendered. There is no "Retried" or "Resumed" receipt and no second copy of the message. Mcode keeps every attempt's records (PRODUCT.md principle 13); only the view hides them. The attempts of one turn are one logical turn, so Review's Turn view for it starts at the first attempt's baseline (section 10 owns that). If the replacement attempt also fails, its own Failed notice shows, with Retry one-shot per attempt.
  - Sidebar: Interrupted gets an amber ring and an amber line (it needs the user). Failed gets a clay dot and a clay line. Stopped shows nothing. All clear when the thread is opened.
  - Rename the visible "Errored" to "Failed" everywhere, toasts included.
- The error needs a `kind` on the wire (retryable, usage_limit, auth, fatal) plus status, retryAfterMs, provider and attempt info. Each adapter classifies its own errors.
- ADR-0022: Mcode never replays prompts automatically. It prefers provider-native recovery, and uses a replacement turn or a new session only as an explicit fallback. "Retry at 16:00" complies because the user schedules it explicitly.

## How it works today

### Startup lifecycle (server)

- A durable startup record already exists. `ThreadStartup` has kind, state, phase, steps, a transcript, cancellation, error and block (`packages/contracts/src/thread-startup.ts:113-150`).
  - Phases by kind: direct `[thread, agent]`, managed-worktree `[thread, worktree, setup, agent]`, pull-request-review `[thread, worktree, agent]` (`thread-startup.ts:107-111`). These are mirrored in `apps/server/src/features/thread-startup/thread-startup-state-store.ts:24-28`.
  - Steps carry only `{phase, state}` (`thread-startup.ts:63-68`), so there are no timestamps and no arguments. Verified.
  - The record is stored as JSON columns `stepsJson` and `transcriptJson` (`apps/server/src/features/thread-startup/persistence/thread-startup-store.ts:22-39`), so step shape changes need no column migration.
  - Every transition commits, then broadcasts `thread.startup.updated` (`thread-startup-service.ts:148-152`).
- `ThreadCreationCoordinator` picks the kind at `thread-creation-coordinator.ts:431-433`. It uses managed-worktree only when `mode === "worktree" && !existingWorktreePath`. Existing worktree therefore gets kind direct and never has a setup phase. Verified.
- A PR start fetches inside `create()` while the startup is still in the "thread" phase (`thread-creation-coordinator.ts:283-286`), so no fetch step exists. Start from origin does not exist (`rg -i fromOrigin` finds nothing).
- The agent phase completes on provider admission, not on the first provider frame. See `dispatchInitialTurn` at `apps/server/src/features/agents/orchestration/turn-runtime-controller.ts:1999-2012` and the queued path at `:2025-2065`. Verified.
- `failStartup` writes generic messages ("Worktree preparation failed") and drops the underlying error text (`thread-creation-coordinator.ts:474-484`).
- Branched threads always skip setup (`thread-creation-coordinator.ts:664-671`).
- `thread.startup.cancel` records intent and stops automatic setup only for managed-worktree in a non-agent phase (`apps/server/src/features/thread-startup/transport/thread-startup-rpc.ts:37-48`). In the agent phase it only records intent. Admission later checks `canAdmitQueuedAgent` (`thread-creation-coordinator.ts:191-200`).
- Replaying a failed or cancelled startup throws ("retry with a new startup ID", `thread-creation-coordinator.ts:459-461`). The client handles retry by re-sending `createAndSend` from in-memory pending state (`apps/web/src/features/projects/state/workspaceStore.ts:1535-1583`).

### Automatic setup

- Automatic setup applies only to managed worktrees.
  - `requireAutomaticSetupThread` rejects `worktree_managed !== true` (`apps/server/src/features/projects/environment/workspace-environment-service.ts:1147-1164`).
  - `admitInitialAutomaticTurn` returns `not-managed` for the same reason (`apps/server/src/features/agents/turns/turn-admission-dispatch-coordinator.ts:348`).
  - Attached existing worktrees are created with `worktreeManaged=false` (`turn-admission-dispatch-coordinator.ts:333-336`). Verified.
- Setup output goes into the startup transcript in 4,096-character entries (`workspace-environment-service.ts:1479-1489`). The store keeps the newest bounded set (`thread-startup-state-store.ts:165-178`).
- Setup failure, approval and unavailability block the startup with `actions: ["retry", "continue"]` (`workspace-environment-service.ts:1373, 1456, 1476, 1491-1495`).
- `openAutomaticSetupTerminal` creates a recovery shell (`workspace-environment-service.ts:537-549`). It has a transport method (`apps/web/src/transport/ws-transport.ts:1101`) but no UI caller (section 12 interview). Verified.
- The setup gate can hold several queued prompts (`workspace-environment-service.ts:368-399`, capacity error at `:383-388`). `cancelQueuedAutomaticTurn` and `stopAutomaticSetup` have client transport methods with no UI caller (`ws-transport.ts:1086-1095`). Verified with `rg`.

### Startup UI (web)

- `ThreadPreparingShell` is a separate surface with its own header, a centered bubble and `StartupProgressCard` (`apps/web/src/features/conversation/messages/chat-view/ChatViewSurface.tsx:192-312`). It is not the thread view the user lands in afterwards.
- `StartupProgressCard` (`apps/web/src/features/thread-startup/StartupProgressCard.tsx`, 413 lines) draws an activity shimmer line and a bordered card with timeline nodes. Its labels are "Prepare checkout" and "Run project setup", plus "More details" and "Cancel". It is also used by `PullRequestReviewTaskDialog.tsx:322,428` and `PullRequestForkDialog.tsx:211`.
- After the thread exists, `ProjectAutomaticSetupCard` renders the in-chat setup card above the transcript (`ChatViewSurface.tsx:626-627`). Approval opens `ProjectCommandApprovalDialog` (`apps/web/src/features/projects/environment/ProjectAutomaticSetupControl.tsx:199-215`).
- `useProjectAutomaticSetup` polls `getAutomaticSetup` every 1s while setup is queued or running (`ProjectAutomaticSetupControl.tsx:80-85`). Every managed-worktree sidebar row mounts it (`apps/web/src/features/projects/ProjectTree.tsx:1451-1461`). Verified.
- While setup is blocked the composer is disabled with "Resolve Automatic Setup before sending a follow-up". See `ComposerContentSurface.tsx:283` and `setupBlocked={automaticSetup.snapshot.gate === "blocked"}` at `ChatViewSurface.tsx:712`.
- Esc does not stop anything today. Composer Esc only cancels branch mode (`Composer.tsx:622`). The only caller of `cancelThreadStartup` is the card's Cancel button (`StartupProgressCard.tsx:314`).
- The startup CSS has `startup-node-pop` and `startup-activity-shimmer` (`apps/web/src/index.css:655-689`). The shimmer is also used by `ShellToolCallRow.tsx:133` and `NarrativeIndicator.tsx:152`, so it stays.

### Turn outcomes and errors

- Contracts:
  - `TurnOutcomeSchema` is completed, cancelled, interrupted, errored (`packages/contracts/src/models/turn-outcome.ts:4-9`).
  - `Error` is `{threadId, error: string}` (`packages/contracts/src/events/agent-event.ts:129-133`).
  - `Ended` is `{turnExecutionId, outcome?, reason?}` (`:134-141`).
  - `RateLimited` (`:256-268`) and `ApiRetry` (`:269-283`) exist.
- Canonical model:
  - `AgentTurn` has status, startedAt and endedAt, but no cause and no error text (`packages/agent-model/src/records.ts:84-101`).
  - `turn.errored` carries `error: string`, and `turn.interrupted` carries `reason: string` (`packages/agent-model/src/events.ts:59-72`).
  - The reducer drops both fields (`packages/agent-model/src/reducer.ts:309-330`).
  - `turn.started` is written at admission (`apps/server/src/features/agents/canonical/canonical-agent-store.ts:2617-2622`), not at the first provider frame.
- Persistence: the error text lives in `canonical_agent_ingest_checkpoints.error` and in the `turn.errored` envelope (`apps/server/src/runtime/persistence/sqlite/schema.ts:788-799`, `accepted-parent-events.ts:293`). `canonical_agent_turns` has no cause column (`schema.ts` canonicalAgentTurns).
- Dispatch failures skip the `Error` event. `failWorkerDispatch` finishes the turn with `error: message` (`turn-runtime-controller.ts:1035-1058`).
- Thread status: errors set `errored`, provider ends set `interrupted` (`apps/server/src/features/agents/events/provider-event-publication.ts:21-30`), and a user stop sets `paused` (`turn-runtime-controller.ts:1475-1476`). So a user stop already leaves no sidebar marker.
- Web:
  - `TurnFooter` labels "You stopped", "Turn interrupted", "Turn failed" (`apps/web/src/features/conversation/narrative/TurnFooter.tsx:16-23`).
  - The client synthesizes a red `agent_error` system message (`apps/web/src/stores/threadStore.ts:2657-2659`) and renders it from `MessageBubble.tsx:281-291, 797-805`. It is not persisted, so it disappears on reload. Verified.
  - `RetryBanner` shows rate-limit and API-retry text inside the composer (`apps/web/src/components/chat/RetryBanner.tsx`, mounted at `ComposerContentSurface.tsx:374`). The client drops `ApiRetry.errorStatus` (`threadStore.ts:2619-2622`).
  - "Errored" appears in `ThreadStateMarker.tsx:16,32`, `lib/thread-status.ts:96` and `ThreadFilterDropdown.tsx:12`.
- Recovery today:
  - `agent.retry` exists, which contradicts the note "nothing re-runs a turn" (`packages/contracts/src/ws/methods.ts:1042-1046`, `apps/server/src/features/agents/transport/agent-rpc.ts:128-135`).
  - It only accepts executions in the current server run's recovery incident, and it sends a replacement turn with `forceFreshSession: true` (`apps/server/src/features/agents/recovery/turn-recovery-service.ts:91-146`). That means a new session with no seed (inferred: the fresh session receives only the prompt).
  - UI: `InterruptedSessionsBanner` "Retry all" (`apps/web/src/components/chat/InterruptedSessionsBanner.tsx`, mounted at `ChatViewSurface.tsx:351`).
  - Retry consumption is already one-shot for interrupted and errored checkpoints (`canonical-parent-turn-lifecycle.ts:397-406`).
- Automatic transient retry exists. `TurnErrorPolicy` holds a regex allowlist with at most 2 attempts (`apps/server/src/features/agents/turns/turn-error-policy.ts:25-40`). The `CONTEXT.md` "Behaviour pending" note under Transient failure is therefore stale.
- Stop before dispatch: `AgentStopResult.dispatchState` (`packages/contracts/src/models/turn-runtime.ts:69-84`) drives `composerRecallFromStop`, which refills the composer with the prompt (`threadStore.ts:2839-2848,3588-3596`; the editor effect at `useComposerFormController.ts:816-826`). Nothing durable records whether the provider ever produced output.
- A replacement turn today is a new turn with a full copy of the user message: `TurnRecoveryService.retryCommand` rebuilds a send from the stored message (`turn-recovery-service.ts:118-146`). The start input carries `retryOfExecutionId` (`canonical-runtime-write-operations.ts:43`), which only marks the old checkpoint `retried` (`canonical-parent-turn-lifecycle.ts:397-406`). `AgentTurn` has no link to the attempt it replaces (`packages/agent-model/src/records.ts:84-101`).

### Bugs found

- OpenCode loses every native error text. The provider skips mapped `Error` events (`apps/server/src/features/providers/adapters/opencode/opencode-provider.ts:1131`) and then calls `settler.settle("errored")` with no message (`:858-859`). Verified.
- Devin maps `quota_exhausted` and `auth_required` stop causes to `interrupted` (`packages/providers/src/private/devin/devin-provider.ts:119-130`). Users see an infrastructure interruption for what is a usage limit or a sign-out. Verified.
- Claude turns `rate_limit_event` statuses `allowed_warning` and `rejected` both into `active: true` (`claude-event-mapper.ts:558-585`, per explorer, not re-read). A warning therefore shows "Rate limited".
- Codex logs `codexErrorInfo` (for example `usageLimitExceeded`) and then drops it (`packages/providers/src/private/codex/codex-event-mapper.ts:2036-2041`). Verified.
- The startup error text loses its cause (`thread-creation-coordinator.ts:474-484`). Verified.
- `CONTEXT.md` "Turn outcome" says canonical persistence lacks Cancelled, but `AgentTurnStatusSchema` includes it (`records.ts:50-57`). The note is stale.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Steps trail under the bubble | Separate preparing shell and card | `StartupStepsTrail` inside the normal thread surface | web |
| Per-step durations | Steps have no time | `startedAt`/`endedAt` per step, live 1s tick | contracts, server, web |
| Step argument (`origin/main`, `mcode-3f2a`, `bun install`) | None | Step `detail` union | contracts, server, web |
| Fetch step | PR fetch hidden in "thread" phase | `fetch` phase. PR fetch moves into it. Start from origin uses it | contracts, server, web |
| "Starting thread" until first frame | Completes at admission | `turn.provider-started` and a startup observer | agent-model, server |
| Setup output expanded | `<details>` box with "More details" | Card with script header, 160px tail, Open terminal, Edit script | web |
| Setup failed and needs approval inline | In-chat card and an approval dialog | Trail states with Retry setup, Skip setup, Show output, and amber Run setup | web, server (block detail) |
| Fetch failed, worktree failed, thread didn't start | Generic `CollapsibleError` or card text | Trail states with the raw error line and phase actions | server (error detail), web |
| Cancelled startup | "Start over" and "Keep thread" in the card | Trail "Cancelled" with Edit message and Keep thread | web |
| Existing worktree runs setup | Kind direct, setup unavailable | Kind `attached-worktree` with a setup phase. Skips while a sibling thread is live, and for a branch or Implement in a new thread in the same checkout | contracts, server |
| Setup runs startup actions | Single setup script | S12T-11 makes the S12 action runner the only executor; the trail projects its frozen action and run ids (section E) | contracts, server, web (S12T-11) |
| Esc or Stop cancels startup | Card Cancel only. Agent-phase cancel only records intent | Composer Stop and Esc call cancel. Agent phase stops the dispatched turn | server, web |
| No queueing during startup | Composer can queue (inferred). Gate queue accepts many | Composer starting state: editor inert, Send hidden, Stop live | web |
| First send motion | None | FLIP `translateY` plus fades per 04g | web |
| Error kind on the wire | `error: string` | `failure: TurnFailure` on `Error`, classified per adapter | contracts, providers, server |
| Persisted cause | Text only in event and checkpoint | `AgentTurn.ending` (failure or interruption cause) and `providerStartedAt` | agent-model, server (migration), web |
| End notice | Footer label and client-only red box | `TurnEndNotice` from one table | web |
| Stopped before provider started | Not distinguishable; the composer refills with the prompt | `providerStartedAt === null` on a cancelled turn; the quiet ending only, no refill (E6) | agent-model, web |
| Stopped by Mcode, not the user | Every cancelled turn reads as a user stop | `ending.stop` on cancelled turns: `user` or `mcode` with a reason | agent-model, server, web |
| Retry | Incident-only `agent.retry` | `turn.retry` for errored turns | contracts, server, web |
| Resume | Same as retry, fresh unseeded session | `turn.resume`: native session resume or a seeded session | contracts, server, providers, web |
| Retry at reset | None | `turn.retry.schedule` with a persisted schedule and cancel | contracts, server (migration), web |
| One logical turn across attempts (E2) | A retry adds a turn with a full copy of the message; no attempt link | `AgentTurn.attemptOf` (S10-03); the transcript shows the message once and the latest attempt only (S08F-05) | agent-model and server (S10-03), web |
| Sign in then Retry | None | Uses the S09 provider condition and its Sign in action | web (S09 dependency) |
| Provider retrying line | `RetryBanner` in the composer | Quiet line under the work, keeping `errorStatus` | web, providers (Codex, Cursor, OpenCode) |
| "Failed" wording | "Errored" in sidebar, filter and status | "Failed" | web |

## Backend architecture

### A. Startup record v2 (S04-01)

Lives in `packages/contracts/src/thread-startup.ts`. The step JSON shape changes, but nothing needs a migration because the store already uses `stepsJson`. New fields are optional so existing rows still parse. The record's `steps` bound rises from 4 to 5 (`thread-startup.ts:139`) for the fetch phase.

```ts
/** Startup flow selected before a durable thread may exist. */
export const ThreadStartupKindSchema = z.enum([
  "direct", "managed-worktree", "attached-worktree", "pull-request-review",
]);
/** Ordered lifecycle phases. "thread" is never rendered; "fetch" is present only when requested. */
export const ThreadStartupPhaseSchema = z.enum(["thread", "fetch", "worktree", "setup", "agent"]);

/** What a step acted on; drives the trail's argument column. */
export const ThreadStartupStepDetailSchema = lazySchema(() => z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("fetch"),
    ref: z.string().trim().min(1).max(256),                 // "origin/main"
    pullRequestNumber: z.number().int().positive().optional(),
    branch: z.string().trim().min(1).max(256).optional(),   // "feat/sidebar-resize"
  }).strict(),
  z.object({
    phase: z.literal("worktree"),
    mode: z.enum(["created", "opened"]),
    folderName: z.string().trim().min(1).max(256),          // basename, "mcode-3f2a"
    path: z.string().trim().min(1).max(4_096),              // full path for copy and tooltip
  }).strict(),
  z.object({
    phase: z.literal("setup"),
    /** Exit code of the command that failed the setup step. */
    exitCode: z.number().int().optional(),
    skipReason: z.enum(["not-configured", "thread-running-here", "user-skipped"]).optional(),
    // S07-08 adds "plan-implement" (section D). S12T-11 adds `actions` (section E). Script text never enters the record.
  }).strict(),
]));

export const ThreadStartupStepSchema = lazySchema(() => z.object({
  phase: ThreadStartupPhaseSchema,
  state: ThreadStartupStepStateSchema,
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
  detail: ThreadStartupStepDetailSchema().optional(),
}).strict());

// ThreadStartupErrorSchema and ThreadStartupBlockSchema each gain:
//   detail: z.string().trim().min(1).max(2_000).optional()
// detail holds the raw cause line, e.g. "fatal: Could not resolve host: github.com".

// ThreadStartupStartInputSchema gains:
//   fetch: z.object({ ref, pullRequestNumber?, branch? }).strict().optional()
```

Phases by kind:

- direct: `[thread, agent]`
- managed-worktree: `[thread, fetch?, worktree, setup, agent]`
- attached-worktree: `[thread, worktree, setup, agent]`
- pull-request-review: `[thread, worktree, agent]`, unchanged

`validateSteps` accepts the kind's list with `fetch` present or absent. A record must not gain or lose `fetch` after `start`.

Timing rules belong in `ThreadStartupStateStore`, the one place that writes steps:

- A step gets `startedAt` when it becomes running.
- It gets `endedAt` when it becomes completed, skipped, failed, cancelled, interrupted or blocked.
- `resume` (Retry setup) resets `startedAt` and clears `endedAt`, so the duration covers the new attempt.

Who writes `detail`:

- The coordinator writes fetch and worktree detail. It writes worktree detail from the created or attached path.
- The environment service writes setup `exitCode` when the setup command fails and `skipReason` on skip. Until S12T-11 the setup step runs the single setup script; the trail reads that script's text for the 04b header from the gate snapshot (`workspace.environment.automaticSetup.get`, `attempt.snapshot.script`), never from the record.
- `failStartup` and `blockStartupSetup` pass `detail`: the first line of the thrown error, or the last non-empty transcript line for setup. Both trim it and cap it at 2,000 characters.

Failure modes:

- An unknown `detail.phase` fails parsing, which is correct because it is a programming error.
- Old rows without times render without durations.

### B. First provider frame (S04-02)

One fact serves both sections: did the provider ever start this turn?

```ts
// packages/agent-model/src/events.ts
z.object({ type: z.literal("turn.provider-started"), at: CanonicalTimestampSchema }).strict()
// packages/agent-model/src/records.ts, AgentTurnSchema
providerStartedAt: CanonicalTimestampSchema.nullable(),
```

- Storage: a new nullable `provider_started_at` column on `canonical_agent_turns`. Generate the migration with `bun run db:generate` in `apps/server` (see `docs/internals/persistence/db-migrations.md`).
- The reducer sets the field once. A duplicate event is a no-op.
- Producer: the per-execution event state writes the event the first time it accepts an adapter event whose type is in one constant, `PROVIDER_FRAME_EVENT_TYPES`. Candidate sites are `apps/server/src/features/agents/execution/provider-execution-event-state.ts` (terminal detection at `:143-146`) and the canonical execution semantic writer (inferred). Its event id `${executionId}:provider-started` makes the write idempotent.
  - In the set: `message`, `textDelta`, `toolUse`, `toolInputDelta`, `toolProgress`, `toolResult`, `turnComplete`, `assistantMessageBoundary`, `generatedAttachment`, `compacting`, `apiRetry`, `rateLimited`, `hookStarted`.
  - Excluded, with reasons:
    - `turnStarted`: the server synthesizes it at dispatch (`turn-runtime-controller.ts:580`), OpenCode emits its own before it acquires a session (`opencode-provider.ts:633`), and Claude emits one on resumed turns (`claude-provider.ts:2200`).
    - `error` and `ended`: they mean the turn did not start.
    - `system`, `quotaUpdate`, `contextEstimate`, `mcpServerStartupStatus`, `providerUnavailable`, `modelFallback`: these are session or account noise, not turn work.
- Startup observer: a new `StartupAgentPhaseObserver` in `apps/server/src/features/thread-startup/` subscribes to committed canonical events for threads whose startup is in the agent phase. On `turn.provider-started` it calls `complete(startupId)`.
  - If the turn ends before that event:
    - cancelled: `markCancelled`
    - errored or interrupted: `fail` with code `AGENT_START_FAILED`, `message` set to the notice title and `detail` set to the failure message
  - `dispatchInitialTurn` (`turn-runtime-controller.ts:2008-2012`) and the queued path (`:2058`) stop calling `completeInitialAgent`. They still call `failInitialAgent` for dispatch exceptions.
- Per provider: no adapter change. The rule is provider-neutral and lives on the server.

### C. Startup cancellation (S04-05)

`thread.startup.cancel` (`thread-startup-rpc.ts:37-48`) covers every nonterminal phase:

| Phase | Action |
|---|---|
| thread, fetch, worktree | Record intent. The coordinator's existing `cancelIfRequested` checkpoints stop it (`thread-creation-coordinator.ts:468-472`). |
| setup (managed or attached) | `stopAutomaticSetup`, then `markCancelled`. Today this covers managed only. After S12T-11 it also stops every startup action command still running; each terminal keeps its shell. |
| agent, first turn dispatched, no provider frame yet | `TurnRuntimeController.stopSession(threadId, { by: "user" })`. The turn ends cancelled with `providerStartedAt === null`, and the observer in section B marks the startup cancelled. |
| agent after the provider frame | The startup is already complete, so this is a normal Stop. |

- Idempotent: cancelling a terminal startup returns it unchanged.
- The client sends cancel from three places: the composer Stop button, Esc while the thread view has focus and no popover or dialog is open, and the trail itself.
- Edit message and Keep thread use the existing calls `deleteThread(id, mode === "worktree")` with `setPendingPrefill`, and `dismissStartup` (`ChatViewSurface.tsx:206-236`). Only the labels change.

### D. Existing worktree runs setup (S04-07)

The one Setup rule for a new thread, shared with S07-08: a thread whose checkout is a worktree, managed or attached, runs Setup before its first turn, unless the start continues another thread in the same checkout or another thread is live in that worktree. Attachment alone never bypasses Setup.

- The coordinator chooses the kind as: `existingWorktreePath ? "attached-worktree" : mode === "worktree" ? "managed-worktree" : "direct"`. This replaces `thread-creation-coordinator.ts:431-433`. The worktree step uses `mode: "opened"` with no duration.
- Setup eligibility becomes "the thread runs in a worktree": `mode === "worktree" && worktree_path != null`, managed or attached. Change it in `requireAutomaticSetupThread` (`workspace-environment-service.ts:1147-1164`) and `admitInitialAutomaticTurn` (`turn-admission-dispatch-coordinator.ts:348`). Leave cleanup ownership keyed by `worktree_managed` as it is.
- Continuation skip. The coordinator decides it before the gate, so the first turn never queues behind Setup. It skips the startup's setup step and returns a `dispatch` result without calling `admitInitialAutomaticTurn`, which is what the branched path does today (`provisionBranchedInitialTurn` and `finishBranchedStartup`, `thread-creation-coordinator.ts:581-614,664-671`). Two starts qualify:
  - A branched thread, as today. `finishBranchedStartup` skips only the managed kind today; from S04-01 it skips the setup step for both worktree kinds.
  - A new thread opened by "Implement vN in a new thread" (S07-08), with `skipReason: "plan-implement"`. It continues its source thread in the source's own checkout, the same way Implement in this thread runs no Setup. Only `PlanService` can request it, through a server-only option on the `createAndSend` port that the coordinator verifies against the source thread's `worktree_path`; 07 Implement step 5 has the details. The live-sibling check below does not cover this case: Implement refuses while the source has an unfinished execution, so the source is never live when the new thread starts.
- Live-sibling check: before setup starts, the environment service asks for another non-deleted thread with the same normalized `worktree_path` whose runtime phase is running or finalizing, or whose startup is nonterminal.
  - If one exists, skip setup with `skipReason: "thread-running-here"` and release the gate as not required.
  - Serialize the check and the setup launch per worktree path, so two simultaneous starts cannot both run setup (inferred risk, see Risks).
- The locked decision "Existing worktree runs setup on every thread start" governs threads the user starts in the composer's Existing worktree mode. The continuation skip extends the existing branch behavior to Implement in a new thread; the user confirmed it on 2026-10-08 (E9, open question 13).
- "Implement vN in a new worktree" (S07-08b) is not a continuation: it creates a new managed worktree, so Setup runs as for any New worktree thread.
- This ticket changes which threads get a setup step, not what runs in it. S04-07 lands on the single-script executor; S12T-11 later swaps the executor and keeps this eligibility and both skips unchanged.
- Docs: rewrite `docs/internals/projects/environment.md:40-82`. It currently says automatic setup is for a "managed New worktree" and manual setup runs in an "unmanaged existing worktree".

### E. The setup step projects startup actions (S12T-11)

S12T-11 (section 12a, Backend F) makes the S12 action runner the only startup executor and converts this trail in the same ticket. Until then, S04-03 to S04-07 run on the single-script executor described above. This section owns the record and trail side of that switch; 12a owns the runner, readiness and retry rules.

Record. S12T-11 adds one optional field to the setup detail:

```ts
/** One startup action frozen by the current setup attempt. Its script stays in the environment document and the run's launch snapshot. */
export const ThreadStartupActionSchema = lazySchema(() => z.object({
  actionId: WorkspaceEnvironmentActionIdSchema,        // the environment document's own id bound
  scriptHash: z.string().regex(/^[a-f0-9]{64}$/),      // sha256 of the resolved script for this platform
  runId: z.string().min(1).max(256).nullable(),        // null until the runner starts it
  outcome: z.enum(["pending", "running", "ready", "failed", "skipped"]),
}).strict());

// The setup detail gains:
//   actions: z.array(ThreadStartupActionSchema()).max(WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX).optional()
```

- Bounds. Action ids use the document's id schema, and the count uses `WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX`, the same constant the document validation enforces (12a Backend E). The record holds no script text, so every configuration the document accepts fits the record, whatever its script sizes.
- `outcome` holds what only the runner knows: whether an action is ready (its current run exited 0), still running, failed, or skipped by Retry. Run status, times, terminal id and command text come from the run record. The step-level `exitCode` (section A) is the failed action's exit code.
- Only the runner writes `actions`, in the same step that changes the attempt. The attempt keeps no second copy of the list.

Trail projection after S12T-11:

1. Header lines (04b): one `$ <first script line>` per entry that has a run, read from that run's launch snapshot through `workspace.environment.action.list({threadId})` and `workspace.environment.action.updated` (already held in `project-action-store`). Entries not started yet appear when they start. If a later manual run replaced the entry's run in its slot (the run ids differ), the line shows that slot run's `actionName` instead.
2. The step argument and the collapsed "Started in" row show the first entry's line.
3. Tail: `ThreadStartup.transcript`, unchanged in shape and bounded by the locked 32-entry, 16KB caps. The runner writes each startup run's command-phase output into it as plain text (12a Backend F). The trail renders it read-only and never as a second terminal.
4. Open terminal focuses the Terminal tab on the `terminalSessionId` of the running entry, else the failed one. It is hidden when that terminal was closed (`terminalSessionId: null`). It replaces `openAutomaticSetupTerminal`.
5. Edit script opens Project settings (S12T-13 deep-links it to Actions).
6. Setup failed shows "exit N · m:ss" from the step's `exitCode` and duration, with the block `detail` line. Retry setup calls `retryAutomaticSetup`. It reruns from the first failed action and skips actions that exited 0 earlier in this startup, unless their script hash changed. Skip setup calls `continueAutomaticSetup`; actions still running keep running.
7. Setup needs approval names the pending entry's command. Run setup approves that run's `snapshot.approval` fingerprint and starts it, the same calls as the terminal's approval card (S12T-07); the runner then continues. Each shared action asks once, in order.
8. Readiness (12a Backend F): an action is ready only when its current run exits 0. A detected port is a display fact for the Browser and the terminal, never Setup readiness. An action that never exits, such as `bun run dev` or `bun test --watch`, keeps the step at Running setup until it exits or the user picks Skip setup. Whether a per-action "Keeps running" toggle follows is decision T3; S12T-11 builds none of it.
9. Which threads get a setup step stays section D's decision; the runner takes a `threadId` and does not decide.

S12T-11 also removes the trail's pre-switch reads of the gate snapshot and its `openAutomaticSetupTerminal` call.

### F. Turn failure on the wire (S08F-01)

New file `packages/contracts/src/models/turn-failure.ts`:

```ts
/** Why a turn failed, as classified by the adapter that saw the native error. */
export const TurnFailureKindSchema = z.enum(["retryable", "usage_limit", "auth", "fatal"]);

/** Adapter-classified failure carried by every provider Error event. */
export const TurnFailureSchema = lazySchema(() => z.object({
  kind: TurnFailureKindSchema,
  /** HTTP status when the provider exposed one. */
  status: z.number().int().min(100).max(599).optional(),
  /** Provider-native code, e.g. "usageLimitExceeded", "authentication_failed", "-32000". */
  code: z.string().trim().min(1).max(128).optional(),
  /** Relative wait from the moment the adapter emitted the event. The server converts it to resetsAt. */
  retryAfterMs: z.number().int().nonnegative().max(31 * 24 * 3_600_000).optional(),
  /** Provider limit window, e.g. "five_hour", "seven_day". */
  limitType: z.string().trim().min(1).max(64).optional(),
  /** The provider's own retries before giving up. */
  retries: z.object({
    made: z.number().int().nonnegative(),
    max: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict());

// agent-event.ts, the Error member:
z.object({ type: z.literal(AgentEventType.Error), threadId: z.string(), error: z.string(), failure: TurnFailureSchema() })
```

- `failure` is required. S08F-01 updates every emit site so that `error` events and thrown dispatch errors carry `{ kind: "fatal" }`. The typechecker lists the sites, and the per-adapter tickets refine them. "Fatal" means "not classified": it is honest and never offers a success path.
- Thrown dispatch errors: providers throw `ProviderTurnError extends Error { failure }` (new, exported from `packages/providers`). `failWorkerDispatch` (`turn-runtime-controller.ts:1035-1058`) reads `failure`. A plain `Error` maps to `{ kind: "fatal" }`.
- Session resume: providers throw `SessionResumeUnavailableError` when `TurnRequest.resumeRequired` is true and the native session cannot be resumed (see H).
- Server enrichment happens once, where the execution accepts the terminal error:
  - `provider` comes from the execution's provider id.
  - `resetsAt` is acceptance time plus `retryAfterMs`. Persist the absolute time, because a relative wait means nothing after a reload.
  - `retries` comes from the execution's last `ApiRetry` (`attempt`, `maxRetries`) when the adapter left it out.
- Keep the semantic-writer match at `canonical-execution-semantic-writer.ts:1789` exact, and extend it to compare `failure`.
- `TurnErrorPolicy` (`turn-error-policy.ts:25-40`) stays the gate for automatic attempts. This section does not change it.

### G. Persisted ending (S08F-01)

```ts
// packages/agent-model/src/records.ts
/** Why an interrupted turn stopped. "unknown" covers rows written before causes existed. */
export const InterruptionCauseSchema = z.enum(["app_closed", "provider_exited", "saving_stopped", "unknown"]);

export const PersistedTurnFailureSchema = z.object({
  kind: z.enum(["retryable", "usage_limit", "auth", "fatal"]),
  provider: ProviderIdSchema,
  message: z.string().trim().min(1).max(8_000),            // raw text for Details
  status: z.number().int().min(100).max(599).optional(),
  code: z.string().trim().min(1).max(128).optional(),
  resetsAt: CanonicalTimestampSchema.optional(),
  limitType: z.string().trim().min(1).max(64).optional(),
  retries: z.object({ made: z.number().int().nonnegative(), max: z.number().int().positive().optional() }).strict().optional(),
}).strict();

/** Why Mcode itself, not the user, stopped a turn. */
export const SystemStopReasonSchema = z.enum([
  "approval_unanswerable", // a Deny could not be delivered upstream (S06-00, S06-01)
  "thread_control",        // another thread stopped this one through thread control (inferred source)
  "thread_deleted",        // teardown of a deleted thread; no notice is ever shown
]);

/** Who stopped a cancelled turn. Rows written before stop causes existed read as "user". */
export const TurnStopCauseSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("user") }).strict(),
  z.object({ by: z.literal("mcode"), reason: SystemStopReasonSchema }).strict(),
]);

/** Cause of a non-completed ending; null for completed and running turns. */
export const AgentTurnEndingSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled"), stop: TurnStopCauseSchema }).strict(),
  z.object({ outcome: z.literal("interrupted"), cause: InterruptionCauseSchema }).strict(),
  z.object({ outcome: z.literal("errored"), failure: PersistedTurnFailureSchema }).strict(),
]);

// AgentTurnSchema gains: ending: AgentTurnEndingSchema.nullable()
// turn.cancelled gains:   stop: TurnStopCauseSchema.optional()
// turn.errored gains:     failure: PersistedTurnFailureSchema.optional()
// turn.interrupted gains: cause: InterruptionCauseSchema.optional()
```

Event fields are optional only so old envelopes still parse during replay. The reducer then fills the ending:

- An old `turn.cancelled` gets `stop: { by: "user" }`, which is what every stop meant before this change.
- An old `turn.errored` becomes `{ kind: "fatal", provider: <turn provider>, message: error }`.
- An old `turn.interrupted` gets cause `"unknown"`.

This is a legacy read path, not a fallback for new writes. New writers always set all three fields.

Stop cause. `AgentService.stopSession` and `TurnRuntimeController.stopSession` (`agent-service.ts:35`, `turn-runtime-controller.ts:2068`) take a required `stop: TurnStopCause`, so no caller can leave it out and default to "You stopped". The controller keeps the cause with the stop operation it already shares per thread; when two stops race, the first cause wins. The canonical writer copies it into `turn.cancelled`. Callers:

| Caller | Cause |
|---|---|
| `agent.stop` RPC (`agent-rpc.ts:149`): composer Stop, Esc, the turn menu | `{ by: "user" }` |
| `thread.startup.cancel` in the agent phase (section C) | `{ by: "user" }` |
| ApprovalService fail-closed stop after a Deny the provider did not take (S06-00, S06-01) | `{ by: "mcode", reason: "approval_unanswerable" }` |
| `ThreadControlService.stopTarget` (`thread-control-service.ts:1767-1768`) | `{ by: "mcode", reason: "thread_control" }` |
| `TurnRuntimeController.teardownSession` (`turn-runtime-controller.ts:2090`) | `{ by: "mcode", reason: "thread_deleted" }` |

The receipt that S06 writes for the stopped approval (`cancelled { unanswerable }`) says which request failed; the end notice only says who stopped the turn.

Storage: a new nullable `ending_json` column on `canonical_agent_turns`. It belongs to the same migration as `provider_started_at` if S04-02 and S08F-01 land together. Otherwise each ticket generates its own.

Cause sources:

| Cause | Source |
|---|---|
| `app_closed` | Restart recovery in `TurnRecoveryService.interruptUnfinishedCheckpoint` (`turn-recovery-service.ts:62-75`), and shutdown finalization (`pipelineTerminalSource("shutdown")`, `agent-service-helpers.ts:67-73`) |
| `provider_exited` | A provider `Ended` with cancelled or interrupted that was not a user stop (`provider-turn-event-application.ts:568`, `turn-runtime-controller.ts:2163-2167`), Codex `provider_lost` (`codex-provider.ts:2255-2272`), and Devin shutdown or restart |
| `saving_stopped` | `ingest.overflow` (`reducer.ts` `reduceIngestOverflow`) and checkpoint-failure finalization |

### H. Recovery commands (S08F-05, 06, 07)

Contracts go in `packages/contracts/src/ws/methods.ts`, with types in `models/turn-recovery.ts`:

```ts
export const ScheduledTurnRetrySchema = lazySchema(() => z.object({
  turnId: AgentTurnIdSchema, at: z.string().datetime({ offset: true }),
}).strict());

"turn.retry": {                       // errored turn → replacement turn, same prompt
  params: z.object({ threadId: z.string().min(1).max(256), turnId: AgentTurnIdSchema,
    model: z.string().trim().min(1).max(256).optional() }).strict(),   // Switch model
  result: z.object({ turnId: AgentTurnIdSchema }).strict(),
},
"turn.resume": {                      // interrupted turn → same session, else seeded session
  params: z.object({ threadId: z.string().min(1).max(256), turnId: AgentTurnIdSchema }).strict(),
  result: z.object({ turnId: AgentTurnIdSchema, mode: z.enum(["native-session", "seeded-session"]) }).strict(),
},
"turn.retry.schedule":   { params: z.object({ threadId, turnId, at }).strict(), result: ScheduledTurnRetrySchema() },
"turn.retry.unschedule": { params: z.object({ threadId }).strict(), result: z.void() },
// push channel
"thread.retryScheduled": z.object({ threadId: z.string(), retry: ScheduledTurnRetrySchema().nullable() }),
// ThreadSchema gains scheduled_retry: ScheduledTurnRetrySchema().nullable(), so a reload restores the notice
```

The server side extends `TurnRecoveryService` (`apps/server/src/features/agents/recovery/turn-recovery-service.ts`), which becomes the one owner of recovery commands.

Shared preconditions, each rejected with a typed error:

- The turn is the thread's latest attempt.
- The thread has no running turn or nonterminal startup.
- The attempt was not already retried or resumed. `consumeRetry` makes this one-shot per attempt (`canonical-parent-turn-lifecycle.ts:397-406`), so a second call on the same attempt conflicts.

Attempts (E2). Retry, Resume and Retry at reset start a new attempt of the same logical turn, never a new turn of their own:

- The link is `AgentTurn.attemptOf: AgentTurnId | null`: the id of the logical turn's first attempt, null on a first attempt, so chains stay flat. It is stored in a nullable `attempt_of` column on `canonical_agent_turns`. S10-03 adds the field and the column, because Review needs them first: the parent start derives `attemptOf` whenever `retryOfExecutionId` is set (`canonical-runtime-write-operations.ts:43`), in the same transaction as `consumeRetry` (`canonical-parent-turn-lifecycle.ts:397-406`). Retry and Resume therefore get the link by passing `retryOfExecutionId`, which they do on every path. There is no second link.
- Records stay: every attempt keeps its turn, messages, items, checkpoint and ending. Only the transcript projection folds them.
- Transcript rule (S08F-05), in the web projection (`apps/web/src/features/conversation/messages/virtual-items.ts`): for each logical turn, render the first attempt's user message, then only the latest attempt's work fold, answer, changes bar and end notice. A later attempt's own user message (Retry's copy, or Resume's hidden continuation) never renders, and neither does anything from an earlier attempt once a later one exists. While the replacement attempt runs, the turn shows it running.
- Review treats the attempts as one turn: the Turn view diff of a retried turn starts at the first attempt's baseline, so partial edits from a failed attempt still show. Section 10 owns that comparison (see section 10, S10-03).

`retry`:

- Requires status Errored.
- Loads the accepted user message (`loadUserMessage(turnId)`, `:102`) and the attachments (`prepareRetryAttachments`, `:108`).
- Dispatches a normal `SendMessageCommand` with the same content, mentions and annotations, `model: input.model ?? thread.model`, `retryOfExecutionId` (from which the start derives `attemptOf`) and `recoveryMode: "retry"`. The stored copy of the message is the new attempt's record; the transcript does not show it.
- It does not set `forceFreshSession`. The provider session continues, so the agent sees its partial edits and history.

`resume`:

- Requires status Interrupted.
- Takes the native path when the provider declares the new capability `session-resume` (added to `ProviderCapabilityNameSchema`, `packages/agent-model/src/capabilities.ts:5-21`), the thread has `sdk_session_id`, and the provider has not changed.
- The native path sends a continuation as an internal message (`is_internal`, hidden): "The previous turn was interrupted before it finished. Continue the task. Check the working tree before repeating a step." It sets `resumeRequired: true` on the `TurnRequest`.
- If the adapter throws `SessionResumeUnavailableError` before delivering the prompt, the server starts another attempt of the same turn on a fresh session. That session is seeded with a deterministic handoff built from the thread's messages (path D, `HandoffPipelineService`, `apps/server/src/features/handoff/orchestration/handoff-pipeline.ts:163`), anchored at the interrupted turn's user message.
- The result mode reports which path ran.
- Reuse of `HandoffCoordinator.deliverHandoff` for the same thread is inferred. Today it targets child threads (`handoff-coordinator.ts:182-230`).

Scheduled retry (new `turn-retry-scheduler.ts` and `turn-retry-schedule-store.ts` in `apps/server/src/features/agents/recovery/`):

- Table `turn_retry_schedules(thread_id TEXT PK REFERENCES threads ON DELETE CASCADE, turn_id TEXT NOT NULL, execution_id TEXT NOT NULL, run_at TEXT NOT NULL, created_at TEXT NOT NULL)`, added by a migration. One schedule per thread. Scheduling again replaces it.
- Cleared by any new send on the thread, by unschedule, by thread delete (cascade), and by firing.
- At boot the scheduler loads rows. A row overdue by up to 15 minutes fires. An older row is dropped and the notice falls back to Retry (open question 4). Prior art for persisted schedules: `thread-completion-service.ts:154-262` (`scheduled_deletion_at`).
- Firing calls `retry`. If that fails, the turn stays Failed with the new failure.
- This complies with ADR-0022: the user scheduled the retry, so it is not an automatic replay.

Transcript: a replacement attempt shows no receipt and no copy of the prompt; it takes the failed or interrupted attempt's place under the one user message (Attempts, above; decided, open question 2).

### I. Per-provider decisions

Sources: an Explore sweep of all six adapters, with the key lines re-read here (marked verified). SDK field names that are not vendored in this worktree are marked (inferred).

| Provider | Error emission today | Classification (new) | Status, code, retries source | ApiRetry | Session resume (`session-resume`, `resumeRequired`) | Ticket |
|---|---|---|---|---|---|---|
| Claude | Result with `is_error` becomes `Error(errors.join)`, verified at `claude-event-mapper.ts:256-271`. A stream throw becomes `Error` (`claude-provider.ts:2244-2272`). `Ended` never carries an outcome. | **auth**: assistant `error` is `authentication_failed` or `oauth_org_not_allowed`, or the unauthenticated startup error (fixture `conformance/fixtures/claude-startup-error.captured.json`). **usage_limit**: assistant `error` is `rate_limit` or `billing_error`, or the last `rate_limit_event` was `rejected`. `retryAfterMs` comes from `resetsAt*1000 - now` and `limitType` from `rateLimitType`. **retryable**: `server_error`, `overloaded`, `api_error_status >= 500`, or a stream `ECONNRESET`. **fatal**: `prompt_too_long`, `error_max_turns`, `error_max_budget_usd`, and the rest. Field names per SDK 0.3.212 `sdk.d.ts` (inferred, not in this worktree). | `status` from `api_error_status`. `code` from the assistant `error` or result `subtype`. `retries` from the last `api_retry`. | Complete today (`claude-event-mapper.ts:382-391`, verified). No change. Also fix `rate_limit_event` so only `rejected` sets `active` (`:558-585`). | Supported (`resume` option, `claude-provider.ts:602-604`). Today "No conversation found" restarts fresh (`:2134-2173`). With `resumeRequired` it must throw instead. | S08F-02, S08F-06 |
| Codex | Failed `turn/completed` becomes `Error(turn.error.message)`, verified at `codex-event-mapper.ts:2028-2042`, plus `Ended` errored (`codex-provider.ts:2643-2645`). Transport and spawn failures go through `emitTurnFailure` (`:842-864`). | Based on `turn.error.codexErrorInfo` (dropped today at `:2036-2041`). **usage_limit**: `usageLimitExceeded`, with `retryAfterMs` from the latest `account/rateLimits` reset (`codex-input-mapper.ts:86-128`). **auth**: `unauthorized` (inferred variant). **retryable**: `httpConnectionFailed`, a stream disconnect or a server error (inferred variants), and handshake timeout. **fatal**: `contextWindowExceeded` (inferred) and the rest. | `status` from `codexErrorInfo.httpConnectionFailed.httpStatusCode` (inferred). `code` from the variant name, or the JSON-RPC `error.code` (`codex-rpc-client.ts:250-251`). `retries` counted from `willRetry` notices. | Reason only today (`codex-event-mapper.ts:2108-2116`, verified). Add `errorStatus` and `attempt` when `codexErrorInfo` or `additionalDetails` carry them (inferred). | `thread/resume` (`codex-app-server.ts:1529-1547`). Today a missing thread falls back to `thread/start` plus `context_lost` (`:620-694`). With `resumeRequired` it must throw instead. | S08F-02, S08F-06 |
| Cursor (ACP) | A prompt failure becomes `Error`, then `Ended` with no outcome (`cursor-turn-executor.ts:392-431`). An acquire or spawn failure becomes `Error` (`cursor-provider.ts:661-673`). | **auth**: ACP `RequestError.code -32000`. Keep the code instead of reducing the error to its message (`cursor-session-recovery-error.ts:7-12`). Init swallows auth errors (`cursor-acp-process-spawner.ts:119`), so auth surfaces at prompt time. **retryable**: 429, 5xx, `resource_exhausted` after the adapter's own retry runs out, or ACP connection closed. **usage_limit**: a message naming a usage limit (inferred, no structured signal). **fatal**: the rest. | `status` parsed by the existing regex (`cursor-acp-transient-retry.ts:29-173`). `code` is the ACP code. `retries` from the adapter's own loop (1 of 1). | None today. Emit `ApiRetry` from the adapter's internal retry loop with attempt, max and delay. | ACP `session/resume` or `session/load` per agent capabilities (`acp-session-runtime.ts:196-300`). It is already fail-without-replacement. Map that failure to `SessionResumeUnavailableError`. | S08F-03, S08F-06 |
| Copilot | `session.error` becomes `Error(data.message)` (`copilot-event-mapper.ts:115-117`). `Ended` is cancelled or errored (`copilot-provider.ts:233`). | From `session.error.data.errorType` (SDK 0.2.2, inferred). **auth**: `authentication` or `authorization`. **usage_limit**: `quota`. **retryable**: `rate_limit`, or `statusCode >= 500`. **fatal**: `context_limit` and the rest. | `status` from `data.statusCode`. `code` from `errorType`. No retries signal. | No signal. No change. | `client.resumeSession` (`copilot-provider.ts:83-88,154`), with no fallback today. With `resumeRequired`, a throw maps to `SessionResumeUnavailableError`. | S08F-04, S08F-06 |
| Devin (ACP) | A prompt failure becomes `Error` plus `Ended` errored (`devin-provider.ts:652-689`). Stop causes map through `STOP_OUTCOMES` with no `Error` (`:119-147`, verified). | **usage_limit**: `quota_exhausted`, errored (was interrupted). **auth**: `auth_required` (was interrupted), missing credentials (`devin-credentials.ts:22-36`), and ACP code `-32000`. **fatal**: `content_filter` (was interrupted) and the rest. **No change**: `shutdown` and `restart` stay interrupted with cause `provider_exited`. **Unchanged, open question 10**: `tool_rejected`. | `code` is the cause or the ACP code. No status. | No signal. No change. | Shared ACP runtime with fail-without-replacement (`devin-provider.ts:974`). Map that failure to `SessionResumeUnavailableError`. | S08F-03, S08F-06 |
| OpenCode (`apps/server/src/features/providers/adapters/opencode`) | Bug: mapped `Error` events are skipped (`opencode-provider.ts:1131`) and `settle("errored")` carries no text (`:858-859`), verified. Other paths call `settle(message)` (`:1176-1191`). | Fix the bug by settling with the mapped error's message and failure. **auth**: `ProviderAuthError` (`opencode-event-mapper.ts:176-185`). **retryable** or **fatal**: from `APIError` `statusCode` and `isRetryable` (inferred). **usage_limit**: 429 with quota wording (inferred). | `status` from `APIError.statusCode` (inferred), or parsed from "failed with HTTP ${status}" (`opencode-http-client.ts:101,325`). | None today. Map `session.status` retry (`attempt`, `next`) to `ApiRetry` (inferred fields; today state-only, `opencode-event-mapper.ts:268,537`). | The resume cursor is checked by a history read. A 404 starts fresh with a notice (`opencode-provider.ts:732-779`). With `resumeRequired` it must throw instead. | S08F-04, S08F-06 |

All providers:

- Provider frame (S04-02): no adapter change. The server rule in section B covers it.
- Sign in (S08F-08): no adapter change. S09 owns the per-provider sign-in action. An auth-kind failure feeds S09 as evidence that the provider needs a sign-in check (see Risks).
- Startup (S04): no adapter change. "Thread didn't start" shows the failure from S08F.
- Stop cause (S08F-01): no adapter change. The server records who asked for the stop; adapters keep ending the turn as cancelled.

### J. Outcome to end notice: the one table

This table lives in `apps/web/src/features/conversation/turn-ending/turn-ending-notice.ts`. Its input is `{ status, ending, providerStartedAt, durationMs, providerLabel, providerCondition, scheduledRetry, isStartupTurn }`, and its output is `{ foldLabel, notice: QuietNotice | FilledNotice | null }`.

| Ending | Condition | Work fold label (S05) | Style | Icon | Title | Detail | Secondary | Primary |
|---|---|---|---|---|---|---|---|---|
| cancelled | `stop.by` user, provider started | "Stopped after {d}" | quiet | stop square, muted | You stopped | none | none | none |
| cancelled | `stop.by` user, `providerStartedAt === null`, not the startup turn | no fold | quiet | stop square, muted | Stopped before {Provider} started | none | none | none |
| cancelled | `stop.by` mcode, reason `approval_unanswerable` | "Stopped after {d}", or no fold before the first frame | quiet | stop square, muted | Stopped by Mcode | Mcode couldn't answer an approval request | none | none |
| cancelled | `stop.by` mcode, reason `thread_control` | same | quiet | stop square, muted | Stopped by another thread | none | none | none |
| cancelled | `stop.by` mcode, reason `thread_deleted` | no fold | none | none | none (the thread is gone) | none | none | none |
| any non-completed | startup turn before its first frame | no fold | none | none | none (the trail shows Cancelled or Thread didn't start) | none | none | none |
| interrupted | cause `app_closed` | "Interrupted after {d}" | filled | pause circle, primary | Interrupted | Mcode closed while {Provider} was working | none | Resume |
| interrupted | cause `provider_exited` | same | filled | same | Interrupted | {Provider} stopped unexpectedly | none | Resume |
| interrupted | cause `saving_stopped` | same | filled | same | Interrupted | Mcode stopped saving {Provider}'s output | none | Resume |
| interrupted | cause `unknown` | same | filled | same | Interrupted | {Provider} stopped before finishing | none | Resume |
| errored | `retryable` | "Failed after {d}" | filled | warning circle, error | {Provider} stopped responding | `{status phrase} after {n} retries`, or `{status phrase}`, or the first line of the message | Details | Retry |
| errored | `fatal` | same | filled | same | {Provider} couldn't finish this turn | first line of the message | Details | Retry (open question 1) |
| errored | `usage_limit` with `resetsAt` | same | filled | clock, primary | {Provider} usage limit reached | `{limit label} · resets {HH:MM}` | Switch model | Retry at {HH:MM} |
| errored | `usage_limit` with a scheduled retry | same | filled | clock, primary | {Provider} usage limit reached | Retrying at {HH:MM} | Switch model | Cancel retry |
| errored | `usage_limit` without `resetsAt` | same | filled | clock, primary | {Provider} usage limit reached | `{limit label}` or "Usage limit" | Switch model | Retry |
| errored | `auth` and the S09 condition says signed out | same | filled | warning circle, error | {Provider} is signed out | Threads on {Provider} can't run until you sign in | none | Sign in |
| errored | `auth` after the condition clears | same | filled | warning circle, error | {Provider} is signed out | same | none | Retry |

Notes:

- Details shows `failure.message`, then a final line `turn {executionId first 8}`, with a Copy button. "Hide details" collapses it.
- The table runs only for a logical turn's latest attempt. An attempt that a Retry or Resume replaced renders no notice (section H, Attempts).
- "Stopped by Mcode" and "Stopped by another thread" are not drawn in Paper; they reuse the quiet "You stopped" style, and the copy needs the designer's check (open question 11).
- Status phrases come from a small table keyed by status (502 is "Bad Gateway").
- Limit labels: `five_hour` is "5-hour limit" and `seven_day` is "Weekly limit". Other values pass through.

### K. Queued input across endings (S08F-05)

S08F-05 owns what happens to queued user input when a turn does not complete. S06-07 depends on it: a deny note queued for the next turn must survive the turn failing.

Today (verified):

- An error clears the queue: `handleErrorEvent` calls `clearDequeueTimer` and `clearQueue` (`apps/web/src/stores/threadStore.ts:2687-2688`).
- An interrupted ending drains it: `handleTerminalEvent` schedules auto-drain for every runtime-owned terminal event except guardrail stops (`threadStore.ts:2537-2554`), so a queued follow-up runs after a provider exit as if the turn had finished.
- A user Stop already pauses it: `stopAgent` calls `suppressAutoDrain` (`threadStore.ts:3572-3574`; `queueStore.ts:275-288`), and Continue resumes through `resumeNext` (`useQueuedMessageDispatch.ts:46-53`).
- The queue lives in client memory only.

Rule, in one place in the store:

- Only a completed ending schedules auto-drain.
- Every other ending (errored, interrupted, cancelled by the user or by Mcode) keeps the queue and suppresses auto-drain. No ending path calls `clearQueue`; only the user's Clear or Remove and thread deletion do.
- The pause is visible: while the queue has messages, the thread is idle and auto-drain is suppressed, the queue shows a quiet "Paused" label (12/16, `--color-muted`) above its rows. Paper does not draw it, so the designer should check it.
- The way out is an explicit send: a row's Send now (S05-10), or Continue in today's list, dispatches the first message and resumes auto-drain.
- Retry, Resume and Retry at reset neither drain nor clear the queue. The user sends queued input when ready.
- A reload or app restart still loses the client queue, as today. Two exceptions live on the server: S05-10 keeps steers whose delivery is unknown and their pending resends (`agent.listHeldSteers`), and S06-07 persists deny-note delivery.

## Components

### New

- **Web, `apps/web/src/features/thread-startup/`**
  - `StartupStepsTrail.tsx`: renders one `ThreadStartup` with props and callbacks only. It covers every 04f state, the collapsed "Started in" row with an expand caret, and live durations on one shared 1s timer that stops when nothing is live.
  - `StartupSetupOutput.tsx`: the 04b card.
  - `startup-step-copy.ts`: one table from phase, state and detail to label and argument. Examples: fetch is "Fetching", "Fetched", "Fetch failed"; worktree created is "Create", "Creating", "Created" worktree; worktree opened is "Opened worktree"; setup is "Run setup", "Running setup", "Ran setup", "Skipped setup", "Setup failed", "Setup needs approval"; agent is "Start thread", "Starting thread", "Thread didn't start"; any cancelled step is "Cancelled". An interrupted step reads "{Step} stopped" and offers the failed-state actions. Paper does not draw it, so the designer should check it.
  - `useStartupActions.ts`: cancel, retry setup, skip setup, run setup (approve), retry creation, start from local base, edit message, keep thread, open terminal and edit script.
  - `useThreadStartupRowState.ts`: a selector for the S01 row model ("starting", "needs-you" or null). It reads the pushed startup record instead of polling.
  - `first-send-motion.ts`: the FLIP record, `recordFirstSend()` and `useFirstSendMotion()`.
- **Web, `apps/web/src/features/conversation/turn-ending/`**
  - `turn-ending-notice.ts`: the table in section J.
  - `TurnEndNotice.tsx`: the quiet and filled variants, Details with Copy.
  - `ProviderRetryLine.tsx`: the `ApiRetry` quiet line with a ticking "next in Ns".
  - `useTurnRecovery.ts`: retry, resume, schedule and unschedule.
- **Contracts**
  - `models/turn-failure.ts`.
  - Additions to `models/turn-recovery.ts` and to the `ws/methods.ts` and `ws/channels.ts` entries.
- **Agent model**: `turn.provider-started`, `providerStartedAt`, `ending`, `InterruptionCause`, `TurnStopCause`, and the `session-resume` capability. `attemptOf` comes from S10-03.
- **Server**
  - `thread-startup/startup-agent-phase-observer.ts`.
  - `agents/recovery/turn-retry-scheduler.ts` and `turn-retry-schedule-store.ts`.
  - A worktree occupancy check inside the environment service.
  - Migrations for `canonical_agent_turns` (2 columns: `provider_started_at`, `ending_json`; S10-03 adds `attempt_of`) and `turn_retry_schedules`.
- **Providers**
  - One pure classifier per adapter, for example `claude-failure-classifier.ts`, from native shapes to `TurnFailure`, tested with fixtures.
  - `ProviderTurnError` and `SessionResumeUnavailableError`.

### Changed

- **Contracts**
  - `thread-startup.ts`: section A.
  - `events/agent-event.ts`: `Error.failure`.
  - `ThreadSchema`: `scheduled_retry`.
- **Server**
  - `thread-creation-coordinator.ts`: kinds, the fetch phase, details, error detail.
  - `thread-startup-state-store.ts`: timing.
  - `thread-startup-rpc.ts`: cancel in every phase.
  - `workspace-environment-service.ts`: eligibility, sibling skip, setup detail, block detail.
  - `turn-admission-dispatch-coordinator.ts:348`.
  - `turn-runtime-controller.ts`: startup completion moves to the observer, `failWorkerDispatch` reads `failure`, and `stopSession` takes a required stop cause (also `agent-service.ts`, `agent-rpc.ts`, `thread-control-service.ts`).
  - `turn-recovery-service.ts`: retry, resume, schedule.
  - The canonical writer: `failure`, `cause`, provider-started.
- **Providers**: all six adapters, per section I.
- **Web**
  - `ChatViewSurface.tsx`: one thread surface with a preparing variant, and no setup card.
  - `Composer.tsx` and `ComposerContentSurface.tsx`: the starting state and Esc.
  - `threadStore.ts`: keep `errorStatus`, drop the `agent_error` message, and keep queued input on every non-completed ending (S08F-05).
  - The composer queue (`ComposerQueueList.tsx` today, the S05-10 tray rows later): a quiet paused label (S08F-05).
  - `TurnFooter.tsx`: outcome labels removed.
  - `ProjectTree.tsx`: setup and recovery inputs.
  - `PullRequestReviewTaskDialog.tsx` and `PullRequestForkDialog.tsx`: use `StartupStepsTrail`.
  - `ThreadStateMarker.tsx`, `lib/thread-status.ts`, `ThreadFilterDropdown.tsx`: "Failed".
- **Docs**
  - `docs/internals/projects/environment.md` (S04-07).
  - `CONTEXT.md`, in S08F-05 and S08F-06:
    - Turn outcome: drop the stale mismatch note and name the visible words Stopped, Interrupted and Failed.
    - Replacement turn: covers errored turns too.
    - Recovery incident: now server-side provenance only.
    - Setup gate: "Continue without setup" becomes "Skip setup".
    - Transient failure: drop the stale "Behaviour pending" note.

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| `StartupProgressCard` and its test and export | `apps/web/src/features/thread-startup/StartupProgressCard.tsx`, `__tests__/StartupProgressCard.test.tsx`, `index.ts:2` | `StartupStepsTrail` | S04-03 | `rg -n "StartupProgressCard" apps packages` returns nothing |
| Preparing shell: `ThreadPreparingShell`, `PreparingThreadHeader`, `PreparingStartupContent`, `startupContext`, `StartupDisplayContext` | `ChatViewSurface.tsx:192-312`, `StartupProgressCard.tsx:12` | The shared thread surface with a preparing conversation | S04-03 | `rg -n "ThreadPreparingShell\|PreparingThreadHeader\|StartupDisplayContext" apps/web/src` returns nothing |
| `startup-node-pop` keyframes, class and its reduced-motion rule | `apps/web/src/index.css:672-680` and `:687-689`. Keep `startup-activity-shimmer` and its reduced-motion rule at `:683-686`, which narrative rows use | Paper trail glyphs, no pop | S04-03 | `rg -n "startup-node-pop" apps/web/src` returns nothing |
| Copy "Preparing managed checkout", "Starting local thread", "Attaching existing checkout", "More details", "Run project setup" | `StartupProgressCard.tsx:41-77,292` | `startup-step-copy.ts` | S04-03 | `rg -n "Preparing managed checkout\|Run project setup" apps/web/src` returns nothing |
| In-chat setup card: `ProjectAutomaticSetupCard`, `AutomaticSetupAttemptCard`, `AutomaticSetupOutput`, `AutomaticSetupRecoveryActions`, `AutomaticSetupApproval`, and the automatic-setup use of `ProjectCommandApprovalDialog` (S12T-11 deletes the component itself) | `ProjectAutomaticSetupControl.tsx:143-261`, `environment/index.ts:15-19`, `ChatViewSurface.tsx:589,626-627` | Trail setup states, inline Run setup | S04-04 | `rg -n "ProjectAutomaticSetupCard\|AutomaticSetupAttemptCard" apps/web/src` returns nothing |
| `useProjectAutomaticSetup` (1s polling) and `useProjectAutomaticSetupStore` | `ProjectAutomaticSetupControl.tsx:25-141`, callers `ChatViewSurface.tsx:294,695`, `ProjectTree.tsx:1451` | The `thread.startup.updated` push, `useStartupActions`, `useThreadStartupRowState` | S04-04 | `rg -n "useProjectAutomaticSetup" apps/web/src` returns nothing |
| `SetupRecoveryActions`, `StartupAutomaticSetupActions`, `StartupAutomaticSetupAction`, `CancelledStartupActions`, `startupNeedsSetupRecovery` | `ChatViewSurface.tsx:205-236,276-279,484-620` | Trail actions | S04-04 | `rg -n "SetupRecoveryActions\|CancelledStartupActions\|StartupAutomaticSetupAction" apps/web/src` returns nothing |
| Visible copy "Continue without setup", "Environment setup failed", "Start over" | `ProjectAutomaticSetupControl.tsx:144-147,193`, `ChatViewSurface.tsx:224,495` | "Skip setup", "Setup failed", "Edit message" | S04-04 | `rg -n "Continue without setup\|Environment setup failed\|Start over" apps/web/src` returns nothing |
| `setupBlocked` prop and its placeholder "Resolve Automatic Setup before sending a follow-up" | `Composer.tsx:235,280,660`, `ComposerContentSurface.tsx:59,283,297,504-516,584`, `ChatViewSurface.tsx:712` | The composer starting state | S04-05 | `rg -n "setupBlocked\|Resolve Automatic Setup" apps/web/src` returns nothing |
| Queued-turn cancel and the client stop for automatic setup: web `cancelQueuedAutomaticTurn` and `stopAutomaticSetup`, ws methods `workspace.environment.automaticSetup.cancelQueuedTurn` and `.stop`, and the service's `cancelQueuedAutomaticTurn`. The service's `stopAutomaticSetup` stays; `thread.startup.cancel` calls it | `transport/types.ts:338,340`, `ws-transport.ts:1086-1095`, `methods.ts:515-516,552-559`, `workspace-environment-rpc.ts:39-40,91-94`, `workspace-environment-service.ts:429-440` | No queueing during startup. Cancel goes through `thread.startup.cancel` | S04-05 | `rg -n "cancelQueuedAutomaticTurn\|automaticSetup\.cancelQueuedTurn\|automaticSetup\.stop\"" apps packages` returns nothing |
| Coordinator completing the startup at admission: `completeInitialAgent` and its two calls | `turn-runtime-controller.ts:2011,2058`, `thread-creation-coordinator.ts:155-158` | `StartupAgentPhaseObserver`, which calls the startup service's `complete` at the first frame | S04-02 | `rg -n "completeInitialAgent" apps/server/src` returns nothing |
| `Error` events without `failure` (the name `AgentEventType.Error` stays) | Every `type: AgentEventType.Error` emit site | Required `failure` | S08F-01 | `bun run --cwd packages/contracts test -- src/events/__tests__/agent-event.test.ts` passes with a case that rejects an `Error` without `failure` |
| `TurnFooter` outcome labels (`outcomeLabel`, `TurnFooterStatus`, `data-testid="turn-outcome"`) | `TurnFooter.tsx:16-23,45-53,93,102` | Work fold label (S05) and `TurnEndNotice` | S08F-05 | `rg -n "outcomeLabel\|TurnFooterStatus\|data-testid=\"turn-outcome\"" apps/web/src` returns nothing |
| Client-only `agent_error` system message and its red box | `threadStore.ts:2657-2659,2667`, `MessageBubble.tsx:281-291,797-805` | Persisted `ending` and `TurnEndNotice` | S08F-05 | `rg -n "agent_error" apps/web/src` returns nothing |
| `composerRecallFromStop`, the composer refill after a Stop that lands before the provider starts: the record field, `recallCancelledUndispatchedMessage` and its `latestUserMessageContent` helper, the stop-time write, the `clearComposerRecallFromStop` action and the editor effect | `thread-record.ts:167`, `threadStore.ts:541,2831-2848,3583-3596,4322-4324`, `useComposerFormController.ts:290-296,816-826`, the two recall cases in `__tests__/thread-lifecycle.test.ts:356-416` | The quiet "Stopped before {Provider} started" ending (E6) | S08F-05 | `rg -n "composerRecallFromStop\|recallCancelledUndispatchedMessage" apps/web/src` returns nothing |
| Clearing queued input when a turn errors (`clearQueue` itself stays for Clear and thread deletion) | `threadStore.ts:2687-2688` in `handleErrorEvent` | A paused queue with an explicit send | S08F-05 | `bun run --cwd apps/web test -- src/__tests__/threadStore-ending-queue.test.ts` passes (new; an error, an interruption and a Mcode stop each keep the queue paused) |
| `agent.retry` (incident-scoped), `retryTurn`, `TurnRecoveryService.retry` and `consumeRecoveryIncidentEntry` | `methods.ts:1042-1046`, `agent-rpc.ts:39,128-135`, `transport/types.ts:414`, `ws-transport.ts:1216`, `turn-recovery-service.ts:90-117` | `turn.resume` and `turn.retry` | S08F-06 | `rg -n "\"agent.retry\"\|retryTurn\b" apps packages` returns nothing |
| `InterruptedSessionsBanner` with "Retry all", its test, client `recoveryIncidentStore`, `getRecoveryIncident`, `agent.recoveryIncident` | `components/chat/InterruptedSessionsBanner.tsx(.test.tsx)`, `features/recovery/state/recoveryIncidentStore.ts`, `App.tsx:23,402-442`, `ChatView.tsx:4,217-219,292-302,339-340`, `ChatViewSurface.tsx:13,351`, `ProjectTree.tsx:20,1462`, `methods.ts:1037-1041` | Per-thread Interrupted notice and the S01 Interrupted row (open question 5) | S08F-06 | `rg -n "InterruptedSessionsBanner\|recoveryIncidentStore\|agent.recoveryIncident" apps packages` returns nothing |
| `RetryBanner` and `hasRetryState` | `components/chat/RetryBanner.tsx`, `ComposerContentSurface.tsx:13,374`, `Composer.tsx:435-438` | `ProviderRetryLine`, and the S05 rate-limited indicator | S08F-09 | `rg -n "RetryBanner\|hasRetryState" apps/web/src` returns nothing |
| Devin quota and auth mapped to interrupted | `devin-provider.ts:122-123` | `Error` with `usage_limit` or `auth`, `Ended` errored | S08F-03 | `rg -n "quota_exhausted: \"interrupted\"\|auth_required: \"interrupted\"" packages` returns nothing |
| OpenCode silent `settle("errored")` (the `settle` name stays) | `opencode-provider.ts:858-859,1131` | Settle with the message and failure | S08F-04 | `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-provider.test.ts` passes with a case asserting the `Error` text and failure reach the server |

Not retired, deliberately:

- `TurnErrorPolicy`: the automatic-attempt gate.
- `classifyProviderError` (`apps/server/src/features/handoff/orchestration/error-classifier.ts:19-41`): handoff side-channel routing, a different domain. See Risks.
- `CliErrorBanner`: a missing CLI belongs to section 17.
- `startup-activity-shimmer`: still used by narrative rows.
- `AgentStopResult.dispatchState`: the server still uses it to skip the provider stop for an undispatched turn (`turn-runtime-controller.ts:1377`); only the client refill that read it goes (E6).

Owned in other ledgers, so they are not repeated here: the single-script setup launcher, the recovery shell (`openAutomaticSetupTerminal`), the gate-snapshot reads and `ProjectCommandApprovalDialog` belong to S12T-11 in the 12a ledger; visible "Errored" belongs to F-10 in the foundation ledger.

## Proposed tickets

Startup tickets are S04-NN and turn-ending tickets are S08F-NN. External dependencies: F-01 Paper token sync, F-02 fade truncation, F-03 button primitives, F-07 floating surface primitives, S01 thread row state model, S03 Start from origin, S03 new thread surface (760 composer, overview target rows), S05 work fold, S05 in-turn states, S05-10 queue rows, S06-00 and S06-01 fail-closed stops, S09 provider conditions (signed out with Sign in), S09 thread toasts, and S12T-11 (the startup-action switch, which converts this trail's setup step).

### S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind

- **Blocked by:** None (can start immediately).
- **Boards:** `04f · Thread starting · Step states · Dark` (`2BW7-2`), `04c` (`2AEY-2`), `04d` (`2AMW-2`)
- **Delivers:** Every startup record carries per-step `startedAt`/`endedAt`, a step `detail` (fetch ref or PR, worktree folder and path with created or opened, the setup exit code and skip reason), and raw `detail` on errors and blocks. PR starts get a real fetch step. Existing worktree starts use kind `attached-worktree`, but its setup phase stays skipped as `not-configured` until S04-07. The old card ignores the new fields, so users see no change yet.
- **Build notes:**
  - Contracts: section A.
  - Server:
    - `thread-startup-state-store.ts`: stamps times in `advance`, `complete`, `skip`, `fail`, `block`, `resume`, `cancel`, `markCancelled` and `interruptBatch`.
    - Coordinator: the kind choice at `:431-433`, PR fetch moved from `:283-286` into the `fetch` phase, worktree detail in `managedLifecycle` (`:410-421`) and `createStandaloneThread` (`:298-315`), and `failStartup` (`:474-484`) gaining `detail` from the thrown error. `finishBranchedStartup` (`:664-671`) skips the setup step for both worktree kinds, so a branch into an existing worktree keeps skipping setup.
    - Environment service: writes setup `exitCode` and `skipReason`, and passes block `detail` from `blockStartupSetup` (`:1491-1495`) as the transcript's last non-empty line. No script text goes into the record.
  - Contracts: the record's `steps` bound becomes 5.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] A managed worktree start records `thread, worktree, setup, agent` with increasing `startedAt` and with `endedAt` on finished steps.
  - [ ] A PR start records a `fetch` step with `pullRequestNumber` and `branch`.
  - [ ] An existing worktree start has kind `attached-worktree` and worktree detail `mode: "opened"`.
  - [ ] A branched start into an existing worktree records its setup step as skipped and dispatches its first turn.
  - [ ] A failed git fetch writes `error.detail` with the git stderr line, for example "fatal: Could not resolve host: github.com".
  - [ ] Retry setup resets the setup step's `startedAt` and clears `endedAt`.
  - [ ] Old records without the new fields still parse and replay.
- **Verify:** `bun run --cwd apps/server test -- src/features/thread-startup/__tests__/thread-startup-state-store.test.ts src/features/agents/turns/__tests__/thread-creation-startup.test.ts`; `bun run --cwd packages/contracts test -- src/__tests__/thread-startup.test.ts` (times on each transition, including the Retry setup reset; kinds, the fetch phase and error detail; the existing schema test gains step order with and without `fetch`, and old records without the new fields). Live: `bun run --shell system agent:up`, start a New worktree thread in `.dev/fixture-repo`, then read `thread.startup.get` over the authenticated WS (`.dev/ports.json` `seedLogin`) and confirm the times and details.

### S04-02 First provider frame: "Starting thread" holds until the provider answers

- **Blocked by:** S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind.
- **Boards:** `04f` states 3 and 4 (`2BW7-2`), `04e` (`2A7M-2`)
- **Delivers:** The startup's agent step stays "Starting thread" until the provider's first real frame. If the first turn ends before that frame, the startup becomes cancelled or failed with the failure text. Every canonical turn records `providerStartedAt`, which S08F uses for "Stopped before {Provider} started".
- **Build notes:**
  - Section B: the `turn.provider-started` event, the reducer, the `provider_started_at` migration, and the `PROVIDER_FRAME_EVENT_TYPES` constant on the server.
  - `StartupAgentPhaseObserver` registered in `apps/server/src/features/thread-startup/composition/register-thread-startup.ts`.
  - Remove the admission-time completion at `turn-runtime-controller.ts:2008-2012,2058` and delete `ThreadCreationCoordinator.completeInitialAgent`; the observer calls the startup service's `complete` directly.
  - Seam to test: committed canonical events in, then the startup state.
- **Deletes:** ledger row "Coordinator completing the startup at admission".
- **Acceptance criteria:**
  - [ ] The startup completes only after a text, tool or retry frame. A server `turnStarted`, an OpenCode early `turnStarted` or an MCP startup status does not complete it.
  - [ ] A first turn that errors before any frame leaves the startup `failed` with code `AGENT_START_FAILED` and `detail` holding the error text.
  - [ ] A turn that produced a frame has `providerStartedAt` set exactly once. A replayed duplicate is a no-op.
  - [ ] Existing turns read `providerStartedAt: null` without errors.
- **Verify:** `bun run --cwd packages/agent-model test -- src/__tests__/agent-model.test.ts`; `bun run --cwd apps/server test -- src/features/thread-startup/__tests__/startup-agent-phase-observer.test.ts src/features/agents/turns/__tests__/thread-creation-startup.test.ts`; `bun run --cwd packages/providers test -- src/conformance/__tests__/conformance.test.ts` (the reducer; the observer, new, with the fake startup service; the startup test seam; the conformance fixtures `opencode-core.synthetic.json` and `codex-core.captured.json`, asserting where the first frame falls). Live: start a Local thread in the fixture repo. The trail must show "Starting thread" with a ticking duration until the first streamed token.

### S04-03 Steps trail replaces StartupProgressCard and the preparing shell

- **Blocked by:** S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind; F-01b Token vocabulary rename; F-02 Fade truncation primitive.
- **Boards:** `04a` (`20U9-2`), `04b` (`29YX-2`), `04c` (`2AEY-2`), `04d` (`2AMW-2`), `04e` (`2A7M-2`), `04f` states 1 to 4 and 11 (`2BW7-2`)
- **Delivers:**
  - After first send, the user lands in the normal thread surface: canvas header, conversation column and docked composer. The bubble and the trail sit under each other.
  - Live steps show their argument and a ticking `m:ss` duration.
  - The setup step expands to the 04b output card with the script and the live tail. Open terminal calls `openAutomaticSetupTerminal` and opens that terminal in the right panel (S12T-11 later points it at the startup action's own terminal). Edit script opens Project settings.
  - After start, the trail collapses to "Started in 0:22 · mcode-3f2a · bun install" and can expand again.
  - The worktree step shows the folder name. Its tooltip shows the full path, and the overview Worktree row copies it (open question 8).
  - The PR review and fork dialogs render the same trail.
- **Build notes:**
  - New `StartupStepsTrail`, `StartupSetupOutput` and `startup-step-copy.ts`.
  - The preparing variant of the thread surface reuses the canvas header and composer dock. It renders `pendingStartup.queuedMessage` as the bubble until the durable thread arrives. Do not mount conversation-loading hooks for the client placeholder id (inferred reason the preparing shell exists).
  - The 04b header reads the setup script from the gate snapshot (`workspace.environment.automaticSetup.get`, `attempt.snapshot.script`), fetched when the setup step changes state and never on an interval. The record carries no script text. S12T-11 replaces this read with the projection in section E.
  - One `setInterval(1000)` per mounted trail runs only while a step is live, with text-only updates.
  - Reduced motion: no spinner rotation; use a static arc.
  - All values come from "Startup trail values" above.
- **Deletes:** ledger rows "StartupProgressCard", "Preparing shell", "startup-node-pop", and "Copy Preparing managed checkout".
- **Acceptance criteria:**
  - [ ] The 04a, 04c, 04d and 04e trails match Paper, with exact tokens per F-01.
  - [ ] The trail shows no "thread" phase row.
  - [ ] Pending rows have opacity 0.5. The live row is ink weight 500 with a primary arc.
  - [ ] The setup card is 560 wide with a 160px bottom-anchored tail and a 32px top fade. Command echo lines are ink.
  - [ ] The collapsed started row appears once the startup completes and persists after reload.
  - [ ] Opened worktree and skipped setup show no duration.
  - [ ] The PR review task dialog shows the trail, and `StartupProgressCard` is gone.
  - [ ] The thread surface does not jump when the placeholder thread becomes durable.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-startup/__tests__/StartupStepsTrail.test.tsx src/features/thread-startup/__tests__/startup-step-copy.test.ts` (both new: `StartupStepsTrail.test.tsx` replaces `StartupProgressCard.test.tsx` and renders fixture `ThreadStartup` records for each 04f state with RTL; `startup-step-copy.test.ts` tests `startup-step-copy.ts` as pure functions). Live: `agent:up --desktop`, then follow `.agents/skills/electorn-live-testing/SKILL.md`. In `.dev/fixture-repo` set setup to `bun install` and send from New worktree. Capture the trail mid-setup, expand the output, then capture after start, and compare with 04a and 04b.

### S04-04 Trail decisions and failures replace the in-chat setup card

- **Blocked by:** S04-03 Steps trail replaces StartupProgressCard and the preparing shell; S08F-05 End notice and Retry.
- **Boards:** `04f` states 5 to 10 (`2BW7-2`)
- **Delivers:**
  - Setup failed shows "exit 1 · 0:14", the error line, and Retry setup, Skip setup and Show output.
  - Setup needs approval shows the command, amber Run setup and Skip setup inline, with no dialog.
  - Fetch failed offers Retry and "Start from local {base}".
  - Worktree failed offers Retry and Edit message.
  - Thread didn't start offers Retry.
  - Cancelled offers Edit message and Keep thread.
  - The in-chat setup card and 1s polling are gone. Sidebar rows read startup state from the push.
- **Build notes:**
  - `useStartupActions` wires these calls, against the single-script executor until S12T-11 converts them (section E):
    - Retry setup and Skip setup use the existing `retryAutomaticSetup` and `continueAutomaticSetup` RPCs. These stay after the switch.
    - Run setup uses `approveWorkspaceEnvironmentCommand` with the approval fingerprint from the gate snapshot's `attempt.snapshot.approval`, read once when the approval block appears, as `ProjectAutomaticSetupControl.tsx:119-130` does today. `ThreadStartupBlock` carries no fingerprint.
    - Retry and Start from local base for creation failures use `retryPreparingThread` (`workspaceStore.ts:1535`) with the fetch dropped for the second. These are hidden after a reload, when the pending creation is gone.
    - Thread didn't start uses `turn.retry`.
  - `useThreadStartupRowState` feeds `ProjectTree.tsx:1451-1461`.
- **Deletes:** ledger rows "In-chat setup card", "useProjectAutomaticSetup", "SetupRecoveryActions ...", and "Visible copy Continue without setup ...".
- **Acceptance criteria:**
  - [ ] Each of 04f states 5 to 10 renders with Paper's detail line and actions, and each action reaches its server call.
  - [ ] No component polls `workspace.environment.automaticSetup.get` on an interval.
  - [ ] Approval needs no dialog.
  - [ ] After Edit message, the new-thread composer holds the original prompt with the same target.
  - [ ] After Keep thread, the trail shows "Cancelled" and the composer accepts a new message.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-startup/__tests__/StartupStepsTrail.test.tsx src/features/thread-startup/__tests__/useStartupActions.test.tsx`; `bun run --cwd apps/server test -- src/features/projects/environment/__tests__/workspace-environment-automatic-setup.test.ts` (the trail's actions for each state; `useStartupActions`, new, with a mock transport, prior art `src/features/projects/environment/__tests__/ProjectAutomaticSetupControl.test.tsx`; the server test for block `detail`). Live: set the fixture setup to `bun install && exit 1` and confirm Setup failed, then Skip setup, then the agent starts. Switch storage to Shared to see Needs approval, then Run setup. Stop during setup to see Cancelled, then Edit message.

### S04-05 Startup composer: no queueing, Stop and Esc cancel startup

- **Blocked by:** S04-02 First provider frame: "Starting thread" holds until the provider answers; S04-03 Steps trail replaces StartupProgressCard and the preparing shell.
- **Boards:** `04a` (`20U9-2`) composer, `04f` state 10 (`2BW7-2`)
- **Delivers:**
  - While a startup is nonterminal, the composer shows the dimmed "Do anything" (opacity 0.5), an inert editor, no Send, a spinner and Stop.
  - Stop, or Esc when the thread view has focus and no overlay is open, cancels the startup in any phase. In the agent phase that includes the dispatched first turn.
- **Build notes:**
  - Section C server changes in `thread-startup-rpc.ts:37-48` and a `stopSession` call for the agent phase.
  - Web: a composer state `startingThread` replaces `setupBlocked`. The Esc handler must not fire while branch mode (`Composer.tsx:622`), a popover or a dialog is open.
- **Deletes:** ledger rows "`setupBlocked` prop ..." and "Queued-turn cancel and the client stop for automatic setup".
- **Acceptance criteria:**
  - [ ] Typing is impossible during startup, and no `agent.send` can be issued.
  - [ ] Stop during fetch, worktree, setup or agent ends in trail state 10 within 2s.
  - [ ] A cancel in the agent phase before the first frame stops the provider process: the runtime snapshot goes idle and no output arrives later.
  - [ ] A second cancel is harmless.
  - [ ] Esc in an open model picker closes the picker only.
- **Verify:** `bun run --cwd apps/server test -- src/features/thread-startup/transport/__tests__/thread-startup-rpc.test.ts`; `bun run --cwd apps/web test -- src/features/conversation/composer/ComposerContentSurface.send-button.test.ts src/features/conversation/composer/__tests__/Composer.starting-thread.test.tsx` (the cancel matrix in the existing RPC test, for every phase and a second cancel; the send-button test's `setupBlocked` cases become the starting state, with no Send and a Stop; the new composer test proves the inert editor, that no `agent.send` is issued, Esc cancelling startup, and Esc in an open model picker closing only the picker). Live: send from New worktree, press Esc during setup and confirm Cancelled. Repeat on a Local thread right after send.

### S04-06 Start from origin: fetch step

- **Blocked by:** S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind; S04-03 Steps trail replaces StartupProgressCard and the preparing shell; S03-08 Start from origin.
- **Boards:** `04a` (`20U9-2`), `04f` states 1 and 7 (`2BW7-2`)
- **Delivers:** With Start from origin on, the trail shows "Fetching origin/main", then "Fetched origin/main 0:01" before Create worktree. On failure it shows Retry and "Start from local main".
- **Build notes:** S03 adds the request flag and the safe fetch behavior. `git.fetchBranch` refuses a checked-out main today (implementation notes), so S03 owns the fix. This ticket passes `fetch: { ref: "origin/<base>" }` into `startup.start`, runs the fetch inside the `fetch` phase, and records the detail.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] The fetch step appears only when the flag is on.
  - [ ] The worktree is created from the fetched ref.
  - [ ] With the network unreachable, the step shows Fetch failed with the git line, and "Start from local main" restarts without the fetch step.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/thread-creation-startup.test.ts` (with a fake `fetchBranch` that resolves or rejects). Live: turn on Start from origin in the branch picker in the fixture repo and send. For the failure case, point `origin` of `.dev/fixture-repo` at an unreachable URL; only that worktree-local repo is touched.

### S04-07 Existing worktree runs setup, skipped while a thread is live there

- **Blocked by:** S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind; S04-04 Trail decisions and failures replace the in-chat setup card.
- **Boards:** `04d · Thread starting · Existing worktree · Dark` (`2AMW-2`), `04f` state 11 (`2BW7-2`)
- **Delivers:** Starting a thread in an existing worktree shows "Opened worktree mcode-9c1d" and runs setup. If another thread in that worktree is running, or is itself starting, setup shows "Skipped setup · thread running here" and the thread starts right away. A thread that continues another thread in the same checkout (a branch today, Implement in a new thread once S07-08 lands) skips setup without waiting.
- **Build notes:** Section D, which holds the one Setup rule S07-08 also follows. The eligibility change touches `workspace-environment-service.ts:1147-1164` and `turn-admission-dispatch-coordinator.ts:348`. Add the occupancy check with per-path serialization. Keep the coordinator's continuation skip ahead of the gate for branched starts; S07-08 adds the Implement case and its `plan-implement` reason. Rewrite the setup gate text in `docs/internals/projects/environment.md`, including both skips. This runs on the single-script executor; S12T-11 swaps the executor later and must keep this eligibility and both skips.
- **Deletes:** none (the behavior change and the docs rewrite).
- **Acceptance criteria:**
  - [ ] An attached-worktree thread queues its first prompt behind setup, exactly as a managed worktree does.
  - [ ] A running sibling turn produces `skipReason: "thread-running-here"` with no setup process launched.
  - [ ] Two starts in the same worktree run setup at most once.
  - [ ] A branched start into an existing worktree never calls `admitInitialAutomaticTurn` and its first turn is dispatched, not queued.
  - [ ] Stop during an attached worktree's setup cancels the startup, and the worktree is never removed.
  - [ ] Cleanup of attached worktrees is unchanged: the worktree is never removed.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/environment/__tests__/workspace-environment-automatic-setup.test.ts src/features/agents/turns/__tests__/thread-creation-startup.test.ts` (the first covers an attached thread, a busy sibling and two starts in one worktree; the second covers the branched skip into an attached worktree). Live: in the fixture repo, start thread A in New worktree and let it run a long turn. Start thread B in Existing worktree on A's worktree and confirm Skipped setup. After A finishes, start thread C there and confirm setup runs.

### S04-08 Setup step runs startup actions (the switch) (merged)

- **Blocked by:** Not a ticket. Merged into S12T-11: one atomic switch makes the S12 action runner the only startup executor and converts the trail to read it.

### S04-09 First send motion

- **Blocked by:** S04-03 Steps trail replaces StartupProgressCard and the preparing shell; S03-03 New-thread start column.
- **Boards:** `04g · Thread starting · First send motion · Dark` (`2CQU-2`)
- **Delivers:** On first send, the composer slides to its dock while the heading fades, the new sidebar row fades in as the other rows shift, and then the message and the steps rise in. All timing follows the 04g table. Reduced motion docks the composer instantly and fades the message and steps over 120ms. The send happens before any motion.
- **Build notes:**
  - `recordFirstSend()` runs after the send is dispatched. It stores the composer top and a `cloneNode(true)` of the heading and hint, keyed by the placeholder thread id. Records older than 1s are ignored.
  - The docked composer's `useLayoutEffect` reads the record and runs `element.animate` with `translateY(dy)` going to `translateY(0)`, 240ms, `cubic-bezier(.2,0,0,1)`. It animates transform only, and needs no new library because WAAPI is enough.
  - The heading clone is fixed at its old rect and fades out over 120ms, then is removed.
  - Message: opacity plus `translateY(8px)`, 180ms, 120ms delay, `fill: backwards`. Steps: the same with a 240ms delay.
  - The new sidebar row fades in over 180ms, and sibling rows FLIP over 180ms. The sidebar list is S01's, so add only a hook.
  - The overview swap is instant (S03 overview target rows).
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] A recorded performance trace shows only transform and opacity animating, with no layout during the 240ms.
  - [ ] Timings match 04g within one frame.
  - [ ] Under reduced motion, nothing translates.
  - [ ] Pressing Enter twice quickly sends once.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-startup/__tests__/first-send-motion.test.ts` (new: record expiry and the reduced-motion branch). Live: Electron harness screen recording at 60fps of a first send (before and after), plus a DevTools performance capture attached to the PR.

### S08F-01 Turn failure and ending on the wire

- **Blocked by:** S01-03 Thread attention facts on the server.
- **Boards:** `08f` (`2C3A-2`)
- **Delivers:** Every provider error carries `failure: TurnFailure`, and every terminal turn persists its cause. Cancelled turns record who stopped them (the user, or Mcode with a reason), interrupted turns have a `cause`, and errored turns have a persisted failure with raw message, status, reset time and retries. Users see no change yet. The data survives reload.
- **Build notes:**
  - Sections F and G.
  - Make `failure` required, and update every `Error` emit site and thrown dispatch error to at least `{ kind: "fatal" }`. The typechecker lists them.
  - Server enrichment: provider, `resetsAt`, retries from the last `ApiRetry`.
  - `failWorkerDispatch` reads `ProviderTurnError.failure`.
  - Stop cause: `stopSession` takes a required `TurnStopCause`; update every caller per the section G table. If S06-00 or S06-01 has landed, its fail-closed stop passes `approval_unanswerable`; if not, that ticket passes it when it lands.
  - The canonical writer writes `stop`, `failure` and `cause`. The reducer fills `ending`.
  - Migration for `canonical_agent_turns.ending_json`.
  - Cause sources follow section G.
- **Deletes:** ledger row "`Error` events without `failure`".
- **Acceptance criteria:**
  - [ ] `bun run typecheck` passes with `failure` and the stop cause required.
  - [ ] An `Error` with `retryAfterMs` persists an absolute `resetsAt`.
  - [ ] A restart-interrupted turn has cause `app_closed`.
  - [ ] Codex `provider_lost` gives `provider_exited`.
  - [ ] A user Stop persists `stop: { by: "user" }`; a stop through the approval fail-closed path persists `{ by: "mcode", reason: "approval_unanswerable" }`; when a user stop and a Mcode stop race, the first cause wins.
  - [ ] An old `turn.cancelled` envelope replays as a user stop, and an old `turn.errored` envelope replays as `fatal` with its message.
  - [ ] An ending of up to 8,000 characters round-trips through the conversation page to the web replica.
- **Verify:** `bun run --cwd packages/contracts test -- src/events/__tests__/agent-event.test.ts`; `bun run --cwd packages/agent-model test -- src/__tests__/agent-model.test.ts`; `bun run --cwd apps/server test -- src/features/agents/recovery/__tests__/turn-recovery-service.test.ts` (the required `failure`; the reducer's legacy path; the interruption cause). Live: run a turn, then `agent:down` and `agent:up` mid-turn, and inspect the canonical turn's `ending` over WS.

### S08F-02 Classify Claude and Codex failures

- **Blocked by:** S08F-01 Turn failure and ending on the wire.
- **Boards:** `08f` failed states (`2C3A-2`)
- **Delivers:** Claude and Codex errors arrive as retryable, usage_limit (with reset and window), auth or fatal, carrying status and retries. Claude rate-limit warnings stop looking like hard limits.
- **Build notes:** Section I rows Claude and Codex. Add pure classifiers `claude-failure-classifier.ts` and `codex-failure-classifier.ts`. Claude reads the assistant `error`, result `subtype`, `terminal_reason`, `api_error_status`, and the last `rate_limit_event`. Codex reads `codexErrorInfo` and keeps the latest rate-limit reset in turn state. Verify SDK and protocol field names against the installed packages before coding; they are marked inferred.
- **Deletes:** none (behavior fixes: Codex `codexErrorInfo` drop, Claude warning conflation).
- **Acceptance criteria:**
  - [ ] Each classifier maps every listed native shape to the kind in section I.
  - [ ] `usageLimitExceeded` gives `usage_limit` with `retryAfterMs`.
  - [ ] Claude `authentication_failed` gives `auth`.
  - [ ] A Claude `allowed_warning` does not set `RateLimited.active`.
- **Verify:** `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-event-mapper.test.ts src/__tests__/codex/codex-event-mapper.test.ts src/conformance/__tests__/conformance.test.ts` (the Codex test's `codexErrorInfo` fixture near `:3439`; the conformance fixture `claude-startup-error.captured.json`, which must give `auth`). Live: a Codex turn with an invalid model id (set through thread settings) shows Failed with Details.

### S08F-03 Classify Cursor and Devin failures (ACP)

- **Blocked by:** S08F-01 Turn failure and ending on the wire.
- **Boards:** `08f` (`2C3A-2`)
- **Delivers:** Cursor and Devin errors arrive classified. Devin quota and sign-out stops become Failed with a usage-limit or signed-out notice instead of Interrupted. Cursor's internal retry shows as a provider retrying line.
- **Build notes:** Section I rows Cursor and Devin. Keep ACP `RequestError.code` and `.data` through `cursor-session-recovery-error.ts:7-12`. Change Devin `STOP_OUTCOMES` (`devin-provider.ts:119-130`) for `quota_exhausted`, `auth_required` and `content_filter` to emit `Error` with failure plus `Ended` errored. Cursor's retry loop emits `ApiRetry`.
- **Deletes:** ledger row "Devin quota and auth mapped to interrupted".
- **Acceptance criteria:**
  - [ ] Devin `quota_exhausted` gives an errored turn with `usage_limit`.
  - [ ] Devin `auth_required` gives `auth`.
  - [ ] Cursor `-32000` gives `auth`.
  - [ ] A Cursor 429 retry emits `ApiRetry` with attempt and delay.
- **Verify:** `bun run --cwd packages/providers test -- src/private/devin/__tests__/devin-provider.test.ts src/private/devin/__tests__/devin-acp-event-mapper.test.ts src/private/cursor/__tests__/cursor-session-continuity.test.ts src/conformance/__tests__/conformance.test.ts` (the last with the conformance fixture `cursor-core.captured.json`). Live: none; there is no safe way to exhaust quota.

### S08F-04 Classify Copilot and OpenCode failures, and fix OpenCode's lost errors

- **Blocked by:** S08F-01 Turn failure and ending on the wire.
- **Boards:** `08f` (`2C3A-2`)
- **Delivers:** Copilot and OpenCode errors arrive classified. OpenCode failures finally show their real message instead of an empty Failed.
- **Build notes:** Section I rows Copilot and OpenCode. Fix `opencode-provider.ts:858-859,1131` so `settle` carries the mapped error's text and failure. Map OpenCode `session.status` retry to `ApiRetry` (verify the fields).
- **Deletes:** ledger row "OpenCode silent settle".
- **Acceptance criteria:**
  - [ ] An OpenCode `session.error` with `ProviderAuthError` gives an errored turn with `auth` and the native message.
  - [ ] A Copilot `errorType: "quota"` gives `usage_limit`.
  - [ ] A Copilot `statusCode: 503` gives `retryable` with status 503.
- **Verify:** `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-provider.test.ts`; `bun run --cwd packages/providers test -- src/private/copilot/__tests__/copilot-event-mapper.test.ts src/conformance/__tests__/conformance.test.ts` (a new failing-path OpenCode case; the Copilot mapper test for `session.error` (`copilot-event-mapper.ts:115`), which this ticket creates unless S05-07 has already added it; the conformance fixtures `copilot-core.captured.json` and `opencode-core.synthetic.json`).

### S08F-05 End notice and Retry

- **Blocked by:** S08F-01 Turn failure and ending on the wire; S04-02 First provider frame: "Starting thread" holds until the provider answers; S08-01 Finished turn layout: work fold, merged meta line, actions row; F-03 Button primitives; F-10 Status marks, spinner, badges and notices; S05-10 Queue rows in the tray: Send now, Edit, Remove; S10-03 Truthful comparison outcomes and turn list.
- **Reconciled:** Also owns queue retention: an error or ending never silently clears queued user input. The queue pauses visibly with an explicit send action.
- **Boards:** `08f` states Stopped by you, Stopped before the provider started, Failed · can retry, Failed · details open (`2C3A-2`)
- **Delivers:**
  - Turns the user stopped end with a quiet "You stopped", or "Stopped before Codex started" with no work fold. A Stop before the provider started never refills the composer (E6).
  - Turns Mcode stopped end with a quiet "Stopped by Mcode" (for example after an approval it could not answer) or "Stopped by another thread", never "You stopped".
  - Failed turns end with the filled notice: cause, status line, Details that expands the raw error with Copy, and Retry.
  - Retry sends the same prompt as a new attempt of the same turn on the same session. The new attempt replaces the failed one in the transcript: the user message shows once, then the latest attempt, with no "Retried" receipt (E2). The failed attempt's records stay.
  - The work fold reads "Stopped after 48s" or "Failed after 1m 02s".
  - Queued follow-ups survive any ending that is not a completion. The queue shows "Paused" and waits for an explicit send.
- **Build notes:**
  - Section J table and `TurnEndNotice`. The `turn.retry` server path is section H. The cancelled rows read `ending.stop` (section G).
  - Section K queue rule in `threadStore.ts`, plus the "Paused" label in the queue component that exists when this lands (`ComposerQueueList` today; S05-10's tray rows keep it).
  - Attempts (section H): the transcript projection renders a logical turn as its first user message plus its latest attempt, reading `AgentTurn.attemptOf` from S10-03. `turn.retry` passes `retryOfExecutionId`, from which the start derives the link. No receipt.
  - Delete `composerRecallFromStop` and the refill (ledger row, E6). Stop before the first frame ends in the quiet "Stopped before {Provider} started" ending only.
  - The startup turn's ending is suppressed while the trail owns it.
  - Update the CONTEXT.md Turn outcome and Replacement turn entries; Turn outcome names who can stop a turn, and Replacement turn says it is a new attempt of the same turn that replaces the old one in the transcript.
- **Deletes:** ledger rows "`TurnFooter` outcome labels", "Client-only `agent_error`", "`composerRecallFromStop`" and "Clearing queued input when a turn errors".
- **Acceptance criteria:**
  - [ ] Every row of the section J table for cancelled and errored has a passing table test, including both Mcode stop reasons.
  - [ ] A turn stopped through the approval fail-closed path shows "Stopped by Mcode", not "You stopped", and keeps that after reload.
  - [ ] Details shows the exact persisted message and copies it.
  - [ ] Retry on the latest errored attempt starts a new attempt with the same content and attachments, and `attemptOf` set to the first attempt's turn id.
  - [ ] After Retry the transcript shows the user message once and only the new attempt: no copy of the message, no "Retried" text, and none of the failed attempt's work fold, partial answer, changes bar or notice. The failed attempt's turn, messages and ending are still in the canonical store, and reloading shows the same transcript.
  - [ ] If the new attempt fails too, its own Failed notice shows with Retry; a second Retry on the same attempt returns a conflict.
  - [ ] Retry is hidden on an attempt that is not the latest.
  - [ ] Stop before the provider's first frame leaves the composer empty (or holding whatever the user typed since) and shows "Stopped before {Provider} started" under the user message.
  - [ ] Reloading keeps the notice.
  - [ ] With two queued messages, an error, an interruption, a user Stop and a Mcode stop each leave both messages queued, auto-drain off and "Paused" visible.
  - [ ] A transport reconnect after an error keeps the paused queue.
  - [ ] Send now on the first queued row sends it and resumes auto-drain; Retry and Resume leave the queue paused.
  - [ ] A completed turn still drains the queue as today.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn-ending/__tests__/turn-ending-notice.test.ts src/features/conversation/turn-ending/__tests__/TurnEndNotice.test.tsx src/__tests__/threadStore-ending-queue.test.ts src/__tests__/virtual-items.test.ts src/__tests__/thread-lifecycle.test.ts`; `bun run --cwd apps/server test -- src/features/agents/recovery/__tests__/turn-recovery-service.test.ts` (new: the section J table, the notice, and the queue rule; existing: the attempt fold in the transcript, the two recall cases rewritten to assert no refill, and on the server the retry preconditions, the new attempt's `attemptOf` and the per-attempt `consumeRetry` conflict. Prior art for the queue: `threadStore-reconnect-queue.test.ts`, `queueStore.test.ts`, `ComposerQueueList.lifecycle.test.tsx`; for the notice: `TurnFooter.test.tsx`, `PersistedNarrative.thread.test.tsx`). Live: in the fixture repo, Stop mid-turn and confirm "You stopped". Stop within the first second of a send and confirm "Stopped before {Provider} started" and an empty composer. Queue a follow-up during a turn, force a fatal (invalid model), confirm Failed with the follow-up still queued and "Paused", then Retry after fixing the model: the message shows once and the failed attempt's notice is gone. Send the follow-up with Send now.

### S08F-06 Resume interrupted turns

- **Blocked by:** S08F-05 End notice and Retry; S01-04 Thread row state model and the three-line row.
- **Boards:** `08f` Interrupted (`2C3A-2`) and the sidebar rows
- **Delivers:** Interrupted turns show the amber notice with the cause and Resume. Resume continues the provider's own session where it can. Otherwise it starts a new session seeded with the thread. The cross-thread restart banner is gone; the sidebar carries Interrupted (S01).
- **Build notes:**
  - Section H `turn.resume`, and the `session-resume` capability declared by each adapter (all six support a native session resume today, per section I).
  - `TurnRequest.resumeRequired` and `SessionResumeUnavailableError` in each adapter, per the section I resume column.
  - Seeded fallback through the handoff path D builder.
  - Both Resume paths start a new attempt with `retryOfExecutionId`, so it carries `attemptOf` (section H, Attempts) and replaces the interrupted one in the transcript. No "Resumed" receipt (E2).
  - Update the CONTEXT.md Recovery incident entry.
- **Deletes:** ledger rows "agent.retry ..." and "InterruptedSessionsBanner ...".
- **Acceptance criteria:**
  - [ ] Resume after `agent:down`/`agent:up` on Codex continues the same native thread, and the result is `native-session`.
  - [ ] After Resume, on either path, the transcript shows the user message once and only the resumed attempt; the hidden continuation message and the interrupted attempt's notice do not render, and the interrupted attempt's records remain.
  - [ ] When the native session is gone, the result is `seeded-session`, the provider receives the handoff, and nothing restarts fresh silently.
  - [ ] Every adapter, given `resumeRequired`, throws instead of starting fresh (one unit test per adapter).
  - [ ] `ProjectTree` no longer reads a recovery incident store.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/recovery/__tests__/turn-recovery-service.test.ts src/features/providers/adapters/opencode/__tests__/opencode-provider-resume.test.ts`; `bun run --cwd packages/providers test -- src/__tests__/claude-factory.test.ts src/__tests__/codex/codex-app-server-handshake.test.ts src/private/cursor/__tests__/cursor-session-continuity.test.ts src/private/copilot/__tests__/copilot-factory.test.ts src/private/devin/__tests__/devin-provider.test.ts`; `bun run --cwd apps/web test -- src/__tests__/virtual-items.test.ts` (path choice and fallback; one `resumeRequired` case per adapter, each in the file that already tests that adapter's resume: Claude `resume`, Codex `thread/resume` and its fallback to `thread/start`, Cursor session continuity, Copilot durable resume, Devin `session/load`, OpenCode `resumeFrom`; the resumed attempt replaces the interrupted one in the transcript, and the hidden continuation message does not render). Live: start a long Codex turn in the fixture repo, run `agent:down` and `agent:up`, confirm the Interrupted notice, Resume, and continued output.

### S08F-07 Usage limit: Retry at reset and Switch model

- **Blocked by:** S08F-05 End notice and Retry; S08F-02 Classify Claude and Codex failures; F-04b Picker primitive; F-04c Migrate the model picker and file editor picker to the picker primitive.
- **Boards:** `08f` Failed · usage limit (`2C3A-2`)
- **Delivers:**
  - A usage-limit failure shows the window and reset time.
  - "Retry at 16:00" schedules the retry. The notice then reads "Retrying at 16:00" with Cancel retry, and survives reload and restart.
  - Switch model opens the model picker. Picking a model retries now with that model.
- **Build notes:** Section H scheduler, table and push channel. `ThreadSchema.scheduled_retry`. Switch model reuses the composer's model picker, as migrated to the F-04b picker in F-04c, and calls `turn.retry` with `model`. Same-provider models only (open question 3).
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] The schedule fires within 5s of `at`.
  - [ ] Any new send on the thread clears it.
  - [ ] Cancel retry clears it everywhere.
  - [ ] A schedule overdue by more than 15 minutes at boot is dropped, and the notice shows Retry.
  - [ ] A thread delete removes its schedule.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/recovery/__tests__/turn-retry-scheduler.test.ts`; `bun run --cwd apps/web test -- src/features/conversation/turn-ending/__tests__/turn-ending-notice.test.ts` (the scheduler test is new and uses a fake clock, prior art `src/features/thread-control/lifecycle/__tests__/thread-completion-service.test.ts`; the notice table gains the scheduled states: Retry at the reset time, Retrying at with Cancel retry, and an overdue schedule that falls back to Retry). Live: call `turn.retry.schedule` over WS with `at` one minute ahead on a failed fixture turn, then watch it fire.

### S08F-08 Signed out: Sign in, then Retry

- **Blocked by:** S08F-05 End notice and Retry; S09-04 Provider status contract and the bell.
- **Boards:** `08f` Failed · signed out (`2C3A-2`)
- **Delivers:** An auth failure shows "{Provider} is signed out" with Sign in. That is the same action as the bell's Providers row. When the provider's signed-out condition clears, the button becomes Retry.
- **Build notes:** The notice subscribes to S09's provider condition for `failure.provider`. An auth failure notifies S09 so it re-checks that provider (the S09 interface is named there).
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] Sign in invokes S09's action.
  - [ ] When the condition clears, the primary changes to Retry without a reload.
  - [ ] An auth failure whose condition is already clear shows Retry.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn-ending/__tests__/TurnEndNotice.test.tsx` (the signed-out notice with a mocked condition store). Live: none; signing out would touch global CLI config, which AGENTS.md forbids.

### S08F-09 Provider retrying line replaces RetryBanner

- **Blocked by:** S08F-01 Turn failure and ending on the wire; S08-01 Finished turn layout: work fold, merged meta line, actions row; S05-03 In-turn state signals per adapter.
- **Boards:** `08f` Provider retrying · still running (`2C3A-2`), `05f` state 7 (`2CQL-2`)
- **Delivers:** While the provider retries, a quiet line under the work reads "Codex is retrying", then "502 Bad Gateway · attempt 2 of 10 · next in 8s" with a countdown. It clears when output resumes. Rate-limited waiting shows in the section 05 indicator. The composer banner is gone.
- **Build notes:** Keep `errorStatus` in `threadStore.ts:2619-2622`. Use a status phrase table. The existing clear-on-next-event logic stays (`agent-event-preflight.ts:132-133`). The countdown uses one 1s timer.
- **Deletes:** ledger row "RetryBanner and hasRetryState".
- **Acceptance criteria:**
  - [ ] Unknown parts are omitted, never shown as "undefined".
  - [ ] The line clears on the next non-retry event.
  - [ ] If retries run out, the S08F-05 Failed notice replaces the line.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn-ending/__tests__/ProviderRetryLine.test.tsx`; `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-event-mapper.test.ts` (the line test is new; the mapper test gains an `api_retry` case). Live: none reliable. No test or conformance fixture covers `api_retry` today, so the new mapper case is the provider proof.

### S08F-10 Rename "Errored" to "Failed" (merged)

- **Blocked by:** Not a ticket. Merged into F-10 (F-10 renames every visible "Errored" to "Failed").

## Tests

- **Highest seams**
  - The startup state store and coordinator: records in, transitions out.
  - The canonical reducer: events in, `AgentTurn` out.
  - The section J table: a pure function.
  - The section K queue rule: agent events into `threadStore`, queue state out.
  - The recovery service, with a fake dispatcher.
  - Adapter classifiers: native shape in, `TurnFailure` out, no I/O.
  - The startup-action projection (section E) is tested in S12T-11: `StartupStepsTrail.test.tsx` with fixture entries and runs, and the runner tests listed in 12a.
- **Prior art, server**
  - `apps/server/src/features/thread-startup/__tests__/thread-startup-state-store.test.ts`, `thread-startup-service.test.ts`
  - `apps/server/src/features/agents/turns/__tests__/thread-creation-startup.test.ts`, `turn-error-policy.test.ts`
  - `apps/server/src/features/projects/environment/__tests__/workspace-environment-automatic-setup.test.ts`
  - `apps/server/src/features/agents/recovery/__tests__/turn-recovery-service.test.ts`
- **Prior art, providers**
  - `packages/providers/src/conformance/__tests__/conformance.test.ts` with `conformance/fixtures/*.json`
  - `packages/providers/src/private/claude/__tests__/claude-event-mapper.test.ts`
  - `packages/providers/src/__tests__/codex/codex-event-mapper.test.ts`
  - `packages/providers/src/private/devin/__tests__/devin-provider.test.ts`
  - `packages/providers/src/private/cursor/__tests__/cursor-session-continuity.test.ts`
  - `packages/providers/src/private/copilot/__tests__/`
  - `apps/server/src/features/providers/adapters/opencode/__tests__/opencode-provider.test.ts`
- **Prior art, web**
  - `apps/web/src/features/thread-startup/__tests__/StartupProgressCard.test.tsx` (to be replaced)
  - `apps/web/src/features/conversation/narrative/__tests__/TurnFooter.test.tsx`, `PersistedNarrative.thread.test.tsx`, `NarrativeIndicator.test.tsx`
  - `apps/web/src/features/projects/environment/__tests__/ProjectAutomaticSetupControl.test.tsx`
  - `apps/web/src/components/chat/InterruptedSessionsBanner.test.tsx` (deleted)
  - `apps/web/src/__tests__/threadStore-reconnect-queue.test.ts`, `apps/web/src/__tests__/queueStore.test.ts`, `apps/web/src/components/chat/__tests__/ComposerQueueList.lifecycle.test.tsx` (queue)
- **Run** with `bun run --cwd <workspace> test -- <file>` per workspace, never `bun test`. Run targeted `bun run lint` and `bun run typecheck`.
- **Fixtures**: only `.dev/fixture-repo`. Failing setup: `bun install && exit 1`. Unreachable fetch: change `origin` of the fixture repo only. Interrupted: `agent:down` then `agent:up` mid-turn. Fatal failure: an invalid model id in thread settings.
- **Live UI**: `.agents/skills/electorn-live-testing/SKILL.md`. Before and after captures go in the PR body (local `.dev/` paths are not evidence).

## Risks and open questions

Product calls for the user:

1. **Fatal failures.** Should the notice show Retry? Recommended yes: Details plus Retry. The user may have fixed the cause outside Mcode, and the alternative forces retyping. The board draws only retryable, usage limit and signed out.
2. **Replacement turn in the transcript.** Decided (user, 2026-10-08, E2): neither a repeated bubble nor a receipt. The new attempt replaces the failed or interrupted one: the user message shows once, then the latest attempt only. Every attempt's records are kept, and Review treats the attempts as one turn (section H, Attempts). Paper does not draw the post-Retry state.
3. **Switch model scope.** Cross-provider switch is not implemented on the server (`rg -i "switch.?provider" apps/server/src` finds nothing), so Switch model can offer only the same provider's models. Usage limits such as Claude's 5-hour window are often account-wide, so a same-provider switch may not help. Options: keep the button, limited to the same provider; hide it until cross-provider switch exists; or build cross-provider switch first. Recommended: keep it, same provider.
4. **Overdue scheduled retry.** If Mcode was closed at the reset time, should the retry fire on the next launch? Recommended: fire if overdue by 15 minutes or less, otherwise drop it and show Retry. The ADR-0022 spirit argues against surprise replays hours later.
5. **The restart banner.** Retire `InterruptedSessionsBanner` and its "Retry all" in favor of per-thread Resume and amber sidebar rows? Recommended yes. Section 17 (interrupted sessions) is not designed, and can add a bulk action if wanted.
6. **`composerRecallFromStop`.** Decided (user, 2026-10-08, E6): delete it and its refill. A Stop before the provider starts ends in the quiet "Stopped before {Provider} started" ending only (S08F-05 ledger row).
7. **"412 packages".** 04f state 2 shows "bun install · 412 packages" while 04a and 04b show "bun install". Is the live progress tail intended? No generic source exists, so the recommendation is to drop it.
8. **Worktree copy.** The decision says the startup step shows the folder name and "a copy button copies the full path". Only the overview Worktree row on 04a draws a copy icon. Recommended: the copy lives in the overview row, and the step shows a full-path tooltip. Add a hover copy to the step only if wanted.
9. **Section 12 copy.** Decided (T10): the Run on startup hint reads "When a thread starts in a worktree"; S12T-13 uses it.
10. **Devin `tool_rejected`.** It still maps to interrupted. It is likely a user denial, which reads better as stopped. Needs a Devin trace to decide (Devin owner).
11. **Mcode stop copy** (designer). "Stopped by Mcode" with "Mcode couldn't answer an approval request", and "Stopped by another thread", are not drawn. They reuse the quiet "You stopped" style with no action. S06's receipt names the request that failed.
12. **Startup readiness, T3** (user). S12T-11 awaits each startup action until it exits 0, so a dev server or watcher marked Run on startup holds the first turn until Skip setup. Whether a "Keeps running" toggle follows as its own ticket is decision T3 (12a Risks).
13. **Setup for Implement in a new thread.** The new thread continues its source in the same checkout, so it skips Setup like a branched thread (section D), even though no other thread is live there. Decided (user, 2026-10-08, E9): skip, with reason `plan-implement`. A user who wants Setup picks "Implement vN in a new worktree" (S07-08b), which runs Setup and holds the request and the source thread's reservation for as long as Setup takes.

Facts to check while building:

- **Native field names marked inferred**: Codex `codexErrorInfo` variants, Copilot `session.error.data.errorType`, OpenCode `APIError` and retry status, and Claude SDK error fields. Confirm against installed packages with `bunx --no-install opensrc path <pkg>` or `node_modules`.
- **Same-thread handoff seed**: `HandoffCoordinator` targets child threads (`handoff-coordinator.ts:182-230`). S08F-06 may need a same-thread entry point. Check before sizing.
- **Placeholder surface**: rendering the normal thread surface for a client placeholder id may trigger conversation loading for a non-durable id. S04-03 keeps a preparing variant of the conversation for that reason (inferred).
- **Occupancy race**: two simultaneous starts in one existing worktree need per-path serialization in the environment service. Without it, both may run setup.
- **Two classifiers**: `classifyProviderError` (handoff) and the new adapter classifiers overlap in vocabulary (quota and auth versus usage_limit and auth). Converge only if the handoff ladder can consume `TurnFailure` (follow-up, tech lead).
- **Migrations**: S04-02, S08F-01 and S08F-07 each add Drizzle migrations (S10-03 adds `attempt_of`). Regenerate on rebase to avoid number clashes (`apps/server/drizzle/`, currently at 0068).
- **Owned elsewhere**: `CliErrorBanner` and `ProviderUnavailable` (missing or disabled CLI) are not turn endings in this design. Section 17 owns them.
- **Queue landing order**: S08F-05 adds the "Paused" label to whichever queue component exists when it lands. If S05-10 lands later, its tray rows must keep the label and the explicit send.
- **Thread-control stops**: the `thread_control` stop reason assumes `ThreadControlService.stopTarget` runs when one thread stops another through thread control (inferred from its name and its `interrupted` status write, `thread-control-service.ts:1767-1770`). Confirm the source before writing the notice copy.
