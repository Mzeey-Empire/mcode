# 07 · Plan mode: build brief

When this ships, Plan mode works the same way for all six providers. The user turns Plan on (chip, `/plan`, or `/plan ` inline). The agent asks its questions in a dock that replaces the composer, then writes a plan. The plan appears as a row in the thread overview, never as prose in the chat. The user reviews it in the Plan panel, edits it in place (the first change creates a version marked "Edited by you"), and comments on highlighted text. Follow-ups revise the plan. Implement sends exactly the version on screen and marks it Accepted and read-only.

Surfaces: web (composer, conversation, thread overview, Plan panel, sidebar row), contracts (plan record, comments, RPCs, pushes), server (plan service, turn classification, migration, plan file), providers (one capture seam plus native plan modes per adapter). The Electron shell needs no change beyond the shared right panel shell (F-05).

## Boards

Page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0. Boards exist in dark only. Light follows the tokens (screen-pass todo, Open decisions).

| Board | Node | Shows |
|---|---|---|
| `07a · Plan mode · Draft · Dark` | `1ZTO-2` | New thread with the Plan chip on. The chip is neutral: `--color-selected` fill, ink ListTodo icon and label, no amber, no ×. Layer: "Composer mode / Plan / On · neutral, no amber" (`1ZXC-2`). |
| `07b · Plan mode · Questions · Dark` | `27YA-2` | The question dock replaces the composer (`282L-2`): "Codex has a question", pager "1 of 3", numbered options with "Recommended", "Write your own answer…", amber "Next". Status line "Waiting for your answers". Sidebar row "Answers required" with the amber ring at full brightness. |
| `07c · Plan mode · Planning · Dark` | `26BG-2` | Receipt "Answered 3 questions", narration, tool group, turn footer "1 step · Planning 0:38". The composer reads "Queue a follow-up" and keeps the Plan chip. The sidebar row is faded with a spinner. |
| `07d · Plan mode · Plan ready · Dark` | `26L9-2` | The overview gains a plan row "Tidy thread actions menu · v1" (doc icon). The chat ends with a short summary, not the plan. The composer placeholder is "Tell Codex what to change". The sidebar reads "Plan ready". There is no Implement button and no tray row. |
| `07e · Plan mode · Review in Plan panel · Dark` | `26TN-2` | Plan panel at 1440: sidebar 304, conversation 552, panel 536, rail 48. The header (`2708-2`) holds the version picker "v2 Edited by you", an "Implement v2" split (plain, because a comment is open), expand, and the panel toggle. The document shows title, summary, Steps, Files, and Risks. One highlight has a comment row (`271C-2`). The focused step 4 shows raw markdown and a caret. The composer chip reads "1 plan comment ×", Send is amber, and the access chip is icon-only. The overview is closed. |
| `07f · Plan mode · Implement · Build · Dark` | `260S-2` | Compact user bubble "Implement plan v1". The Plan chip is off. The overview plan row (doc icon) shows task progress "1/4". The task tray title is the plan title. |
| `07g · Plan panel · States · Dark` | `2CVQ-2` | 1. No open comments: amber split, menu "Implement v2 · Ctrl Shift Enter" and "Implement v2 in a new thread". The third item, "Implement v2 in a new worktree" (S07-08b), is not drawn. 2. New comment editor on a highlight. 3. "v2 Accepted", read-only, no button. 4. Editing a comment: trash on the left, Cancel and an amber round check on the right. |
| `07h · /plan in the composer · Dark` | `2CXZ-2` | 1. Typing `/pl` filters the attached slash tray to `/plan · Enter plan mode`. 2. Enter or Tab removes `/pl` and turns Plan on. 3. `/plan ` plus a space becomes the chip, and the rest of the draft stays. 4. With Plan on, the row reads `/plan · Exit plan mode`. |

Exact values from `get_jsx` and `get_computed_styles` (Paper wins over DESIGN.md; several Paper text nodes use `system-ui`, which means `var(--font-sans)` after F-01):

- **Plan panel header** (`2708-2`): 48 high, padding-left 16. Padding-right 98 at 1440 clears the caption overlay; use `env(titlebar-area-width)` through F-05 instead of the constant. Gap 8.
- **Version picker**: 32 high, padding 10, gap 6. `v2` is 14/20 weight 500 ink, then a muted 14/20 word ("Edited by you", "Accepted"), then a muted 12 chevron.
- **Implement split, plain** (`270F-2`): 32 high, `--radius-control`, `--color-selected` fill. Label 14/20 500 ink with padding 12. Divider 1×16 `--color-border`. Chevron slot 28 with a muted 12 chevron.
- **Implement split, amber** (`2CW0-2`): `--color-primary` fill, `--color-primary-ink` label and chevron, divider `color-mix(var(--color-primary-ink) 25%, transparent)`.
- **Split menu** (`2CW7-2`): 260 wide, `--color-panel`, 1px `--color-border`, `--radius-menu`, padding 4. Rows are 32 high with padding 8 and radius 6. Label 14/20 ink. Shortcut mono 12/16 muted ("Ctrl Shift Enter"). The active row uses `--color-hover`.
- **Expand**: 32 square ghost, maximize icon 16 muted. **Panel toggle**: 32, `--color-selected`, ink icon.
- **Document** (`270T-2`): padding 8 top, 24 sides, 24 bottom; 24 gap between sections.
  - Title: 24/32, weight 600, tracking -0.01em, ink. Summary: 14/20 muted.
  - Section label (an H2 such as "Steps"): 12/16 muted.
  - List row: padding 6/8, radius 8, gap 12. Number mono 12/20 muted in a 20 wide column. Text 14/20 ink.
  - Files row: mono 13/20, file name ink, folder muted, padding 2/8, 24px right fade (`--spacing-text-fade`).
  - Risks row: 14/20 ink, padding 2/8.
- **Highlight** (`271A-2`): `--color-selected` fill and a 1px `--color-muted` bottom border. It stays while the comment is open.
- **Comment row** (`271C-2`): inset 40 left and 8 right. `--color-panel`, radius 8, padding 8 / 4 / 8 / 12. Comment icon 14 muted in a 16 slot, note 14/20 ink. Pencil and check sit in 24×20 slots with 14 muted icons. There is no quote, author, or time.
- **Comment editor** (`2CWN-2` new, `2CXM-2` editing): `--color-panel`, 1px `--color-control-border`, `--radius-10`, padding 10 / 8 / 8 / 12, gap 8. Note 14/20 ink. Footer: trash in a 28 square (editing only), spacer, Cancel (13/20 weight 500 muted, 28 high, padding 10), then a 28 round `--color-primary` button with a `--color-primary-ink` 14 icon at stroke 2.
- **Composer plan comments chip** (`26YD-2`): 28 high, `--color-hover`, radius 8, padding 10 left and 6 right, gap 6. Comment icon 14 muted. Label 13/20 ink. × in a 20 slot (12, muted).
- **Plan chip** (`1ZXC-2`): 32 high, `--color-selected`, `--radius-control`, padding 8, gap 6. ListTodo 16 ink. Label uses the `body-small` tokens, ink.
- **Slash tray** (`2CY3-2`, row `2CY4-2`): 732 wide, top corners radius 12, `--color-panel`, padding 4/8. Rows are 40 high with gap 8: a 16 icon slot (14 ink glyph), the name on the `label` tokens in ink, and the description on `body-small` muted with the 24px fade.
- **Overview plan row** (`26SZ-2`): 32 high, gap 8. Doc icon 16 muted. Title 14/20 ink on one line (use F-02 fade, not a line clamp). Trailing 12/16 muted with tabular numbers: `v1` before Implement, `1/4` during Implement.
- **Question dock** (`282L-2`): `--color-panel`, 1px `color-mix(var(--color-primary) 45%, transparent)`, `--radius-composer`, padding 14/16, gap 12.
  - Header: 14/20 weight 500 ink, then a pager at 12/16 muted.
  - Question: 15/22 weight 500 ink.
  - Option rows: min height 36, padding 6/10, radius 8, gap 10. The active row uses `--color-hover`.
  - "Next": a 32 high amber pill with padding 14 and `--radius-18`.

## Locked decisions

From `source/screen-pass-todo.md:46-50` and `source/implementation-notes.md:139-158`. All are dated 2026-10-07.

- **Source of truth.** Mcode's plan record is the source of truth. Edits save a new version marked as the user's. Implement sends exactly that text inline, which works for all six providers, and adds "this supersedes any earlier plan or plan file". (PRODUCT.md:126-130, principle 13.)
- **Live-preview editor.** The Plan panel is a live-preview markdown editor. The focused line shows raw markdown. The first change creates a new version. There is no Edit button.
- **Implement placement.** Implement lives only in the Plan panel header, as a split button that names the version on screen: "Implement v2". Its menu holds "Implement v2 · Ctrl+Shift+Enter", "Implement v2 in a new thread", and "Implement v2 in a new worktree" (user, 2026-10-08, E9). 07d has no Implement. Ctrl+Shift+Enter and the ⌘K/Ctrl+K palette entries work without opening the panel.
- **Implement in a new thread or a new worktree** (user, 2026-10-08, E9). A new thread continues the plan in the source's own checkout and skips Setup (reason `plan-implement`). A new worktree starts from the source checkout's current commit on a new branch, leaves uncommitted changes in the source, and runs Setup as any new worktree does (S07-08b).
- **Superseded versions** cannot be implemented (user, 2026-10-08, L9). Draft and ready versions can, including the ready version a user edit forked from.
- **Implement behavior.** Implement saves pending edits first and sends exactly that text, shown as a compact "Implement plan vN" message. The version then becomes Accepted and read-only. Wire `accepted` and `superseded`; `plan.updateStatus` is never called today.
- **Comments.**
  - The user highlights text to comment. The highlight stays.
  - A comment row shows an icon, the note, edit (pencil), and resolve (check). Clicking the note or the pencil opens the editor in its editing state.
  - Open comments ride the composer as a removable chip ("1 plan comment ×"). Amber then moves to Send and Implement drops to plain. Implement is not blocked.
  - Comments are stored per plan version. On edit they re-anchor, or drop to their section. There is no per-step hover comment button.
- **Where the plan lives.** The plan lives in the thread overview (row "title · v1"). Clicking the row opens the Plan panel. No plan prose is duplicated in chat; remove the prompt that asks for prose (`plan-question-service.ts:141`).
- **Sidebar and dock.**
  - The sidebar shows "Answers required" and "Plan ready" with the 06 amber ring at full brightness. The row states come from the S01 thread row state model.
  - The question dock replaces the composer, and the status line reads "Waiting for your answers".
- **Follow-ups.** In Plan ready, a composer send revises the plan. It does not re-run the question wizard.
- **Plan chip.** The chip is neutral. Today `ComposerCapabilityChip.tsx:30-32` makes it amber.
- **/plan.**
  - `/plan` plus a space converts inline and keeps the rest of the draft. Enter or Tab on the row turns Plan on and removes the typed command.
  - `/plan` toggles: the row reads "Exit plan mode" when Plan is on and "Enter plan mode" when it is off.
  - The slash tray matches the task tray exactly. A single match has no row fill. With several matches, the active row uses `--color-hover`.
- **Plan file.** Pass Mcode's plan file path to the agent implicitly, so the agent keeps track and a thread can switch provider mid-plan.
- **Providers.**
  - Add a "No structured plan" state for providers that yield no plan record.
  - Claude's native plan mode is allowed.
  - Codex native plan mode uses `collaborationMode` (T3 Code model, `implementation-notes.md:155`).
  - Sync or delete a provider's own plan file before Implement so it cannot disagree with the edited text. Only a file whose owning session is proved is touched (see Native plan files).
- **Read-only claim.** Today only the question turn runs as Plan at the provider (`turn-admission-dispatch-coordinator.ts:877-880`). Do not claim "read-only" until that changes per provider.
- **Narrow composer.** With the right panel open, the access chip goes icon-only under about 560px. The overview card closes while the right panel is open (`implementation-notes.md:153-154`).

Board versus todo, resolved:

- `screen-pass-todo.md:46` first describes a 07d "Next-step tray row … amber Implement". The later decision on the same line says "07d has no Implement", and the board `26L9-2` has no tray row, so follow the board.
- The "Rejected:" list on that line ends with items the 07e board still shows: the document sections, the Plan tab active in the rail, the overview closing, and the icon-only access chip. `implementation-notes.md:153-154` confirms the last two. Read only the first three items (tray row with v1, Send turning into Implement, plan card in the transcript) and the per-step hover comment button as rejected.

## How it works today

### Turn flow (server)

- **The first Plan send** is wrapped in Mcode's question prompt for every provider (`plan-turn-service.ts:52-81`; applied at `turn-admission-dispatch-coordinator.ts:858-861` and on new threads at `thread-creation-coordinator.ts:610-612`). The prompt forbids tools and native ask or plan tools.
- **Answers** are sent by `PlanTurnService.answerQuestions` (`plan-turn-service.ts:114-138`) with no `interactionMode`, so the planning turn runs as build. Revise and implement also run as build: `effectiveInteractionMode` returns `undefined` for both (`turn-admission-dispatch-coordinator.ts:877-880`). Verified: only the question turn is Plan at the provider.
- **Follow-ups in Plan mode** take the same path as the first send, so they re-run the question wizard (`:858-861`). Verified.
- **The planning prompt** asks for the plan "as normal markdown in your response so the user can read it in the chat" plus a JSON `plan-output` fence (`plan-question-service.ts:136-161`). The chat therefore shows the full plan. The web hides only the fence (`MessageBubble.tsx:41-42`, `MarkdownContent.tsx:498`).
- **Capture** (`plan-execution-state.ts`). The JSON fence goes through `PlanOutputParser` (`plan-output-parser.ts:163-200`). Native markdown comes through `handleExitPlanMode` (`plan-turn-service.ts:95-97`). There is also a fallback that scrapes headings from any assistant message while an output parser is armed (`plan-execution-state.ts:93-95,107-126`). That scrape can capture prose that is not a plan (inferred risk).

### Persistence

- **Table `plans`** (`schema.ts:972-994`). One row per version per thread. `message_id` is NOT NULL and has an FK to `messages`. `status` is text with the values `draft | accepted | superseded` (`plan-output.ts:39-41`). It also has `sections_json` and `change_summary`. No table has an FK into `plans`, so a rebuild is safe under the FK-pragma limitation (`docs/internals/persistence/db-migrations.md`). The latest migration is `0068_tricky_morg.sql`, so the next one is 0069.
- **Two writers.**
  - Legacy `PlanRepo` (`plan-store.ts:25-68`) supersedes drafts on create.
  - The canonical accepted-progress path (ADR 0022) prepares agent plans in `accepted-feature-observations.ts:363-390`. It computes the version from prior plans and supersedes `draft` rows. It persists through `accepted-feature-write.ts:95-115`, and `validatePlanRouting` requires the row's message to be an assistant message.
- **Canonical cache trap** (verified).
  - `plan.list` prefers `canonicalProgress.listPlans` (`agent-rpc.ts:175`).
  - When no turn is running, `listPlans` refreshes only plans already in its in-memory list (`canonical-accepted-progress.ts:245-255`).
  - The result: a row written by `PlanRepo` alone, such as a user version, is invisible to `plan.list`. Agent version numbers also come from that list (`accepted-feature-observations.ts:392+`).
  - The cache seed reads the `plans` table (`canonical-agent-store.ts:583-590`), so a reload fixes both problems.
- **`plan.updateStatus`** exists (`methods.ts:1140-1146`, `agent-rpc.ts:171-174`, canonical `updatePlanStatus` at `canonical-accepted-progress.ts:266-290`). No web code calls it; `planStore.updatePlanStatus` (`planStore.ts:122-131`) is local only. Verified: nothing ever becomes `accepted`.

### Wire

- **Pushes:** `plan.questions`, `plan.answered`, `plan.dismissed`, `plan.generated` (`channels.ts:177-205`).
- **`agent.send`** carries `planAction: "revise" | "implement"` (`methods.ts:343-347`) and already supports `displayContent`, which persists a different transcript from the wire content (`methods.ts:299-303`).
- **The server command** also has `providerWireOverride` (`turn-admission-dispatch-coordinator.ts:70-71`).

### Web

- **Plan panel** (`PlanPanel.tsx`).
  - Comments are one note per heading, held in React state and lost on unmount (`PlanPanel.tsx:23-40,67`; `PlanDocument.tsx:33-52`; `PlanAnnotation.tsx`).
  - "Send feedback" and "Revise" send a revise action (`PlanPanel.tsx:119-154`).
  - Implement pastes the whole plan into a build turn (`PlanPanel.tsx:156-173`). `threadStore.sendPlanAction` flips the thread to build on the client first (`threadStore.ts:3986-4023`, build switch at `:3995-4004`).
  - `PlanChrome` renders a revision popover, Revise, and a default-variant (amber, inferred) Implement (`PlanChrome.tsx:46-175`).
  - There is a version banner and a feedback bar (`PlanPanel.tsx:42-55`), and a skeleton while generating (`PlanPanel.tsx:175-177`).
- **Plan preview.** A composer-adjacent "View plan" card (`PlanPreview.tsx`, `ComposerContentSurface.tsx:155-170`, `planStore.ts:15-19`) is fed by `plan.generated` (`ws-events.ts:607-617`).
- **Overview row.** It reads "Plans" plus the title, with ListChecks (`ThreadOverview.tsx:2455-2466,2655-2676`), and opens the `tasks` tab.
- **Composer "Plan" button.** A separate composer button toggles the panel (`ComposerOptionControls.tsx:108-166`).
- **Plan tab.** id `tasks`, label "Plan", icon ListChecks, blurb "Read saved plans" (`panel-tabs.ts:104-111`). Toggled with `mod+t` (`default-keybindings.json:27`) through `tasks.toggle` (`App.tsx:812-817`).
- **Question wizard.** `PlanQuestionWizard` renders between the message list and the composer. It does not replace the composer (`ChatViewSurface.tsx:660`). It has "Accept recommended" (`PlanQuestionWizard.tsx:213`). There is no "Waiting for your answers" or "Planning" label anywhere (verified by search).
- **Plan chip.** Amber (`ComposerCapabilityChip.tsx:30-32`). `/plan` only attaches it (`Composer.tsx:499-507`, `useComposerAgentControlState.ts:177-185`); there is no toggle and no inline conversion. Plan is offered for every provider (`composer-capabilities.ts:83`). `CONTEXT.md:1283-1284` still says "except Copilot", which is drift.
- **Sidebar.** Only pending permissions mark a row (`ThreadStateMarker.tsx:63`). Plan questions for background threads are known only after the thread opens (inferred from client-side `extractPendingPlanQuestions`).
- **Keyboard.** No binding uses Ctrl+Shift+Enter (verified in `default-keybindings.json`). Global shortcuts listen on `document` in the bubble phase (`shortcuts.ts:94`). In the composer, Shift+Enter (and therefore Ctrl+Shift+Enter) is not submit (`KeyboardPlugin.tsx:66-70`), so Lexical inserts a line break before the global handler runs (inferred).
- **Editor libraries.** Lexical is the composer editor (`apps/web/package.json:23,44`). There is no CodeMirror and no `@lexical/markdown`.

### Providers

| Provider | Plan at the provider today | Plan capture today |
|---|---|---|
| Claude | No SDK plan permission mode is used. Full access maps to `bypassPermissions` (`claude-provider.ts:1676-1679`). | The answer turn arms `setPlanAnswerMode` through an off-interface cast (`plan-turn-service.ts:151-156`, `claude-provider.ts:2872-2878`). `ExitPlanMode` is captured and denied (`:1036-1060`). Otherwise the fence. |
| Codex | Only the browser capability changes (`codex-provider.ts:1144`). No `collaborationMode`: `TurnStartParams` lacks it (`codex-types.ts:163-180`). `experimentalApi: true` is already sent (`codex-app-server.ts:599,907`), which corrects the notes. The minimum CLI is 0.37.0 (`codex-provider.ts:98`). | Fence only. `item/plan/delta` becomes thinking text (`codex-event-mapper.ts:1978-1982`). The completed `plan` item is silent (`:67-70`). There is no `requestUserInput` handler (verified by search). |
| Cursor | `setPlanQuestionMode` stops native `ask_question` from being auto-answered (`cursor-provider.ts:408`, `cursor-acp-client-bridge.ts:161`). | `cursor/create_plan` is captured and always answered `accepted` (`cursor-acp-client-bridge.ts:178-191`), so the bug is verified. The fixture validator requires `markdown` (`fixture-safety.ts:341-350`); the extractor tries `plan` first (`cursor-create-plan.ts:10`). |
| Copilot | `rpc.mode.set({ mode: "plan" })` on the question turn (`copilot-provider.ts:114`). In plan mode every non-read permission is denied (`:510`), including, it is inferred, Copilot's own `plan.md` write. The SDK is pinned at `^0.2.2` (`packages/providers/package.json:20`). | Fence only. |
| Devin | Native `mode=plan` through `set_config_option` on the question turn (`devin-provider.ts:74-77,516-540`). | Fence only. There is no Devin conformance fixture (verified). |
| OpenCode | The capability says "plan" (`opencode-provider.ts:47`), but the prompt body has only `model` and `parts` (`:718-721`), so there is no plan agent. | Fence only. |

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Plan chip neutral, click to toggle off (07a) | Amber chip with × | Neutral toggle chip | web |
| `/plan` inline conversion, toggle, attached tray (07h) | Attach only, floating popup | Inline conversion, toggle row, tray matching the task tray | web |
| Question dock replaces the composer, plus "Waiting for your answers" (07b) | Wizard above the composer, no label | Dock in the composer slot; status label | web |
| Sidebar "Answers required" / "Plan ready" (07b, 07d) | No plan states | `threads.plan_phase` fed into the S01 row model | contracts, server, web |
| "Answered N questions" receipt; "Planning" footer (07c) | `AnsweredSummary`; generic status | Restyled receipt; plan phase drives the label | web, server |
| No plan prose in chat; short summary (07d) | Prompt asks for prose | Prompt asks for a 1-2 sentence summary plus a hidden fence; native capture where available | server, providers |
| Overview row "title · v1" / "1/4" (07d, 07f) | "Plans" + title, ListChecks | Doc icon, title with fade, trailing version or task progress | web |
| Follow-up in Plan ready revises (07d) | Re-runs the wizard | Server classifies the send as `revise` | server |
| Plan panel header: version picker, Implement split, expand, toggle (07e) | `PlanChrome` with Revise and an amber Implement | New header on F-05; split from F-03; menu from F-04 | web |
| Live-preview editor; first change creates "Edited by you" (07e) | Read-only react-markdown | CodeMirror 6 live preview; `plan.saveVersion` against a server revision | contracts, server, web |
| Highlight to comment, comment rows, editor states (07e, 07g) | One note per heading, memory only | `plan_comments` per version, anchors, re-anchoring | contracts, server, web |
| Composer chip "1 plan comment ×"; amber shift (07e) | Feedback bar in the panel | Chip in the composer attachment row; revise carries comments | contracts, server, web |
| Implement split, Ctrl+Shift+Enter, ⌘K, new thread (07g), new worktree (not drawn) | Paste plan into chat; nothing marked accepted | `plan.implement`: a durable request with target `thread`, `new-thread` or `new-worktree`; Accepted commits inside turn admission | contracts, server, web |
| Compact "Implement plan vN" bubble; Plan chip off (07f) | Full plan pasted as the user message | `displayContent` plus a wire override; server sets build mode | server, web |
| Accepted version read-only (07g state 3) | Not reachable | Status `accepted`; editor read-only; picker word "Accepted" | server, web |
| "No structured plan" (not drawn) | Silent | `plan_phase = no_plan` plus an empty state (open question 4) | server, web |
| Plan file passed implicitly | None | `<mcodeDir>/threads/<id>/plan.md`, path in the wire text | shared, server |
| Native plan per provider | Question turn only | Capture seam; native modes and native plan files only where S07-00 evidence supports them | providers |

## Backend architecture

```text
 provider adapter ──plan_captured{markdown, source, nativePlanFile?}──► PlanTurnService ──► canonical accepted progress
    ▲      ▲                                                                │ classify(send)        (agent versions)
    │      │ prepareImplement(ref)                                          ▼
    │      └──────────────────────────── PlanService (user writes, Implement requests)
    │ TurnRequest.planTurn                     │                    │
 turn admission ◄── send + planImplement ──────┘                    ├──► plans, plan_comments, plan_implement_requests, threads.plan_phase
    └── canonical start transaction: user message + acceptPlanImplement + plan comment stamps
                                                                    └──► PlanFileWriter ──► <mcodeDir>/threads/<id>/plan.md
```

One new server seam, `PlanService` (`apps/server/src/features/agents/planning/plan-service.ts`), owns every user-originated plan write: draft saves, comments, Implement requests, and the plan file. `PlanTurnService` stays the owner of agent turns: classification, question prompts, and capture. Agent versions keep flowing through the canonical writer. Anything that must be true exactly when a turn starts (an Accepted version, a comment marked as sent) commits inside the canonical turn start, never beside it.

Each piece has one owning ticket:

| Piece | Ticket |
|---|---|
| Provider capture event; the `planTurn`, `NativePlanFileRef` and `prepareImplement` signatures; fence parser; legacy `plan-output` reader | S07-01 |
| Versions, draft autosave, `plan.snapshot`, writer coordination, the plan file, legacy canonical plan items | S07-03 |
| Comments, re-anchoring, carry-forward, `agent.send.planCommentIds` | S07-06 |
| Implement request, admission coupling, restart recovery | S07-07, extended for new threads by S07-08 and for new worktrees by S07-08b |
| Turn classification, `plan_phase`, filling `TurnRequest.planTurn` | S07-09 |
| Native plan modes, native questions and native plan files | S07-02, S07-12, S07-13, S07-14, as far as S07-00 evidence supports |

### Data shapes (contracts)

S07-01 renames `packages/contracts/src/models/plan-output.ts` to `plan.ts` and drops the JSON fence schemas. S07-03 replaces the remaining record schemas in it with:

```ts
export const PLAN_MAX_CONTENT_CHARS = 64 * 1024; // proposed bound for untrusted input

export const PlanVersionStatusSchema = z.enum(["draft", "ready", "accepted", "superseded"]);
// draft: the user's mutable working version (autosaved, at most one, always the latest)
// ready: an immutable reviewable version (agent output)
// accepted: implemented; read-only forever; never superseded
// superseded: an older draft or ready version replaced by a newer one

export const PlanVersionSchema = lazySchema(() => z.object({
  id: z.string().uuid(),
  threadId: z.string(),
  version: z.number().int().min(1),             // per thread, continues across plans (open question 1)
  title: z.string().min(1).max(200),            // first H1 of contentMd
  contentMd: z.string().max(PLAN_MAX_CONTENT_CHARS),
  status: PlanVersionStatusSchema,
  author: z.enum(["agent", "user"]),
  providerId: ProviderIdSchema.nullable(),      // agent versions; null for user and legacy rows
  captureSource: z.enum(["native", "fence", "edit", "copy"]),
  messageId: z.string().nullable(),             // assistant message for agent versions only
  baseVersionId: z.string().uuid().nullable(),  // user edits and new-thread copies
  revision: z.number().int().min(0),            // server counter: ready rows stay 0; a draft starts at 1, each save adds 1
  createdAt: z.string(), updatedAt: z.string(), acceptedAt: z.string().nullable(),
  acceptedMessageId: z.string().nullable(),     // S07-07: user message of the turn that implemented it, read from the
                                                // admitted plan_implement_requests row; S05's task title (R1) and the overview row use it
}));

export const PlanCommentAnchorSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), start: z.number().int().min(0), end: z.number().int().min(1),
    quote: z.string().min(1).max(2000), prefix: z.string().max(64), suffix: z.string().max(64),
    section: z.string().max(200).nullable() }),
  z.object({ kind: z.literal("section"), section: z.string().max(200).nullable(), quote: z.string().max(2000) }),
]));

export const PlanCommentSchema = lazySchema(() => z.object({     // S07-06
  id: z.string().uuid(), threadId: z.string(), versionId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
  anchor: PlanCommentAnchorSchema(),
  status: z.enum(["open", "resolved"]),
  sentMessageId: z.string().nullable(),          // set when the comment rode a revise send
  carriedFromCommentId: z.string().uuid().nullable(),
  createdAt: z.string(), updatedAt: z.string(), resolvedAt: z.string().nullable(),
}));

export const NativePlanFileOutcomeSchema = z.discriminatedUnion("outcome", [   // S07-07
  z.object({ outcome: z.enum(["synced", "deleted"]) }),
  z.object({ outcome: z.literal("skipped"), reason: z.enum(["no-file", "unproven", "changed", "unsafe-path"]) }),
]);

export const PlanImplementReceiptSchema = lazySchema(() => z.object({           // S07-07
  requestId: z.string().uuid(), versionId: z.string().uuid(), version: z.number().int().min(1),
  targetThreadId: z.string(), messageId: z.string().uuid(),
  nativePlanFile: NativePlanFileOutcomeSchema.nullable(),
  state: z.enum(["admitted", "waiting-for-setup"]),  // S07-08b: "waiting-for-setup" while a new worktree's first turn
                                                     // waits behind Setup; the version is not Accepted yet
}));

export const PlanPhaseSchema = z.enum(["questions", "planning", "ready", "no_plan"]);   // S07-09
// Thread gains `plan_phase: PlanPhase | null` (ThreadSchema, packages/contracts/src/models/thread.ts:17).
```

Anchor offsets are UTF-16 code units into `contentMd`, matching JS strings and CodeMirror positions. Provider plan file paths never cross the wire; only the outcome does.

### Database

Each ticket adds its own migration with the next free number (README rule); 0069 is the next number today.

- **S07-03, rebuild `plans`.** `message_id` becomes nullable. Add `author`, `provider_id`, `capture_source`, `base_version_id`, `revision`, `updated_at`, `accepted_at`, and a server-only `native_plan_file_json` (the S07-01 `NativePlanFileRef`). Drop `sections_json` and `change_summary`. Existing `draft` rows are backfilled to `ready`, `author = 'agent'`, `capture_source = 'fence'`, `revision = 0`, and `provider_id = NULL` (unknown, honestly). A unique index goes on `(thread_id, version)`. The canonical writer already rejects duplicate versions (`accepted-feature-write.ts:113`), so existing data should satisfy it (inferred); the migration test must assert this. No table has an FK into `plans` yet, so the rebuild is safe under the FK-pragma limitation (`docs/internals/persistence/db-migrations.md`).
- **S07-06, create `plan_comments`.** `id` PK; `thread_id` FK to threads (cascade); `version_id` FK to plans (cascade); `body`; `anchor_json`; `status`; `sent_message_id` (no FK; the message may be compacted); `carried_from_comment_id`; timestamps. Index `(version_id, status)`. This is the first inbound FK into `plans`; a later rebuild of `plans` must follow `db-migrations.md`.
- **S07-07, create `plan_implement_requests`** with the shape in Implement below. `source_thread_id` FK to threads (cascade). No FK to `plans` or to the target thread, because the row is an immutable snapshot. A partial unique index on `source_thread_id` where `status = 'preparing'` allows at most one unsettled Implement per thread.
- **S07-09, `ALTER TABLE threads ADD COLUMN plan_phase TEXT`.**

### Write ownership and serialization (S07-03; the trap to document)

- **Agent versions** stay on the canonical path (`accepted-feature-observations.ts:365-390`).
  - Change: supersede both `draft` and `ready` predecessors, never `accepted`.
  - Set `author`, `providerId`, `captureSource`, and the server-only native file ref from the capture event.
  - A user fork does not supersede its base. While a user draft exists, the `ready` version it forked from stays `ready`, so the user can still implement the agent's text (Implement, below).
- **User writes** (draft saves, comments, Implement) go through `PlanService` as allowlisted operations on `ApplicationDatabaseWriter`, the application's only writable connection (`application-database-writer.ts:43-44`; existing plan operations at `plan-write-operations.ts:6-11`). Each operation checks its preconditions inside its own transaction, so draft saves, agent captures and turn admission on one thread apply in one order.
  - `plan_busy` when the thread has an unfinished execution (a `canonical_agent_ingest_checkpoints` row with no `terminal_outcome`, `schema.ts:788-807`) or a `preparing` Implement request. Agent captures happen only inside executions, so a user write and a capture never interleave.
  - Drafts and Implement both carry a revision precondition (Draft autosave and Implement, below). Implement checks it before taking its text snapshot and again inside the turn start.
  - Because user writes never run during a turn, they need no canonical status writes. Those would fail `validatePlanRouting` for user versions, which have no assistant message (`accepted-feature-write.ts:105-108`).
- **Canonical cache.** Accepted progress publishes agent plans before its save queue writes SQLite (`canonical-accepted-progress.ts:210-212`). It numbers the next version from its in-memory list (`accepted-feature-observations.ts:380`), and `listPlans` refreshes that list only when no head exists (`canonical-accepted-progress.ts:245-255`).
  - After every `PlanService` write, including an Implement admission, call a new `CanonicalAcceptedProgress.reloadPlans(threadId)`. It merges the `plans` table into the in-memory list. New rows are added. Content and revision of user rows come from the table. Status takes the later of the two values in the order draft or ready, then superseded, then accepted.
  - The merge is monotonic, so it is safe while a head exists, which is the case right after an Implement admission. `plan.snapshot` applies the same merge, so it never shows a status older than the table.
  - The save queue drains in FIFO order on the one writer before the turn's terminal commit, so a fork right after a planning turn sees the agent's version (inferred; S07-03 tests it).
- **Legacy canonical plan items.** The canonical event log keeps old `projection: "plan"` item payloads in the `PlanRecord` shape. The server reads them through one function in `legacy-plan-record.ts` that maps them to `PlanVersion` the way the migration maps rows, and never rewrites them. Clients only see `PlanVersion`.
- **Delete** canonical `updatePlanStatus`, the `plan.updateStatus` RPC and writer operation, and the unused local `planStore.updatePlanStatus`; nothing calls them.
- **Record this** in a short `docs/internals/conversation/plan-records.md`: user writes never go through the canonical owner; reload after every write; Accepted commits only inside turn admission; native plan files change only with ownership proof.

### Draft autosave (S07-03 server, S07-05 client)

- **Revision.** The server owns it. A `ready` version is created at 0 and never changes. A `draft` is created at 1, and the server adds one on every save.
- **`plan.saveVersion({ threadId, versionId, baseVersionId, baseRevision, contentMd })`.** `versionId` is the draft's id. The client mints it once, at the first change of an edit session, and reuses it for every save and every retry in that session. This keys the first-edit fork.
  - **No row has `versionId` (a fork).** `baseVersionId` must be the thread's latest version, `ready`, with `revision = baseRevision`. The server creates the draft with version = latest + 1, revision 1, and `baseVersionId` set.
  - **The row exists.** It must be this thread's `draft`. Any window may save to it by its id; the draft has no owning session. When `revision = baseRevision`, the server writes the text and returns revision + 1. When `revision = baseRevision + 1` and the stored text equals `contentMd`, the request replays a lost response, so the server returns the row unchanged. Anything else is `plan_conflict`.
  - **Failures.** `plan_conflict` returns the latest version and writes nothing. It covers a newer latest version, another window's draft, and any revision mismatch, so the client keeps its text in every case. `plan_read_only` when the base is accepted. `plan_busy` per the serialization rule.
- **Client (S07-05).**
  - One save in flight per thread. Newer keystrokes coalesce into the next save. A lost response resends the identical payload.
  - On `plan_conflict`, the editor keeps the local text, stops autosaving, and shows a conflict notice with "Keep my text" and "Use saved version" (proposed copy, no board; open question 14). Neither choice is ever made automatically.
  - **Keep my text** turns the retained local text into an ordinary save against the returned latest version L:
    - L is a `draft` (another window's fork, or this draft at a newer revision): the session adopts L's id as its `versionId` and L's revision as `baseRevision`, then saves the local text. It lands as L's revision + 1 and replaces the other window's text, which is what the user confirmed.
    - L is `ready` (an agent capture replaced the base): the session mints a new `versionId` and forks L at revision 0.
    - L is `accepted`: there is nothing to save into, because the base is read-only. Keep my text is not offered; the editor keeps the local text visible, read-only, until Use saved version.
  - **Use saved version** loads L and discards the local text. When L is a draft, the session adopts its id and revision; otherwise the next change mints a new `versionId`.
  - After either choice the session follows the normal rules: every later save needs revision equality, so a third window's save produces a new conflict and a new choice.
  - The client never reloads over unacknowledged text.

Two windows that fork the same ready version with different `versionId`s create one draft; the second window gets `plan_conflict`, keeps its text, and its Keep my text saves into that one draft. Two saves sent with the same `baseRevision` land at most once.

### Wire contract

| Method | Params | Result | Failure modes |
|---|---|---|---|
| `plan.snapshot` (replaces `plan.list`, S07-03) | `{ threadId }` | `{ versions: PlanVersion[] }`; S07-06 adds `comments: PlanComment[]`, S07-09 adds `phase: PlanPhase \| null` | `thread_not_found` |
| `plan.saveVersion` (S07-03) | `{ threadId, versionId, baseVersionId, baseRevision, contentMd }` | `PlanVersion` | `plan_busy`; `plan_read_only`; `plan_conflict` (returns the latest version; nothing written) |
| `plan.comment.create` (S07-06) | `{ commentId (client uuid), versionId, anchor, body }` | `PlanComment` | Idempotent on `commentId`; `plan_read_only` on an accepted version |
| `plan.comment.update` (S07-06) | `{ commentId, body }` | `PlanComment` | `plan_read_only` |
| `plan.comment.setStatus` (S07-06) | `{ commentId, status: "open" \| "resolved" }` | `PlanComment` | Resolve, plus its reverse |
| `plan.comment.delete` (S07-06) | `{ commentId }` | `void` | Idempotent |
| `plan.implement` (S07-07, S07-08, S07-08b) | `{ requestId (uuid), threadId, versionId, expectedRevision, pending?: { versionId, baseVersionId, baseRevision, contentMd }, target: "thread" \| "new-thread" \| "new-worktree" }`. `expectedRevision` is required: the revision of the text on screen. With `pending`, `pending.versionId` equals `versionId`. The client never sends a commit or a branch for `new-worktree`; the server resolves both. | `PlanImplementReceipt`; for `new-worktree`, `state: "waiting-for-setup"` while Setup holds the first turn | `thread_busy`; `plan_read_only` (accepted); `plan_conflict` (the version's revision differs from `expectedRevision`, or it is superseded; returns the latest version); `implement_request_conflict` (same id, other params); `implement_interrupted` (a restart before admission); `implement_failed` (admission refused, the new thread's startup cancelled or failed, or, for `new-worktree`, no git repository, no commit at HEAD, or a taken branch name, with the cause). A replay of the same `requestId` returns the stored receipt, its current state, or the failure. |
| `agent.send` (changed) | S07-06 adds `planCommentIds?: uuid[]` (max 128). S07-09 removes `planAction`. | unchanged | `plan_comment_invalid` when an id is not open, already sent, or not on the latest non-accepted version, checked inside the admission transaction |

| Push | Payload | Replaces |
|---|---|---|
| `plan.versionUpserted` (S07-03) | `{ threadId, version: PlanVersion }` (agent capture, user save, status change) | `plan.generated` |
| `plan.commentsChanged` (S07-06) | `{ threadId, upserted: PlanComment[], deletedIds: string[] }` | none |
| thread update (S07-09) | `plan_phase` on the existing thread payload (S01 row model) | none |

Errors follow the existing typed RPC error shape in `agent-rpc.ts` (inferred). All bodies are bounded by zod at the boundary. Markdown is untrusted: render it with the existing sanitizing pipeline, with no raw HTML (inferred from `MarkdownContent`).

### Turn classification (`PlanTurnService.classify`, S07-09)

| Send | Plan kind | Wire wrapper | Provider mode |
|---|---|---|---|
| Plan on, no draft or ready version | `questions` | Mcode question prompt (native questions for Codex on CLIs that S07-02 enables) | Plan where the adapter declares native plan turns, else as today |
| Answers submitted | `planning` | Answers plus plan instructions | Same rule |
| Plan on, latest is draft or ready (Plan ready) | `revise` | User text, the comments envelope, and the plan file path | Same rule |
| `plan.implement` | `implement` | The Implement text (below) | Build, explicitly (Codex sends `collaborationMode: default`) |
| Plan off | none | none | Build |

S07-01 declares `TurnRequest.planTurn?: { kind: "questions" | "planning" | "revise"; planFilePath: string | null }`. S07-09 fills it at classification. Adapters read it in S07-02 and S07-12 to S07-14 to choose their native mode at the boundary, which replaces the Claude-only `setPlanAnswerMode` cast.

`plan_phase` transitions:

| From | Event | To |
|---|---|---|
| none | Questions published | `questions` |
| `questions` | Answers submitted | `planning` |
| `questions` | Questions dismissed or expired | none |
| none or `ready` | Revise starts | `planning` |
| `planning` | Version captured | `ready` |
| `planning` | Turn ends with no capture | `no_plan` |
| `planning` | Turn stops or fails, a draft or ready version exists | `ready` |
| `planning` | Turn stops or fails, no draft or ready version | none |
| any | Implement admitted (inside the admission transaction) | none |
| any | Thread leaves Plan mode | none |

The sidebar shows "Answers required" for `questions` and "Plan ready" for `ready` (S01).

### Implement (`PlanService.implement`, S07-07; new-thread path S07-08; new-worktree path S07-08b)

Implement is a durable request. Its row exists before any side effect, and the version becomes Accepted only inside the transaction that admits the turn. Accepted is therefore never visible without an admitted turn, and an admitted Implement turn always has its Accepted version.

**What can be implemented.** Implement sends the version on screen at the revision on screen, or nothing.

- A `draft` or `ready` version is implementable. That includes the `ready` version a user draft forked from; implementing it supersedes the draft.
- `accepted` is read-only (`plan_read_only`).
- `superseded` is history. The picker shows it read-only with no Implement split, the shortcut and palette never target it, and the server refuses it with `plan_conflict` and the latest version.
- Every request carries `expectedRevision`, the revision of the text the user saw: 0 for a ready version, the acknowledged revision for a draft, or, with `pending`, the revision the pending save produces (1 for a fork, `pending.baseRevision + 1` otherwise). The server compares it with the version's revision before it takes the text snapshot, and admission compares it again. Another window's save between display and click therefore fails the request instead of sending text the user never saw.

```ts
// Server-only row in plan_implement_requests.
interface PlanImplementRequest {
  requestId: string;              // client uuid, primary key
  sourceThreadId: string;
  fingerprint: string;            // sha256 of the validated params: threadId, versionId, expectedRevision, pending, target
  versionId: string;              // immutable snapshot, no FK
  version: number;
  revision: number;               // expectedRevision, verified before the snapshot; admission re-checks it
  title: string;
  wireText: string;               // exact provider text, bounded by PLAN_MAX_CONTENT_CHARS plus the header
  target: "thread" | "new-thread" | "new-worktree";
  sourceCommit: string | null;    // new-worktree only: the source checkout's HEAD, resolved in step 3
  targetThreadId: string | null;  // the source thread, or the new thread once the startup or admission binds it
  startupId: string | null;       // new-thread and new-worktree; equals requestId
  messageId: string;              // admission identity: the user message the turn will project
  status: "preparing" | "admitted" | "failed";
  failureCode: string | null;     // thread_busy, plan_conflict, interrupted, admission_failed, startup_cancelled, ...
  nativePlanFile: NativePlanFileOutcome | null;
  turnId: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

1. **Replay.** Look up `requestId` in the in-process map (set before the first await) and then in the table. With the same fingerprint, `admitted` returns the stored receipt, `failed` returns the stored failure, and `preparing` in this process joins the in-flight promise, or returns `state: "waiting-for-setup"` once a new worktree's first turn waits behind Setup. A different fingerprint returns `implement_request_conflict`. A replay never repeats a side effect and never creates a second thread.
2. **Reserve.** Take the source thread's mutation reservation. This is the same per-thread gate an ordinary Send takes (`thread-control-mutation-reservation-service.ts:24-31`, used by Send at `turn-runtime-controller.ts:500-503`).
   - Thread target: reserve as `activeTurn` and hand the token to admission as `mutationReservationToken`. Thread-control approval dispatch already passes a reservation into admission this way (`turn-admission-dispatch-coordinator.ts:80-81`).
   - New-thread and new-worktree targets: reserve the source in a new `planImplement` state and release it when the request settles. For a new worktree that can be after Setup finishes.
   - No reservation available returns `thread_busy`. While Implement holds it, an ordinary Send fails with the existing pending-mutation error. If a Send holds it first, Implement fails `thread_busy`.
3. **Prepare, in one writer transaction.** Refuse with `thread_busy` if the thread has an unfinished execution. Apply `pending` under the `plan.saveVersion` rules. Check that the version belongs to the thread and is `draft` or `ready` (accepted returns `plan_read_only`; superseded returns `plan_conflict`). Check that its revision equals `expectedRevision`, else return `plan_conflict` with the latest version. For a new-worktree target, record as `sourceCommit` the source checkout's HEAD, resolved with git after the reservation and before this transaction, never inside it (S07-08b). Only then take the snapshot: insert the row as `preparing` with the snapshot text, the wire text, a fresh `messageId`, and `targetThreadId` set to the source for a thread target. A refusal in this step writes nothing, including the pending save. From here on, plan writes on this thread return `plan_busy`.
4. **Files.** Write the snapshot text to the Mcode plan file (atomic temp file and rename), so the path named in the wire text holds exactly what is sent. Then call the source adapter's `prepareImplement` with the newest agent version's native file ref, or null (Native plan files, below). Record the outcome on the row. Neither step changes plan status. A provider file is only rewritten while it still holds bytes Mcode already stores. After admission the Mcode file again equals its projection, because the accepted version is then the latest non-superseded one; a failed request re-projects it (step 7).
5. **Admit.**
   - Send through `AGENT_TURN_COMMAND_PORT` with `messageId`, `content` set to the wire text, `displayContent` set to `Implement plan v{N}`, `interactionMode: "build"`, the reservation token (thread target), and `planImplement: { requestId }`. `AgentTurnCommand` gains these fields (`agent-turn-command-port.ts:56-73`); `agent.send` already accepts a client `messageId` (`methods.ts:298`).
   - New-thread target (S07-08): admission is one `createAndSend` call (`turn-runtime-controller.ts:1976-1992`), added to the port for this caller, with `startupId = requestId`. A concurrent replay joins the same startup, and the startup record binds the thread durably (`thread-creation-coordinator.ts:124-141`). `mode` follows the source; worktree sources pass `existingWorktreePath`, which attaches to the source checkout instead of creating a managed worktree.
   - Setup for the new thread follows the one rule in `04-08f` section D. Attachment alone does not bypass Setup, because S04-07 makes attached worktrees eligible, and today's `createAndSend` returns a queued thread without admitting the turn when the gate holds it (`turn-runtime-controller.ts:1984-1990`). The new thread continues its source in the same checkout, so it skips Setup the way a branch does. The port's `createAndSend` takes a server-only option, `setupSkip: { reason: "plan-implement", sourceThreadId }`.
     - The option is a separate argument, not a field of `CreateAndSendCommand`, which `agent.createAndSend` builds by spreading wire params (`agent-rpc.ts:140-145`). No client can request it.
     - The coordinator honors it only for an `attached-worktree` start whose `existingWorktreePath` matches the non-deleted source thread's `worktree_path`, compared as `sameWorktreePath` does (`turn-admission-dispatch-coordinator.ts:372-377`). Anything else refuses the start, so the request fails and nothing is queued. The option is part of the startup fingerprint.
     - With a valid option, the coordinator skips the startup's setup step with `skipReason: "plan-implement"` and returns a `dispatch` result without calling `admitInitialAutomaticTurn`, as the branched path does (`thread-creation-coordinator.ts:581-614,664-671`). The port call therefore returns admitted or failed, never queued, and no Implement request ever waits on a Setup approval, retry, skip or queued admission.
   - New-worktree target (S07-08b): one `createAndSend` call with `mode: "worktree"`, no `existingWorktreePath`, `startupId = requestId`, and a second server-only argument, `worktreeStart: { commit: sourceCommit, branch }`, kept outside `CreateAndSendCommand` for the same reason as `setupSkip`. The coordinator creates a managed worktree on a new branch at that commit, and Setup runs as for any new worktree. When Setup holds the first turn, the port call returns queued (`turn-runtime-controller.ts:1984-1990`): the request stays `preparing`, bound to the new thread through the startup record, and `plan.implement` returns its receipt with `state: "waiting-for-setup"`. The gate later admits the queued turn, which runs step 6 like any other target.
   - The admission coordinator copies `planImplement` into the data-only parent start input next to `answeredPlanQuestionMessageId` (`canonical-parent-turn-write.ts:91-95`) and its schema (`canonical-runtime-write-operations.ts:39`). Zod strips unknown keys, so a field missing from that schema would drop the effect silently on the worker-owned path; the S07-07 tests must admit through that path.
6. **Accept inside the turn start.** The writer's start handler already projects the user message and the plan answer in the canonical start transaction (`canonical-parent-turn-write.ts:251-264`; lifecycle at `canonical-parent-turn-lifecycle.ts:78-96`; transaction at `canonical-agent-event-store.ts:115-117`). It now also runs `acceptPlanImplement`:
   - the row is `preparing` and its `messageId` equals the message being projected; a new-thread or new-worktree row binds `targetThreadId` here if it is still null, otherwise it must equal the admitting thread;
   - the source version is still `draft` or `ready` at the recorded `revision`, the same comparison step 3 made before the snapshot;
   - the version becomes `accepted` with `accepted_at`, and every other `draft` or `ready` version in the source thread becomes `superseded`;
   - the source thread's `interaction_mode` becomes build, which moves today's client switch (`threadStore.ts:3995-4004`) to the server, and `plan_phase` becomes null (whichever of S07-07 and S07-09 merges second adds this line and its test);
   - for a new thread or a new worktree, the accepted copy is inserted into the target thread (same `version` number, `captureSource: "copy"`, `baseVersionId` set to the source version);
   - the row becomes `admitted` with the turn and execution ids.

   Any failed check throws, so the user message, the turn start and Accepted roll back together.
7. **Settle.** After the port call returns or throws, read the row. The row, not the promise, decides the result.
   - `admitted`: call `reloadPlans` for the source and the target, push `plan.versionUpserted` for every touched row, and return the receipt. A provider failure after admission is an ordinary failed turn with Retry (S08F). The version stays Accepted because the message that implements it is in the transcript.
   - Still `preparing` with a new worktree's turn queued behind Setup: return the receipt with `state: "waiting-for-setup"` and keep the row and the reservation. The request settles later, when the gate admits the turn (the row turns `admitted` in step 6; call `reloadPlans`, push `plan.versionUpserted`, and release the source's `planImplement` reservation) or when the new thread's startup ends without admitting it (cancelled, failed, or the thread deleted), which takes the failure branch below. A startup observer drives that, like S04-02's `StartupAgentPhaseObserver`.
   - Still `preparing` otherwise: mark it `failed` with a conditional update (`WHERE status = 'preparing'`), so a late failure can never overwrite an admitted row. A cancelled new-thread or new-worktree startup records `startup_cancelled`. Release the reservation only if admission did not take it; release is token-checked (`thread-control-mutation-reservation-service.ts:91-96`), and a failed admission already releases its own lease (`turn-runtime-controller.ts:518-526`). Never release after success, because the running turn holds the same token. For a new thread, remove the target only if it has no messages and its startup is this request's. For a new worktree, remove it the same way with `ThreadService.delete(threadId, true)` (`thread-service.ts:119-138`), so the cleanup job also removes its checkout and its branch (`cleanup-worker.ts:336-343`). Re-project the Mcode plan file from the table, because step 4 may have written a version that is not the latest. Plan rows need no restore, because nothing changed them.
8. **Restart recovery.** At startup, after turn recovery and startup recovery (so a new thread's startup is already terminal, including a new worktree's startup that was waiting on Setup), every `preparing` row becomes `failed` with `interrupted` and gets the step 7 compensation. A client that replays the id after reconnecting receives `implement_interrupted`. The version is still implementable, and the next press is a new request.

Wire text (proposed; the bubble shows only the first line):

```text
Implement plan v2: "Tidy thread actions menu".

This is the plan the user approved. It supersedes any earlier plan or plan file, including your own. Mcode keeps this text at <plan file path>.

<contentMd>
```

Open comments are not sent with Implement, because Implement sends exactly the plan text. They stay visible on the accepted version (open question 3).

### Comments and re-anchoring (S07-06)

- **Create.** The client sends the source offsets of the selection, the quote, 32 characters of prefix and suffix, and the nearest preceding heading. CodeMirror positions are source offsets, so no mapping layer is needed.
- **Records versus draft state.** Plan comments are records in `plan_comments`. Draft state lives in the persisted composer draft that S10-11 owns, the one store for everything that rides the next message.
  - Which comments ride is S10-11's `planCommentSelection` field with its reconcile rule (`10-review-panel.md` section 7). An open, unsent comment on the latest non-accepted version rides unless it is excluded. S07-06 renders the chip from that field.
  - An unsaved comment editor is a second field that S07-06 adds and owns, so the editor survives a restart (PRODUCT.md principle 12). It follows the precedent of `selectedTextCommentEditor` (`composerDraftStore.ts:48`, parsed at `composer-draft-storage.ts:112-123`, counted at `composerDraftStore.ts:104`):

    ```ts
    // ComposerDraft, added by S07-06
    planCommentEditor?: {
      planVersionId: string;            // the version the editor is open on
      commentId: string | null;         // null for a new comment, the comment's id when editing one
      anchor: PlanCommentAnchor;        // the selection, as plan.comment.create sends it
      body: string;                     // unsaved note, at most 4000 characters, may be empty while typing
    };
    ```

    - S07-06 adds `PlanCommentEditorDraftSchema` beside `PlanCommentAnchorSchema`, writes the field in `serializeComposerDraft`, and rebuilds it in `parseStoredComposerDraft` through that schema. Stored JSON is untrusted, so an invalid field is dropped and counted in the parser's log line. `draftHasNoSendableContent` counts it, so a draft that holds only an open editor persists.
    - The editor never rides a send. Saving it calls `plan.comment.create` or `plan.comment.update`; success, Cancel, Esc and trash clear the field. A save that fails, for example `plan_read_only` because the version was accepted in another window, keeps the field and the note.
    - On load, the panel reopens the editor on `planVersionId`; versions are deleted only with their thread, which drops the draft too. If an edited comment was deleted meanwhile, the editor reopens as a new comment (`commentId: null`) on the same anchor. The note is never dropped silently.
  - After admission, S10-11 clears only the submitted draft revision. Exclusions apply to one send, and edits made while Send was in flight stay.
- **Chip.** "N plan comment(s) ×" counts the comments that ride. × excludes all of them from this send; the comments stay open in the panel.
- **Revise.** `agent.send.planCommentIds` (the ids that ride, frozen at submit) makes the server append an escaped envelope `<!-- mcode-plan-comments-v1 -->` (generalize `appendSelectedTextComments`, `selected-text-comment-append.ts:18-34`). The admission coordinator passes the ids into the data-only parent start input. The writer stamps `sent_message_id` inside the transaction that projects the user message, after checking that each comment is still open, unsent, and on the thread's latest non-accepted version. A failed check aborts admission with `plan_comment_invalid`; nothing is stamped and the draft stays.
- **New version.** When a user fork or an agent capture creates a new version, open, unsent comments of the predecessor are copied (`carriedFromCommentId`) and re-anchored.
- **Re-anchoring.** A pure function `reanchorPlanComment(anchor, newContent)` runs server-side on every save:
  1. If the old range still holds the quote, keep it.
  2. Otherwise take the quote occurrence whose prefix and suffix match best, nearest the old start.
  3. Otherwise, if the heading still exists, use `kind: "section"`.
  4. Otherwise use `kind: "section", section: null` (plan level).

  The client maps anchors optimistically with CodeMirror's `ChangeSet.mapPos`. The server result wins on push. Section comments render under their heading with no highlight.

### Plan file (S07-03)

- **Path:** `<mcodeDir>/threads/<threadId>/plan.md`. Add `resolveThreadPlanFile` next to `resolveThreadHandoffsDir` (`packages/shared/src/paths/handoffs.ts:35-40`). It is outside the worktree, so there is no git noise.
- **Content:** exactly the latest non-superseded version. It is a projection of the `plans` table, written by the version writer.
- **Writes:** on every version upsert and before every plan or Implement turn. Implement writes the exact text it sends, and a failed Implement re-projects the file from the table (Implement steps 4 and 7).
- **Passing the path:** one line in the revise, follow-up (S07-09), and Implement (S07-07) wire text. For Claude and Copilot, also issue a turn-scoped Read pre-grant (`ScopedPreGrantService.issue`, `scoped-pre-grant.ts:50-54`; prior art `handoff-coordinator.ts:322-325`). Other adapters read outside the workspace under their own rules (inferred). The inline text never depends on the file.
- **Cleanup:** remove the directory when the thread is deleted (inferred: reuse the handoff cleanup path).

### Provider plan capture

S07-01 adds the boundary types that later tickets fill. One adapter-boundary event replaces `exit_plan_mode` (`interfaces.ts:228-229`):

```ts
// packages/providers interfaces (S07-01)
on(event: "plan_captured", handler: (p: {
  threadId: string; markdown: string; source: "native" | "fence";
  nativePlanFile?: NativePlanFileRef;   // only when the provider's own event names the file for this session
}) => void): void;

interface TurnRequest {
  // existing fields
  planTurn?: { kind: "questions" | "planning" | "revise"; planFilePath: string | null };   // filled by S07-09
}

/** A provider-owned plan file tied to one session by the provider's own event. Never sent to clients. */
interface NativePlanFileRef { path: string; sessionId: string; sha256: string }

interface IAgentProvider {
  /** Rewrites or deletes the provider's own plan file before Implement. Absent means skipped with "no-file". */
  prepareImplement?(input: {
    threadId: string; markdown: string; nativePlanFile: NativePlanFileRef | null;
  }): Promise<NativePlanFileOutcome>;
}
```

Every adapter gets the same fallback. The planning prompt asks for a one or two sentence summary and the full plan inside a four-backtick fence, ` ````mcode-plan `. Four backticks let the plan contain ordinary three-backtick code fences. A new `PlanFenceParser` closes only on a fence line at least as long as the opener. The renderer hides `mcode-plan` while it streams. Native capture wins when both arrive.

### Native plan files

- **Proof of ownership.** An adapter sets `nativePlanFile` only when the provider's own event or response for this session names one exact path. A directory watch, a glob, or "the newest file in the folder" is not proof. Another session can write to the same folder during the turn, and a reported path is external input.
- **Validation at capture.** The path is absolute. Its `realpath` lies inside the plan root this adapter declares for this session. `lstat` shows a regular file, not a symlink. The size is within `PLAN_MAX_CONTENT_CHARS`. The adapter hashes the bytes it read. The server stores the ref on the agent version, server-side only.
- **Mutation before Implement.** `prepareImplement` repeats the validation and re-hashes. It changes the file only when the hash still equals the captured hash. It then overwrites through a temp file and rename in the same directory, or deletes an in-worktree file. Any other result returns `skipped` with its reason and touches nothing. Nothing is ever deleted by pattern.
- **Honest fallback.** `skipped` is not fatal. Implement still sends the authoritative inline text, which supersedes any plan file. The outcome is stored on the request, returned in the receipt, and shown on the accepted version as a muted line, "{Provider}'s own plan file was left unchanged" (proposed copy, no board; open question 13).
- **One helper.** `packages/providers/src/plan/native-plan-file.ts` owns validation, hashing and the atomic write, so adapters do not copy path checks.

S07-00 decides which rows below are buildable. A cell it cannot prove ships as fence capture with `skipped: unproven` and no native file mutation.

| Provider | Decision | Native plan file before Implement | Risk |
|---|---|---|---|
| Claude | Run `questions`, `planning`, and `revise` turns with SDK `permissionMode: "plan"`. Capture `ExitPlanMode.plan` and keep denying the tool with "captured". Remove `setPlanAnswerMode`. Full access stays bypass for build turns. | Rewrite `~/.claude/plans/<file>.md` only if S07-00 shows an event that names this session's file; otherwise `skipped: unproven`. | Medium |
| Codex | Send `collaborationMode: { mode: "plan" }` on plan turns, with `developer_instructions` null and Mcode context in `additionalContext` (T3 Code model). The completed `plan` item's `text` is authoritative, so emit `plan_captured(native)`. `item/plan/delta` no longer becomes thinking text. `requestUserInput` feeds the question dock in the same ticket (S07-02). Send `default` explicitly on the next build turn. Native mode is on only for CLIs at or above the minimum S07-00 measures (0.37.0 is too old, inferred); older CLIs keep the fence and Mcode's question prompt. | None (the plan lives in the conversation); `prepareImplement` is absent. | **Highest**: experimental field, version gate, new server request. |
| Cursor | Capture `cursor/create_plan`, but stop answering `accepted` (`cursor-acp-client-bridge.ts:191`). Answer with the non-accepting outcome S07-00 captured, so the plan waits for Mcode review. Fix the fixture validator to the key Cursor sends (`fixture-safety.ts:345`). | Rewrite or delete a plan file only if the request names it for this session and it lies inside the worktree. Never `.cursor/plans/*` by pattern; home-folder plans stay untouched. | Medium-high: undocumented response semantics. |
| Copilot | Keep `mode.set("plan")` for every plan turn. Allow the write to this session's `session-state/<sessionId>/plan.md` only, in the plan-mode policy (`copilot-provider.ts:510`). Capture through an SDK plan event if S07-00 finds one in `^0.2.2`, otherwise read that file at turn end. The SDK bump needs a measured decision. | Overwrite this session's `plan.md` after the hash check. The adapter holds the session id, so identity is provable if S07-00 confirms the directory name is that id. | High: SDK version. |
| Devin | Keep `mode=plan` for every plan turn. Capture a plan file only when an event names it for this session; otherwise the fence. | Overwrite the named file after the hash check; otherwise `skipped: unproven`. | Medium: per-session file identity unknown. |
| OpenCode | Send `agent: "plan"` on plan turns if S07-00 confirms the field on `prompt_async`. Capture the `.opencode/plans` file an event names for this session; otherwise the fence. | Delete the named in-worktree file after the hash check. An unproven file stays and shows in git status (risk 15). | Medium |

Gemini appears in `ProviderIdSchema` (`settings.ts:63`) but is not one of the six adapters in scope: no change.

**Read-only.** A provider's Plan becomes read-only only when all of its plan turns run in a native plan mode that S07-00 measured: Claude (S07-12), Codex (S07-02), Copilot and Devin (S07-13, S07-14), and OpenCode (S07-14). Cursor stays unclaimed until its ACP plan mode is measured. Until then, no UI copy says "read-only".

## Components

### New

- **`PlanPanelHeader`** (`apps/web/src/components/panels/plan/`): version picker, Implement split (F-03), expand, toggle. Row 1 of F-05.
- **`PlanVersionPicker`**: names-only menu (F-04), newest first. Each item is `vN` plus a muted word: "Edited by you" (user draft), "Accepted", the provider name (agent ready), or "Older version" (superseded). Only "Edited by you" and "Accepted" are drawn; the rest are proposed.
- **`PlanImplementSplit`**: label "Implement v{N}" for the version on screen. Amber only when no open, unsent comments. Shown only for `draft` and `ready` versions; hidden for accepted and superseded ones. Its menu holds "Implement v{N}", "Implement v{N} in a new thread" and, in a git project, "Implement v{N} in a new worktree" (S07-08b).
- **`PlanEditor`**: CodeMirror 6 with `@codemirror/lang-markdown` and live-preview decorations that hide markdown syntax except on the focused line (the Obsidian pattern). Styled to the board's document values. It is editable only on the thread's latest version while that version is `draft` or `ready`. Every other version renders read-only, as does any version while a turn runs or an Implement is preparing. Proposed new dependency (open question 10).
- **`PlanCommentLayer`**: highlight marks, comment rows, and the new and editing editor states (Enter saves, Esc cancels).
- **`PlanCommentsComposerChip`**: "N plan comment(s) ×" in the composer attachment row, reading its selection from the S10-11 composer draft.
- **`QuestionDock`**: the 07b dock in the composer slot. It shares the pending-dock surface with S06.
- **`usePlanCommands(threadId)`**: registers the palette commands `plan.implement`, `plan.implementInNewThread` and, in a git project, `plan.implementInNewWorktree` (S07-08b), titled "Implement v{N}", "Implement v{N} in a new thread" and "Implement v{N} in a new worktree" (`command-registry.ts:19`). The target is the version on screen while the Plan panel is open, and the newest `draft` or `ready` version while it is closed. The commands and the `planImplementable` keybinding context exist only while that target is implementable, so the shortcut does nothing while the panel shows an accepted or superseded version. The request carries the target's revision from `planStore`.
- **Web `lib/plan-fences.ts`** (S07-01): the one list of fences the renderer hides (`plan-questions`, `mcode-plan`, and the legacy `plan-output`) and the one strip function the bubble's emptiness check uses. The legacy entry is a bounded read transform: it hides a fence whose info string is exactly `plan-output`, never parses its JSON, and has no writer anywhere.
- **Server:** `PlanService`, `PlanFenceParser`, `reanchorPlanComment`, `PlanFileWriter`, `legacy-plan-record.ts`, and the writer-side `acceptPlanImplement` effect.
- **Providers:** `plan/native-plan-file.ts` (validation, hashing, atomic rewrite).
- **Shared:** `resolveThreadPlanFile`.

### Changed

- **`ThreadOverview` plan row**: doc icon, title with fade, trailing `vN` or the task progress of the Implement turn. Clicking opens the Plan panel and closes the overview. "No structured plan" is open question 4.
- **`PlanPanel`**: snapshot-driven shell: header plus editor plus comment layer, plus the draft conflict notice (S07-05).
- **`planStore`**: holds versions, comments, and phase per thread from `plan.snapshot` and pushes. Drops preview and generating state. The auxiliary hydrator reads `plan.snapshot` instead of `plan.list` (`auxiliary-hydrator.ts:218-230`).
- **Composer.** Plan chip neutral, as a toggle. Placeholder "Tell {Provider} what to change" in `ready`. Ctrl+Shift+Enter is intercepted at critical priority before Lexical inserts a line break (`KeyboardPlugin.tsx`). Send is amber when the chip is present. The access chip goes icon-only under about 560px if the composer section has not delivered it.
- **`MessageBubble` and `MarkdownContent`**: read hidden fences from `lib/plan-fences.ts` instead of their own `plan-output` checks.
- **`AnsweredSummary`**: restyled as the "✓ Answered N questions" receipt.
- **Status line** (S05/S06 owner): "Waiting for your answers" when `plan_phase = questions`; "Planning" for `planning`.
- **Sidebar row** (S01 model): `questions` maps to "Answers required" and `ready` maps to "Plan ready". Opening a Plan ready thread opens the Plan panel (`screen-pass-todo.md:46`).
- **`default-keybindings.json`**: add `{ "key": "mod+shift+enter", "command": "plan.implement", "when": "planImplementable" }`.
- **`PlanTurnService`**: `classify`, the new prompts, `plan_captured` handling, `plan_phase` transitions.
- **Dispatch coordinator**: uses the plan kind instead of `planAction` (`turn-admission-dispatch-coordinator.ts:715-716,802-803,858-880`) and copies `planImplement` and `planCommentIds` into the parent start input.
- **Turn start writer**: `DataOnlyParentTurnStartInput` and `CanonicalRuntimeParentStartSchema` gain `planImplement` (S07-07) and `planCommentIds` (S07-06).
- **`AgentTurnCommand` and its port**: `messageId`, `displayContent`, `interactionMode`, `mutationReservationToken`, `planImplement`, and `createAndSend` for the new-thread path.
- **`ThreadControlMutationReservationService`**: a `planImplement` state for the source thread of an Implement in a new thread.
- **Provider adapters**: per the table above, within what S07-00 proves.
- **Docs**:
  - Rewrite CONTEXT.md: "Plan mode" (`:181-186`), the Overview Plans paragraph (`:776-778`), "Plan tab" (`:856-860`), the "/plan except Copilot" line (`:1283-1284`); delete "Plan preview" (`:862-871`).
  - Add an ADR (next free number at merge) "Mcode's plan record is the source of truth".
  - Add `docs/internals/conversation/plan-records.md` (write ownership, admission coupling, native file proof).

### Retirement ledger

Wave rule: S07-04 through S07-07 replace the panel as a set. They ship in one release with no release between them, so the old panel and the new panel never coexist.

Historic messages keep their `plan-output` fences. The ledger retires every writer of that fence and the scattered renderer checks, not the ability to read stored messages; `lib/plan-fences.ts` keeps that one bounded read transform.

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| JSON plan contract `PlanOutputSchema`, `PlanSectionSchema` | `contracts/src/models/plan-output.ts:4-36` | ` ````mcode-plan ` fence | S07-01 | `rg -n "PlanOutputSchema\|PlanSectionSchema" apps packages` prints nothing |
| Every server and contract `plan-output` writer or reader: `PlanOutputParser` and its test, the prompt's JSON fence, the Codex live `plan-output` intent, the `plan-output.ts` file name | `planning/plan-output-parser.ts`, `plan-question-service.ts:136-161`, `codex-live-event-reducer.ts:83,355`, `codex-live-event-effects.ts:104`, `contracts/src/models/plan-output.ts` | `PlanFenceParser`, `plan_captured`, `contracts/src/models/plan.ts` | S07-01 | `rg -n "plan-output\|PlanOutputParser" apps/server/src packages` prints nothing |
| Prompt asking for plan prose in chat | `plan-question-service.ts:136-161` | Summary-plus-fence instructions | S07-01 | `rg -n "read it in the chat" apps` prints nothing |
| Heading scrape of arbitrary assistant messages | `plan-execution-state.ts:93-95` | Explicit capture or `no_plan` | S07-01 | `bun run --cwd apps/server test -- src/features/agents/planning/__tests__/plan-execution-state.test.ts` passes, including a case where a prose-only reply with headings yields no version |
| Provider event `exit_plan_mode`, `emitExitPlanMode`, `planExits` | `interfaces.ts:228-229`, `cursor-acp-client-bridge.ts:51,184`, `cursor-provider.ts:270`, `server-bootstrap.ts:670-675`, `conformance/harness.ts:174-228` | `plan_captured` | S07-01 | `rg -n "exit_plan_mode\|emitExitPlanMode\|planExits" apps packages` prints nothing |
| Scattered `plan-output` checks in renderer components | `MessageBubble.tsx:41-42`, `MarkdownContent.tsx:498` | `lib/plan-fences.ts` (bounded legacy reader, also hides `mcode-plan`) | S07-01 | `rg -n "plan-output" apps/web/src/components apps/web/src/features --glob '!**/__tests__/**'` prints nothing; `bun run --cwd apps/web test -- src/lib/__tests__/plan-fences.test.ts` proves historic messages still hide the JSON |
| Cursor fixture key `markdown` | `fixture-safety.ts:345` | The key Cursor sends, per the S07-00 capture (expected `plan`) | S07-01 | `bun run --cwd packages/providers test -- src/conformance/__tests__/conformance.test.ts` passes with the captured Cursor plan fixture |
| `PlanRecordSchema`, `PlanSectionNavSchema`, 3-state `PlanStatusSchema` | `plan-output.ts:16-70`, moved to `plan.ts` by S07-01 | `PlanVersionSchema`; old canonical items read by `legacy-plan-record.ts` | S07-03 | `rg -n "PlanRecordSchema\|PlanSectionNavSchema\|PlanStatusSchema" apps packages --glob '!**/legacy-plan-record.ts'` prints nothing |
| Columns `sections_json`, `change_summary`; NOT NULL `message_id` | `schema.ts:972-994` | Migration that rebuilds `plans` | S07-03 | `rg -n "sections_json\|change_summary" apps/server/src --glob '!**/__tests__/**'` prints nothing |
| RPCs `plan.list` and `plan.updateStatus`; the `plan.updateStatus` writer operation; canonical `updatePlanStatus`; unused `planStore.updatePlanStatus` | `methods.ts:1140-1152`, `agent-rpc.ts:171-175`, `plan-write-operations.ts:10`, `agent-storage-write-handlers.ts:89`, `canonical-accepted-progress.ts:266-290`, `planStore.ts:40,122-131` | `plan.snapshot`; server-owned transitions | S07-03 | `rg -n "plan\.list\b\|plan\.updateStatus\|updatePlanStatus" apps packages` prints nothing |
| Push `plan.generated` | `channels.ts:201-205`, `ws-events.ts:607-617`, `canonical-accepted-progress.ts:223`, `plan-turn-service.ts:168` | `plan.versionUpserted` | S07-03 | `rg -n "plan\.generated" apps packages` prints nothing |
| `PlanPreview`, `ComposerPlanPreview`, preview state in `planStore` | `PlanPreview.tsx`, `ComposerContentSurface.tsx:155-170,701`, `Composer.tsx:304,400`, `planStore.ts:15-31,71-104` | Overview plan row | S07-04 | `rg -n "PlanPreview\|showLivePreview\|dismissLivePreview\|clearLivePreview" apps/web/src` prints nothing |
| `PlanChrome` (amber Implement, Revise, revision popover) and its test | `PlanChrome.tsx` | `PlanPanelHeader` | S07-04 | `rg -n "PlanChrome" apps/web/src` prints nothing |
| `PlanVersionBanner`, `PlanFeedbackBar`, `PlanSkeleton`, `generatingThreads` | `PlanPanel.tsx:42-55,175-177`, `PlanSkeleton.tsx`, `planStore.ts:13,36-37,114-120` | Version picker, `plan_phase = planning` | S07-04 | `rg -n "PlanSkeleton\|PlanFeedbackBar\|PlanVersionBanner\|generatingThreads" apps/web/src` prints nothing |
| `PlanDocument` (react-markdown, clickable headings) and its test | `PlanDocument.tsx` | `PlanEditor` | S07-04 | `rg -n "PlanDocument" apps/web/src` prints nothing |
| `PlanAnnotation` (one note per heading) | `PlanAnnotation.tsx` | Plan comments (S07-06, same wave) | S07-04 | `rg -n "PlanAnnotation" apps/web/src` prints nothing |
| Composer "Plan" panel button | `ComposerOptionControls.tsx:108-166` | Overview row, sidebar, `mod+t`, ⌘K | S07-04 | `rg -n "useComposerPlanPanel\|togglePlanPanel" apps/web/src` prints nothing |
| Overview "Plans" row (ListChecks, "Plans" label) | `ThreadOverview.tsx:2655-2676` | "title · vN" row | S07-04 | `rg -n "Plans</span>" apps/web/src` prints nothing |
| CONTEXT "Plan preview", overview Plans paragraph, Plan tab blurb "Read saved plans" | `CONTEXT.md:776-778,862-871`, `panel-tabs.ts:108` | Rewritten entries | S07-04 | `rg -n "Plan preview\|Read saved plans" CONTEXT.md apps/web/src` prints nothing |
| `planAction: "implement"`, `PlanPanel.handleImplement`, the client build switch | `PlanPanel.tsx:156-173`, `threadStore.ts:3995-4004` | `plan.implement` | S07-07 | `rg -n "\"implement\"" apps/web/src/stores/threadStore.ts` prints nothing |
| `planAction` (all), `PlanActionSchema`, `sendPlanAction`, revise and feedback handlers | `methods.ts:343-347`, `plan-output.ts:50-52`, `threadStore.ts:472,3986-4023`, `PlanPanel.tsx:119-154`, coordinator `:715-716,802,872-880` | `PlanTurnService.classify` | S07-09 | `rg -n "planAction\|sendPlanAction\|PlanActionSchema" apps packages` prints nothing |
| `PlanQuestionWizard`, `OptionTile`, `AcceptRecommended`, `useWizardKeyboard`, and the mount | `components/chat/PlanQuestionWizard.tsx`, `plan-questions/*`, `ChatViewSurface.tsx:660` | `QuestionDock` (keyboard handling moves into it) | S07-09 | `rg -n "PlanQuestionWizard\|AcceptRecommended\|OptionTile" apps/web/src` prints nothing |
| Claude `setPlanAnswerMode` and `planAnswerThreads` | `plan-turn-service.ts:23-25,151-156`, `claude-provider.ts:544-545,2861-2878`, `factory-types.ts:56` | `TurnRequest.planTurn` | S07-12 | `rg -n "setPlanAnswerMode\|planAnswerThreads" apps packages` prints nothing |
| Codex plan delta as thinking text | `codex-event-mapper.ts:1978-1982` | Native capture | S07-02 | `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts` passes, including a case where a plan delta in a plan turn produces no `TextDelta` |
| Cursor `create_plan` auto-accept | `cursor-acp-client-bridge.ts:191` | The non-accepting outcome from S07-00 | S07-13 | `rg -n 'outcome: "accepted"' packages/providers/src/private/cursor/acp/cursor-acp-client-bridge.ts` prints nothing |
| Amber Plan chip classes | `ComposerCapabilityChip.tsx:30-32` | Neutral toggle chip | S07-11 | `rg -n "ring-primary/30\|text-primary" apps/web/src/components/chat/ComposerCapabilityChip.tsx` prints nothing |
| Floating `SlashCommandPopup` container | `components/chat/SlashCommandPopup.tsx` | Attached slash tray (all slash commands; confirm with the composer owner) | S07-11 | `rg -n "SlashCommandPopup" apps/web/src` prints nothing |

## Proposed tickets

### S07-00 Plan protocol investigation across six providers

- **Blocked by:** None (can start immediately).
- **Reconciled:** Bounded protocol investigation for all six providers before plan capture: captured request and response evidence for native plan output, questions, plan-file identity and minimum supported versions. Its findings decide which native paths S07-02 and S07-12 to S07-14 promise.
- **Boards:** none drawn for the investigation; its findings shape 07b `27YA-2`, 07c `26BG-2` and 07d `26L9-2`.
- **Delivers:** A decision table, backed by captured request and response evidence, that says for each provider which plan capabilities are native, fence-only, unsupported, or unknown, and from which CLI or SDK version. S07-02 and S07-12 through S07-14 promise only what this table proves. No product behavior changes.
- **Build notes:**
  - **Bound.** Answer only the questions below. Timebox: half a day per provider, three days in total. A question still open at the timebox is recorded `unknown`, which the consumer tickets treat as fence capture with no native file mutation.
  - **Questions.**

    | Provider | Native plan output | Native questions | Plan-file identity | Version |
    |---|---|---|---|---|
    | Claude | Does SDK `permissionMode: "plan"` deliver the full plan in `ExitPlanMode`? | Does a native question tool appear in plan mode? | Does any event name the plan file Claude writes for this session? | Minimum SDK version for plan mode as used. |
    | Codex | Exact `collaborationMode` shape on `turn/start`; the completed `plan` item and its deltas. | `requestUserInput` request and response shapes, free text, decline or cancel, behavior on `turn/interrupt`, and behavior when the app-server exits while a request waits. | None expected; confirm. | Minimum app-server or CLI version for each. |
    | Cursor | `cursor/create_plan` params (`plan` or `markdown`); every non-accepting outcome and what the agent does after each. | `ask_question` shape in plan turns. | Does the request name a plan file and its session? | ACP and CLI version. |
    | Copilot | Does SDK `^0.2.2` expose a plan event? | Native question events, if any. | Is the session-state directory name the session id the adapter holds? What permission request does the `plan.md` write raise? | SDK version needed. |
    | Devin | What `mode=plan` through `set_config_option` changes. | Native question events, if any. | Does any event name the plan file for this session? | CLI version. |
    | OpenCode | Does `prompt_async` accept `agent: "plan"`, or which field selects the plan agent? | Native question events, if any. | Does any event or API name the `.opencode/plans` file for this session? | Server version. |
    | All six | Does the provider reproduce a four-backtick `mcode-plan` fence verbatim when the prompt asks for it? | | | |

  - **Method.** Drive each CLI or SDK directly against `.dev/fixture-repo` with an isolated provider home under `.dev/provider-homes/<provider>/` (for example `CODEX_HOME` or `CLAUDE_CONFIG_DIR`; find each CLI's override), so plan files never land in the user's home. If a CLI cannot authenticate from an isolated home without copying credentials, stop and ask the user. Do not copy secrets, sign in or out, or install or update a global CLI. Use a scratch prefix for any other CLI version.
  - **Evidence.** Save each protocol trace as a sanitized conformance fixture with `provenance: "captured"`, the exact `cliVersion` and `protocolVersion`, and a reviewed redaction (`fixture-safety.ts:104-132`; prior art `codex-core.captured.json`). File-system observations that a fixture cannot hold go into the research note with the commands that produced them.
  - **Output.** A point-in-time note, `docs/research/plan-provider-protocols.md` (prior art `docs/internals/providers/codex-app-server-trace.md`), with one row per provider and capability that records native, fence-only, unsupported, or unknown, the minimum version, and the evidence file. Before S07-02 and S07-12 to S07-14 start, copy the applicable row into each of their issues.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] Every cell of the decision table holds a value with an evidence link, or `unknown` with the timebox reason.
  - [ ] Each native claim cites a captured fixture or trace from the stated version.
  - [ ] Plan-file identity is marked proved only where the evidence ties one exact path to one session.
  - [ ] Plan files written by the probes exist only under `.dev/provider-homes/` or `.dev/fixture-repo`; no global configuration changed.
- **Verify:** `bun run --cwd packages/providers test -- src/conformance/__tests__/conformance.test.ts` validates the new captured fixtures. A second agent reproduces one row per provider from the note's commands.

### S07-01 Plan capture seam with a fenced fallback for all six providers

- **Blocked by:** S07-00 Plan protocol investigation across six providers.
- **Boards:** 07c `26BG-2`, 07d `26L9-2`
- **Delivers:** For every provider, a Plan-mode planning turn yields a plan version: native where it is already wired (Claude `ExitPlanMode`, Cursor `create_plan`), the fence everywhere else. The chat shows only a short summary, never the plan. A turn that yields nothing produces an explicit `missing` outcome that is logged and unit-tested; S07-09 persists it as `no_plan`. Historic messages that carry the old `plan-output` fence still render without their JSON.
- **Build notes:**
  - Contracts: rename `plan-output.ts` to `plan.ts`, delete the JSON fence schemas, and keep the record schemas unchanged until S07-03 replaces them.
  - Provider interfaces: the `plan_captured` event, plus the signatures that later tickets fill (`TurnRequest.planTurn`, `NativePlanFileRef`, `NativePlanFileOutcome`, and the optional `prepareImplement`; see Provider plan capture). No adapter implements `prepareImplement` and nothing sets `planTurn` yet.
  - Server: `PlanFenceParser`, which handles chunk boundaries and the longer closing-fence rule. Rewrite the planning instructions. `PlanExecutionState` drops the JSON parser and the arbitrary-message scrape, and takes the title from the first H1. Keep filling `sectionsJson` from headings until S07-03 drops it. Remove every server-side `plan-output` reader and writer, including the Codex live intent (`codex-live-event-reducer.ts:83,355`, `codex-live-event-effects.ts:104`). Reword the comments that still name the JSON fence (`features/agents/index.ts:7`, `turn-finalizer.ts:119`, `methods.ts:344`, `virtual-items.ts:14`), so the ledger searches come back empty.
  - Web: `lib/plan-fences.ts` replaces the checks in `MessageBubble.tsx:39-44` and `MarkdownContent.tsx:498`. It hides `plan-questions`, `mcode-plan` and the legacy `plan-output` by exact info string and never parses fence content.
  - Providers: rename the emitters, and set the Cursor fixture key to what the S07-00 capture shows.
- **Deletes:** the first seven ledger rows (through the Cursor fixture key).
- **Acceptance criteria:**
  - [ ] Each synthetic conformance fixture (claude, codex, copilot, cursor, opencode) asserts one plan capture. Devin is covered by a mapper-seam unit test because it has no fixture.
  - [ ] A plan with nested triple-backtick code blocks parses intact.
  - [ ] The streamed fence never renders in the chat.
  - [ ] A prose-only reply creates no version.
  - [ ] A historic stored assistant message with prose plus a `plan-output` JSON fence renders the prose and no JSON; a message that is only that fence leaves no empty bubble.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/planning/__tests__/plan-turn-service-output.test.ts src/features/agents/planning/__tests__/plan-execution-state.test.ts` (add `plan-fence-parser.test.ts`). `bun run --cwd packages/providers test -- src/__tests__/claude-factory.test.ts src/private/cursor/acp/__tests__/cursor-create-plan.test.ts src/conformance/__tests__/conformance.test.ts`. `bun run --cwd apps/web test -- src/lib/__tests__/plan-fences.test.ts src/features/conversation/messages/__tests__/MessageBubble.test.tsx`. Live (Electron, `.dev/fixture-repo`): with Codex and Claude in Plan mode, answer the questions; the chat ends with a 1-2 sentence summary and the overview shows the plan row. Open an older thread that used the JSON fence; no JSON shows.

### S07-02 Codex native plan mode: `collaborationMode`, the plan item, and `requestUserInput` questions

- **Blocked by:** S07-01 Plan capture seam with a fenced fallback for all six providers; S07-09 Plan-mode conversation: question dock, Planning, revise follow-ups, sidebar states.
- **Boards:** 07b `27YA-2`, 07c `26BG-2`, 07d `26L9-2`
- **Delivers:** On Codex CLIs that S07-00 proved, planning and revise turns run in Codex's plan collaboration mode. The plan comes from Codex's own plan item. Codex asks its own clarifying questions in the same dock, and answers resume the same turn. Stop and Dismiss always settle a waiting question. The next build turn explicitly returns to default mode. Older CLIs keep the fence and Mcode's question prompt.
- **Build notes:**
  - **Activation.** Native mode turns on only when the CLI is at or above S07-00's minimum and this ticket's question handler is present. Both ship in this ticket; there is no path that sends `collaborationMode: plan` without the handler. Record the minimum next to `CODEX_MIN_VERSION` (`codex-provider.ts:98`).
  - **Turn start.** `TurnStartParams.collaborationMode` and `additionalContext` (`codex-types.ts:163-180`), chosen from `TurnRequest.planTurn`.
  - **Capture.** Map the completed `plan` item to `plan_captured(native)` (`codex-event-mapper.ts:67-70`). Plan deltas stop producing text (`codex-event-mapper.ts:1978-1982`). Send `default` explicitly on the first build turn after a plan turn.
  - **Questions.** Handle the `requestUserInput` server request in the shape S07-00 captured. Map it to a plan-question batch (header becomes category) and reuse the existing batch record and `plan.questions` push (inferred fit: `plan_question_answers`, `schema.ts:955-970`). The adapter holds the JSON-RPC responder keyed by thread and request id. Reply `{ answers: { [id]: { answers: [...] } } }` or the captured equivalent. Prior art for server requests: `codex-app-server-approval.test.ts`.
  - **Renderer reconnect is not a provider restart.**
    - A thread switch, window reload or renderer reconnect leaves the Mcode server and the Codex app-server running. The batch restores from its record, the responder is still pending, and an answer reaches Codex.
    - A Codex app-server exit or an Mcode server restart drops the JSON-RPC request with its connection. A persisted question cannot bring it back. Settle the batch as expired, end the turn through the normal interrupted path, and show the receipt "Questions expired" (proposed copy). The dock never offers an answer that cannot be delivered.
  - **Cancellation.** Stop while the dock is open sends the protocol's cancel response if S07-00 found one, then interrupts the turn, and settles the batch as dismissed. Dismiss sends the decline response if S07-00 found one; otherwise Dismiss interrupts the turn.
  - On native CLIs, the Mcode question prompt is no longer used for Codex.
- **Deletes:** the Codex plan-delta-as-thinking ledger row.
- **Acceptance criteria:**
  - [ ] A captured fixture with a plan item creates one version with `captureSource: "native"`.
  - [ ] An old CLI falls back to the fence and Mcode's question prompt, and never sends `collaborationMode`.
  - [ ] The build turn after Implement carries `mode: "default"`.
  - [ ] A captured fixture round-trips one question, including the user's own free-text answer.
  - [ ] A window reload while a question waits keeps it answerable, and the answer resumes the same turn.
  - [ ] An app-server exit while a question waits marks the batch expired and ends the turn interrupted; no answerable dock remains.
  - [ ] Stop and Dismiss while a question waits each leave no pending request.
- **Verify:** `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts src/__tests__/codex/codex-app-server-approval.test.ts src/__tests__/codex/codex-provider-lifecycle.test.ts` (add question cases beside the approval cases). Live: run a Codex Plan thread in the fixture repo, reload the window while a question waits, answer it, and confirm no "Thought" row contains plan text.

### S07-03 Plan record v2: durable versions, autosave, snapshot, and writer coordination

- **Blocked by:** S07-01 Plan capture seam with a fenced fallback for all six providers.
- **Reconciled:** Narrowed: durable versions, save and snapshot, writer coordination and one working read consumer. Comment operations and re-anchoring move to S07-06, the Implement operation to S07-07, plan-phase classification to S07-09. `planTurn` and `prepareImplement` signatures are set in S07-01.
- **Boards:** 07e `26TN-2`
- **Delivers:** Backend prefactor. Agent and user versions persist with authorship and the four statuses. `plan.saveVersion` autosaves user drafts against a server revision. `plan.snapshot` replaces `plan.list`, and the existing panel reads it. The Mcode plan file mirrors the latest version. Old plan rows and old canonical plan items still load.
- **Build notes:**
  - The `plans` rebuild migration; `PlanVersionSchema` in `plan.ts`; `plan.snapshot` (versions only), `plan.saveVersion`, and the `plan.versionUpserted` push.
  - `PlanService.saveVersion` and `snapshot` as allowlisted writer operations with the in-transaction busy and revision rules (Write ownership and serialization; Draft autosave).
  - Agent capture supersedes `draft` and `ready`, never `accepted`, and records author, provider, capture source and the server-only native file ref.
  - `CanonicalAcceptedProgress.reloadPlans` with the monotonic status merge; `plan.snapshot` uses the same merge.
  - `legacy-plan-record.ts` for old canonical plan items.
  - `PlanFileWriter` and `resolveThreadPlanFile`.
  - One read consumer: the auxiliary hydrator and `planStore` load `plan.snapshot` and map it into the existing panel until S07-04 replaces it.
  - The plan-record ADR and `docs/internals/conversation/plan-records.md`.
  - Comments, Implement, and `plan_phase` are not in this ticket (S07-06, S07-07, S07-09).
- **Deletes:** the ledger rows from `PlanRecordSchema` through `plan.generated`.
- **Acceptance criteria:**
  - [ ] Migration test: the legacy `draft` row becomes `ready`/`agent` at revision 0; unique `(thread_id, version)` holds.
  - [ ] A database with legacy rows and legacy canonical plan items in the event log loads, and `plan.snapshot` lists them as `ready`.
  - [ ] A save while the thread has an unfinished execution returns `plan_busy`.
  - [ ] After a user save, the next agent capture numbers past it, and `plan.snapshot` lists both. A fork made right after a planning turn ends bases on the agent's new version.
  - [ ] A save with `baseRevision` equal to the stored revision returns revision + 1. A higher `baseRevision` returns `plan_conflict` with the latest version and changes nothing. So does a lower one, except the lost-response replay: `baseRevision` one below the stored revision with identical text returns the stored row unchanged.
  - [ ] Repeating a fork with the same `versionId` after a lost response returns the same draft and creates no second version.
  - [ ] Two windows that fork one ready version with different `versionId`s create one draft; the second gets `plan_conflict`. Of two saves sent with the same `baseRevision`, exactly one lands.
  - [ ] A save that names another window's draft id at its current revision lands as revision + 1 (the Keep my text request).
  - [ ] A user fork leaves its ready base `ready`; an agent capture supersedes both.
  - [ ] After `reloadPlans` with a head present, a status already later in memory is never moved back.
  - [ ] The plan file holds the latest version after every upsert.
- **Verify:** `bun run --cwd apps/server test -- src/runtime/persistence/sqlite/__tests__/database-migration-success.test.ts src/features/agents/canonical/__tests__/canonical-plan-live-projection.test.ts src/features/agents/transport/__tests__/agent-rpc-route.test.ts`, plus a new `src/features/agents/planning/__tests__/plan-service.test.ts` on real SQLite (prior art `planning/persistence/__tests__/plan-question-answers-repo.test.ts`).

### S07-04 Plan in the thread overview and the Plan panel read view

- **Blocked by:** S07-03 Plan record v2: durable versions, autosave, snapshot, and writer coordination; S03-02 Overview card shell; F-02 Fade truncation primitive; F-04a Menu primitive; F-05 Right panel shell: two-row header, right-edge rail, panel controls.
- **Boards:** 07d `26L9-2`, 07e `26TN-2`, 07g state 3 `2CWX-2`
- **Delivers:**
  - The overview row "title · vN" opens the Plan panel and closes the overview.
  - The panel header shows the version picker, expand, and toggle.
  - The document renders read-only at board typography in `PlanEditor`.
  - Accepted reads "vN Accepted" with no button.
  - At narrow widths the access chip is icon-only.
- **Build notes:** `planStore` fed by `plan.snapshot` and pushes. `PlanEditor` in read-only mode (CodeMirror 6). Picker menu on F-04. The plan file path is not shown in the UI.
- **Deletes:** the ledger rows from `PlanPreview` through the CONTEXT and blurb rewrite. Ships in the S07-04..07 wave.
- **Acceptance criteria:**
  - [ ] No plan prose in the chat. The overview row appears only when a version exists.
  - [ ] Picking an older version shows it read-only.
  - [ ] `mod+t` still toggles the panel.
- **Verify:** Rewrite `PlanPanel.test.tsx` and `planStore.test.ts`. Live: Electron at 1440, open a thread with a plan, click the overview row; the layout is 304 | 552 | 536 | 48 and the header matches 07e.

### S07-05 Live-preview editor: the first change creates "Edited by you"

- **Blocked by:** S07-04 Plan in the thread overview and the Plan panel read view.
- **Boards:** 07e `26TN-2` (step 4 focused)
- **Delivers:** Clicking into the plan and typing works. The focused line shows raw markdown. The first change creates vN+1 "Edited by you". Later edits autosave into it. An edit made in another window never silently replaces this window's text; the user chooses. The editor is editable only on the latest draft or ready version, and read-only while a turn runs or an Implement is preparing.
- **Build notes:**
  - Client half of Draft autosave. Mint `versionId` once at the first change; debounced `plan.saveVersion` (500 ms, proposed) with one save in flight per thread; coalesce newer text; resend the identical payload after a lost response.
  - Flush on blur, panel close, thread switch, and before Implement (Implement carries the pending text in its request instead of saving it separately).
  - `plan_conflict` keeps the local text and shows the conflict notice ("Keep my text", "Use saved version"; open question 14). Keep my text adopts the returned draft's id and revision, or forks a returned ready version with a new id, then saves the retained text; it is not offered when the latest version is accepted (Draft autosave). Never reload over unacknowledged text.
  - Decorations for headings, ordered lists (20 wide mono number column), inline code, and file-path list items (name ink, folder muted, fade). Tables and diagrams show raw source (proposed).
- **Deletes:** none (its predecessors go in S07-04).
- **Acceptance criteria:**
  - [ ] One keystroke yields exactly one new version.
  - [ ] Thirty keystrokes still yield one version.
  - [ ] Reloading the app shows the edit.
  - [ ] Editing an accepted version is impossible.
  - [ ] A lost response to the first save, followed by a retry, yields one version.
  - [ ] Two-window conflict and resolution, end to end on one server. Windows A and B fork ready v2 with different text. A's first save creates v3 (draft, revision 1). B gets the conflict notice with its text intact; Keep my text saves B's text into v3 at revision 2, and no v4 exists. A's next save, still based on revision 1, gets the notice in turn; Use saved version shows B's text, and A's next edit saves v3 at revision 3. B's following save, based on revision 2, gets the notice again rather than overwriting A.
  - [ ] When the latest version is accepted, the notice offers only Use saved version and keeps the local text visible until then.
- **Verify:** Unit-test the pure decoration ranges and the save scheduler, including serialization, coalescing, same-payload retry, conflict hold, and both Keep my text branches (adopt a draft, fork a ready version) (`apps/web/src/components/panels/plan/__tests__/`). Replay the two-window request sequence above against real SQLite in `apps/server/src/features/agents/planning/__tests__/plan-service.test.ts`. Live, with two web clients on one server (`.dev/fixture-repo`): type in step 4 and check the picker flips to "v2 Edited by you" and `plan.snapshot` returns the text; then run the two-window sequence by hand and confirm the picker shows one "Edited by you" version holding the text of the last confirmed choice.

### S07-06 Plan comments and the composer chip

- **Blocked by:** S07-05 Live-preview editor: the first change creates "Edited by you"; S10-11 Comment drafts persist, one limit, mentions kept; F-07b Toast lane.
- **Boards:** 07e `26TN-2`, 07g states 2 `2CWD-2` and 4 `2CXC-2`
- **Delivers:**
  - Selecting text opens the comment editor. A saved comment keeps its highlight and shows a row with pencil and check. Clicking the note or pencil opens the editing state with trash.
  - Resolve hides the comment and shows an Undo toast that reopens it (F-07b; decision L6).
  - Open, unsent comments ride the composer as "N plan comment(s) ×". Send turns amber and Implement goes plain. Sending revises the plan with the comments.
  - Comments survive edits by re-anchoring or dropping to their section.
- **Build notes:**
  - Server: the `plan_comments` migration; `plan.comment.*`; `reanchorPlanComment`; carry-forward on user forks and agent captures; `plan.snapshot.comments` and `plan.commentsChanged`.
  - Send: `agent.send.planCommentIds`, the envelope append, and `sent_message_id` stamping inside the admission transaction (add `planCommentIds` to `DataOnlyParentTurnStartInput` and `CanonicalRuntimeParentStartSchema`, as for Implement).
  - Draft state lives in the S10-11 persisted composer draft; this ticket adds no second draft store, and the comments themselves stay records in `plan_comments`.
    - The chip reads S10-11's `planCommentSelection` and calls its reconcile helper. The riding ids are frozen at submit.
    - This ticket owns the `planCommentEditor` field (Comments and re-anchoring): `PlanCommentEditorDraftSchema` in contracts, the `serializeComposerDraft` write, the validating `parseStoredComposerDraft` read, the `draftHasNoSendableContent` count, and the round-trip test. These follow the S10-11 store rules for a new field.
  - Web: `PlanCommentLayer`, `PlanCommentsComposerChip`.
- **Deletes:** none (`PlanAnnotation` goes in S07-04, same wave).
- **Acceptance criteria:**
  - [ ] A comment survives an app restart.
  - [ ] × leaves the comment open but excludes it from the send, and the exclusion survives an app restart.
  - [ ] After a successful send, the sent comments leave the chip and excluded comments return to it for the next send.
  - [ ] A comment resolved in another window before Send makes the send fail with `plan_comment_invalid`; nothing is stamped and the draft stays.
  - [ ] Editing the highlighted words drops the comment to its section.
  - [ ] Enter saves and Esc cancels in both editor states; Resolve's Undo reopens the comment.
  - [ ] An unsaved comment editor, new or editing, survives an app restart with its anchor and note. A draft that holds only that editor persists.
  - [ ] `planCommentEditor` round-trips through serialize, `JSON.stringify` and parse. A stored editor with a bad anchor or an over-long note is dropped and counted, and the rest of the draft loads.
  - [ ] Saving the editor clears the field; a save refused with `plan_read_only` keeps it and the note. An editor whose comment was deleted in another window reopens as a new comment on the same anchor.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/selected-text-comment-append.test.ts src/features/agents/canonical/__tests__/canonical-parent-turn-write.test.ts` (generalized append; stamp inside the start), plus a pure `reanchor-plan-comment.test.ts`. `bun run --cwd apps/web test -- src/lib/composer-draft-storage.test.ts` with the `planCommentEditor` round-trip and invalid-field cases. Live: comment on step 3, see the chip, send "go", and confirm the next version arrives and the chip clears. Then open a comment editor, type a note, restart the app, and confirm the editor reopens with the note.

### S07-07 Implement in this thread: split button, shortcut, palette, Accepted

- **Blocked by:** S07-05 Live-preview editor: the first change creates "Edited by you"; F-03 Button primitives; F-04a Menu primitive.
- **Reconciled:** Implement is a durable request (immutable version, revision and text, target thread, admission identity, recoverable status). Reserve turn admission before changing plan status; mark Accepted only with successful admission, with conditional compensation. Replays return the same target and message, including the new-thread path (S07-08).
- **Boards:** 07e `26TN-2`, 07f `260S-2`, 07g states 1 `2CVR-2` and 3 `2CWX-2`
- **Delivers:**
  - "Implement vN" (amber unless comments are open) and its menu, for the draft or ready version on screen. Accepted and superseded versions show no split.
  - Ctrl+Shift+Enter (Cmd+Shift+Enter on macOS) anywhere in the thread, including inside the composer and the editor, with no stray newline.
  - ⌘K/Ctrl+K entries.
  - The chat shows "Implement plan vN". The Plan chip turns off. The version reads Accepted and is read-only, and it never reads Accepted without that turn.
  - Implement sends the text the user saw. If another window changed the version after it was shown, nothing is sent and the panel shows the newer text ("This version changed in another window. Nothing was sent."; proposed copy).
  - A failed or interrupted Implement leaves the version implementable and says so ("Implement was interrupted. Nothing was sent."; proposed copy).
  - The overview row shows task progress.
- **Build notes:**
  - Server: the `plan_implement_requests` migration and `PlanService.implement` (target `thread`) per the Implement sequence (request row, reservation, prepare transaction with the `expectedRevision` check before the snapshot, files, admission through the port, `acceptPlanImplement` in the turn start with the same check, settle, restart recovery).
  - `expectedRevision` is required by the `plan.implement` schema and is part of the fingerprint.
  - Coordinate with the canonical admission boundary only through the data-only start input (`canonical-parent-turn-write.ts:91-95,251-264`); do not add a second commit beside the turn start.
  - `AgentTurnCommand` fields and the reservation hand-off.
  - Web: pending edits ride the request. Every request carries the `expectedRevision` of the text on screen (What can be implemented). Implement waits for an in-flight autosave to settle before it reads that revision. On `plan_conflict` the panel loads the returned version, through the editor's conflict notice when unsaved text was riding, and sends nothing until the user presses Implement again. `usePlanCommands`, the keybinding context, and critical-priority Lexical and CodeMirror handlers. The client replays an unanswered request once with the same `requestId` after reconnecting.
  - `acceptedMessageId` on `PlanVersion`: `plan.snapshot` reads it from the admitted request row. S05's task title uses it (R1, user 2026-10-08): the tray and overview task row of the turn that implements a version read that version's title, as 07f draws.
- **Deletes:** the `planAction: "implement"` ledger row.
- **Acceptance criteria:**
  - [ ] A double press creates one turn, and a replay after the response returns the same receipt.
  - [ ] Fault injection before the request row, after it, after file preparation, and inside the admission transaction each leaves the version unaccepted with no user message.
  - [ ] A provider dispatch failure after admission leaves the version Accepted with a failed turn and Retry.
  - [ ] Crash simulation (drop the in-flight call at a stage, start a new service set on the same database, run recovery) turns a `preparing` row into `interrupted`; the version stays implementable, and a replay returns `implement_interrupted`.
  - [ ] A race with an ordinary Send, in both orders, starts exactly one turn; the loser gets `thread_busy` or the existing pending-mutation error.
  - [ ] A save from another window during Implement gets `plan_busy`. An admission whose recorded revision no longer matches fails with `plan_conflict` and accepts nothing.
  - [ ] Second-window save between display and click. Window A shows draft v3 at revision 4 with no unsaved text; window B saves revision 5; A's Implement v3 with `expectedRevision` 4 returns `plan_conflict` with revision 5, writes no request row, sends no message and accepts nothing. A then shows B's text, and a second press implements revision 5 with exactly that text.
  - [ ] With pending text, an `expectedRevision` that does not match the revision the pending save produces returns `plan_conflict`, and the pending save is rolled back.
  - [ ] A replay of a `requestId` with a different `expectedRevision` returns `implement_request_conflict`.
  - [ ] A late failure never overwrites an admitted request.
  - [ ] Admission through the worker-owned parent start path writes Accepted (the schema carries `planImplement`).
  - [ ] The provider receives the exact plan text plus the supersede line and the file path, and the Mcode plan file holds that text when the turn starts.
  - [ ] Implementing the ready version a draft forked from (shown under its provider name) accepts it, supersedes the draft, and leaves the plan file holding the accepted text. A failed attempt leaves the file holding the draft again.
  - [ ] A superseded version shows no Implement split, the shortcut does nothing while it is on screen, and a direct `plan.implement` for it returns `plan_conflict` with the latest version.
  - [ ] After admission, `plan.snapshot` returns the accepted version with `acceptedMessageId` equal to the Implement message's id; every other version has `null`.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/planning/__tests__/plan-service.test.ts src/features/agents/canonical/__tests__/canonical-parent-turn-write.test.ts src/features/agents/orchestration/__tests__/agent-service-plan-implement.test.ts` (new; prior art `agent-service-plan-marker.test.ts`, which already checks a plan effect inside the parent start). `bun run --cwd apps/web test -- src/components/panels/plan/PlanPanel.test.tsx` covers the split per status and the `expectedRevision` each request carries. Live: press Ctrl+Shift+Enter with the composer focused; one "Implement plan v2" bubble appears and the panel reads "v2 Accepted". Then, with a second web client on the same server, save an edit after the first client rendered the draft and press Implement in the first: nothing is sent and the newer text appears.

### S07-08 Implement in a new thread

- **Blocked by:** S07-07 Implement in this thread: split button, shortcut, palette, Accepted; S04-07 Existing worktree runs setup, skipped while a thread is live there.
- **Boards:** 07g state 1 `2CVR-2` (menu)
- **Delivers:** "Implement vN in a new thread" opens a new thread in the same checkout and starts it at once. For a worktree source, the new thread's trail reads "Opened worktree", then "Skipped setup · implementing a plan" (proposed copy, no board). The new thread shows "Implement plan vN" and its own overview plan row (a copy, Accepted). The source version reads Accepted. A retry or a reconnect never opens a second thread.
- **Build notes:**
  - `plan.implement` with target `new-thread` through `createAndSend` with `startupId = requestId` (existing worktree path or direct).
  - Setup follows the one rule in `04-08f` section D, which S04-07 builds: the new thread continues its source in the same checkout, so it skips Setup the way a branch does. S04-07's live-sibling skip does not settle this case, because Implement refuses while the source has an unfinished execution, so the source is never live when the new thread starts.
    - Add the server-only `setupSkip: { reason: "plan-implement", sourceThreadId }` argument to the port's `createAndSend` and thread it to the coordinator, outside `CreateAndSendCommand` (Implement step 5).
    - The coordinator verifies the source thread's `worktree_path`, refuses any mismatch, skips the setup step with `skipReason: "plan-implement"`, and returns a `dispatch` result without calling `admitInitialAutomaticTurn`.
    - Add `"plan-implement"` to the setup `skipReason` enum (`04-08f` section A) and its trail copy to `startup-step-copy.ts`.
    - Setup never runs for this start, so no request waits on a Setup approval, retry, skip or queued admission, and the port call returns admitted or failed.
  - The source holds a `planImplement` reservation until the request settles.
  - `acceptPlanImplement` binds `targetThreadId`, accepts the source version and inserts the copy (`captureSource: "copy"`) in the new thread's start transaction.
  - Compensation removes the new thread only when it has no messages and its startup is this request's.
  - Cancellation follows S04-05. A cancel before admission fails the request with `startup_cancelled`, and step 7 compensates. A cancel after admission and before the first provider frame ends the turn "Stopped before {Provider} started"; the version stays Accepted because its message is in the transcript (open question 16).
  - Reconnect: the client replays the request once with the same `requestId` and opens the returned `targetThreadId`.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] The worktree source creates a thread in the same worktree; the direct source creates a direct thread.
  - [ ] With a setup script configured and no other thread live in the worktree, the new thread's setup step is skipped with `plan-implement`, the Setup gate's `admitAutomaticTurn` is never called for it, and the request is `admitted` when the port call returns.
  - [ ] A client `agent.createAndSend` that adds a `setupSkip` field to its params still runs Setup for an attached worktree.
  - [ ] A `setupSkip` whose source worktree differs from the target refuses the start: the request fails, and no thread or queued prompt remains.
  - [ ] If the source thread is busy, the request is refused and no thread is created.
  - [ ] A replay of the same `requestId`, during or after the request, returns the same target thread and message and creates no second thread.
  - [ ] A client that disconnects after sending and replays on reconnect, once while the new thread is starting and once after, gets the same target and message; the sidebar shows one new thread.
  - [ ] A startup cancel during the new thread's worktree phase (fault-injected pause, then `thread.startup.cancel`) fails the request with `startup_cancelled`, releases the source reservation, removes the empty thread, and leaves the version implementable.
  - [ ] A cancel after admission and before the first provider frame leaves the source version Accepted and the new thread holding its "Implement plan vN" message.
  - [ ] An admission failure in the new thread leaves the source version implementable and removes the empty thread. A thread that gained a message is never removed.
  - [ ] After a crash simulation between thread creation and admission, recovery runs after startup recovery, marks the request `interrupted`, removes the empty thread, and leaves the source plan and checkout unchanged.
  - [ ] Fault injection after the copy insert rolls back both the copy and the source's Accepted.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/thread-creation-startup.test.ts src/features/agents/planning/__tests__/plan-service.test.ts src/features/agents/transport/__tests__/agent-rpc-route.test.ts` (the client `setupSkip` case). Live: in `.dev/fixture-repo` with a setup script configured, run it from the menu on a worktree thread. The new thread shows Skipped setup and starts at once, and the sidebar gains one thread on the same branch. Reload the window while it starts and confirm no second thread appears.

### S07-08b Implement in a new worktree

- **Blocked by:** S07-08 Implement in a new thread; S03-08 Start from origin; S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe.
- **Boards:** 07g state 1 `2CVR-2` (the menu; this third item is not drawn, so its copy is proposed)
- **Delivers:** "Implement vN in a new worktree", the third Implement menu item and a palette command, creates a worktree at the source checkout's current commit, with no branch like the composer's New worktree (ADR 0015), and starts a new thread there with "Implement plan vN" (user, 2026-10-08, E9). Setup runs as for any new worktree: the trail reads "Created worktree {folder}", then Setup, then "Starting thread". Uncommitted changes in the source checkout stay there, and when the source has any, the menu item says so. The source version reads Accepted once the new thread's first turn is admitted. A retry or a reconnect never creates a second thread or worktree. If the request fails before admission, the empty thread and its worktree are removed. The user names a branch later with Create branch, as for any New worktree thread.
- **Build notes:**
  - How a new worktree is made today, which this ticket reuses:
    - A New worktree thread goes through `ThreadCreationCoordinator.create` → `createManagedThread` → `ThreadService.create(..., "worktree", branch, { branchless })` → `ProjectWorktreeService.provisionThreadWorktree` → `GitWorktreeService.createWorktree` (`thread-creation-coordinator.ts:282-296,393-408`; `thread-service.ts:47-92`; `project-worktree-service.ts:27-49`; `git-worktree-service.ts:87-104`). The startup binds the thread and advances to `worktree` when the row is persisted (`thread-creation-coordinator.ts:410-421`), then to `setup` for a managed worktree (`:317-319`).
    - The composer's New worktree is branchless: `--detach` at the base branch (`workspaceStore.ts:378-384`, `git-worktree-service.ts:348-350`, ADR 0015). A named branch is created with `worktree add <path> -b <branch> <baseRef>` (`git-worktree-service.ts:351-354`); delegated threads already pass a base commit-ish that way (`project-worktree-service.ts:51-67,201-205`). S03-08 adds a start point to this path for Start from origin; this ticket uses that same plumbing, not a second one.
    - Folder names are `<sanitized ref>-<thread id, 8 chars>` (`project-worktree-service.ts:11-13`). An unnamed managed branch defaults to `mcode/<folder>` (`git-worktree-service.ts:207`).
  - Contract: `plan.implement` gains `target: "new-worktree"`; `PlanImplementReceipt` gains `state`; the request row gains `sourceCommit` (Implement, steps 3, 5 and 7).
  - Source commit: after the reservation, resolve HEAD in the source checkout (the source thread's worktree, or the project folder for a direct source, as `resolveWorkingDir` picks at `git-worktree-service.ts:129-135`) and record it in step 3. A project that is not a git repository, or a HEAD with no commit, fails the request with `implement_failed` before anything is created.
  - Worktree: call the port's `createAndSend` with `mode: "worktree"`, `startupId = requestId`, `branchless: true`, and the server-only `worktreeStart: { commit }` argument, outside `CreateAndSendCommand` like `setupSkip` (`agent-rpc.ts:140-145` spreads wire params). The coordinator creates a branchless managed worktree (`--detach`) at `commit` through S03-08's start-point plumbing, exactly as the composer's New worktree does at the base branch (`git-worktree-service.ts:348-350`). The folder is named from the source thread's `branch` column and the new thread's id (`project-worktree-service.ts:11-13`). No branch is created, so no branch can collide or be left behind. A provisioning failure already rolls back the checkout (`project-worktree-service.ts:169-187`).
  - Setup runs: no `setupSkip`. The start is `managed-worktree`, so Setup runs through the gate, and the first turn may wait behind it (`04-08f` section D). While it waits, the request stays `preparing`, `plan.implement` returns `state: "waiting-for-setup"`, the source keeps its `planImplement` reservation, and plan writes on the source return `plan_busy`. The gate's queued command must keep `messageId`, the wire text, `displayContent` and `planImplement` until it is admitted (inferred: admit through the queued path in the tests).
  - Settle (step 7): admission accepts the version as for every target. A startup that ends without admitting the turn (cancelled, failed, thread deleted) fails the request; a startup observer, like S04-02's, drives it. Compensation deletes the empty thread with `ThreadService.delete(threadId, true)` (`thread-service.ts:119-138`), so the cleanup job removes the checkout (`cleanup-worker.ts:336-343`). A thread that gained a message is never removed, so its worktree stays.
  - Restart recovery (step 8): a request still waiting on Setup sees an interrupted startup, fails as `interrupted`, and compensation removes the thread and the worktree.
  - Reconnect: as S07-08, the client replays once with the same `requestId` and opens the returned `targetThreadId`. A replay returns `waiting-for-setup` while Setup runs and the admitted receipt after.
  - Web: the third `PlanImplementSplit` menu item and the `plan.implementInNewWorktree` palette command, both only when `git.reviewState` (S10-02) reports a git repository. Read `git.reviewState` for the source when the menu opens; when `uncommitted.staged + unstaged + untracked > 0`, the item shows a muted second line, "Starts from the last commit. Uncommitted changes stay here." (proposed copy, no board). While a request waits for Setup, the Plan panel shows the version read-only with a muted line, "Waiting for Setup in {folder}", and Open thread (proposed copy, no board). The way out is the new thread's trail: Stop or Esc cancels, Skip setup admits.
  - Per provider: no adapter change. The new thread starts through `createAndSend` with the source thread's provider and model settings, like any new worktree thread.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] The new worktree's HEAD equals the source checkout's HEAD at the press, detached with no branch. The source checkout's branch, HEAD and files are unchanged, including its uncommitted changes.
  - [ ] A source with uncommitted changes shows the second line on the menu item; a clean source shows none.
  - [ ] With a setup script configured, the trail shows Created worktree and then Setup, and `plan.implement` returns `waiting-for-setup`. The version reads Accepted only after the first turn is admitted, and every client then shows it Accepted.
  - [ ] Setup failed, then Skip setup, admits the turn and accepts the version.
  - [ ] Stop during Setup fails the request with `startup_cancelled`, releases the source reservation, removes the thread and its worktree folder, and leaves the version implementable.
  - [ ] Without a setup script, the turn is admitted at once and the receipt is `admitted`.
  - [ ] A replay of the same `requestId` during worktree creation, during Setup and after admission returns the same target and message, and creates no second thread or worktree.
  - [ ] After a crash simulation during Setup, recovery marks the request `interrupted` and removes the empty thread and its worktree.
  - [ ] `git branch --list` in the repository is the same before and after, on success and on compensation.
  - [ ] A client `agent.createAndSend` cannot pass a start commit.
  - [ ] In a project that is not a git repository there is no menu item and no palette command, and a direct `plan.implement` with `new-worktree` fails and creates nothing.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/planning/__tests__/plan-service.test.ts src/features/agents/turns/__tests__/thread-creation-startup.test.ts src/features/agents/transport/__tests__/agent-rpc-route.test.ts ` (start commit against a real git repository, with S03-08's `start-from-origin.test.ts` as prior art; the queued path through Setup; compensation; the client `worktreeStart` case). `bun run --cwd apps/web test -- src/components/panels/plan/PlanPanel.test.tsx` for the third item, its dirty line and the waiting state. Live: in `.dev/fixture-repo`, with a setup script configured and an uncommitted change in a worktree thread, run the menu item. The item shows the dirty line, the new thread's trail runs Setup, `git rev-parse HEAD` in the new worktree equals the source's, and the change stays in the source. Run it again and press Stop during Setup: the thread and the worktree folder are gone, and no branch was created.

### S07-09 Plan-mode conversation: question dock, Planning, revise follow-ups, sidebar states

- **Blocked by:** S07-03 Plan record v2: durable versions, autosave, snapshot, and writer coordination; S01-04 Thread row state model and the three-line row; S06-04 Approval dock replaces the composer.
- **Boards:** 07b `27YA-2`, 07c `26BG-2`, 07d `26L9-2`
- **Delivers:**
  - Questions arrive in a dock that replaces the composer, with "Waiting for your answers".
  - The receipt reads "Answered N questions". The turn footer says "Planning".
  - In Plan ready, the composer says "Tell {Provider} what to change" and a send revises the plan.
  - The sidebar shows "Answers required" and "Plan ready" at full brightness for background threads too. Opening a Plan ready thread opens the panel.
- **Build notes:**
  - Server: the `threads.plan_phase` migration and every transition in the table, including `no_plan` persistence and, if S07-07 merged first, `plan_phase = null` inside `acceptPlanImplement`; `PlanTurnService.classify`; filling `TurnRequest.planTurn`; the plan file path in revise and follow-up wire text; `plan.snapshot.phase` and `plan_phase` on the thread payload for S01.
  - Web: `QuestionDock` reuses the S06 surface. Number keys 1-4 pick options.
- **Deletes:** the `planAction (all)` and `PlanQuestionWizard` ledger rows, and the question branch of `PermissionRequestCard` with the `"permission-request"` virtual item (ledger row in `06-approvals.md`, owned by this ticket).
- **Acceptance criteria:**
  - [ ] A follow-up in Plan ready never shows questions again.
  - [ ] A background thread shows "Answers required" without being opened.
  - [ ] Dismissing the questions clears the label.
  - [ ] Once S07-07 and this ticket have both merged, an admitted Implement clears the phase in the same transaction (asserted by whichever merges second).
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/planning/__tests__/plan-question-service.test.ts` plus a new classify test. Rewrite `PlanQuestionWizard.test.tsx` as a `QuestionDock` test. Live: start a Plan thread, switch away, and see the "Answers required" row.

### S07-10 Codex questions through `requestUserInput` (merged)

- **Blocked by:** Not a ticket. Merged into S07-02: Codex native plan mode and its requestUserInput question protocol activate together.

Merged into S07-02, so native Codex plan mode and its question protocol activate together.

### S07-11 /plan in the composer and the neutral Plan chip

- **Blocked by:** S05-09 Composer tray with the task row; F-03 Button primitives.
- **Boards:** 07a `1ZTO-2`, 07h `2CXZ-2`
- **Delivers:**
  - The Plan chip is neutral; clicking it turns Plan off.
  - `/pl` filters the attached tray.
  - Enter or Tab toggles Plan and removes the typed command.
  - `/plan ` plus a space converts inline and keeps the draft.
  - With Plan on, the row reads "Exit plan mode".
- **Build notes:** Make `attachCapability("plan")` toggle. Add an inline conversion rule in `SlashCommandPlugin.tsx` (space handling near `:116-129`). The tray matches the task tray (single match has no fill; several use `--color-hover`).
- **Deletes:** the amber chip and floating `SlashCommandPopup` ledger rows.
- **Acceptance criteria:**
  - [ ] All four 07h states work by keyboard alone.
  - [ ] The draft text survives toggling.
- **Verify:** Lexical plugin tests (prior art `components/chat/lexical/__tests__` if present, else a new one). Live: type `/plan fix the menu` and see the chip and the draft "fix the menu".

### S07-12 Claude native plan mode and plan-file sync

- **Blocked by:** S07-01 Plan capture seam with a fenced fallback for all six providers; S07-07 Implement in this thread: split button, shortcut, palette, Accepted; S07-09 Plan-mode conversation: question dock, Planning, revise follow-ups, sidebar states.
- **Boards:** 07c `26BG-2`
- **Delivers:** Claude plan turns run in SDK plan mode: read-only at the provider, so Plan is read-only for Claude. Before Implement, Claude's own plan file is rewritten only when S07-00 proved that an event names this session's file; otherwise Implement reports that the file was left unchanged.
- **Build notes:** Set SDK `permissionMode: "plan"` from `TurnRequest.planTurn`. Capture `ExitPlanMode`, with `nativePlanFile` only when proved. Implement `prepareImplement` through `native-plan-file.ts`. Remove the off-interface cast.
- **Deletes:** the Claude `setPlanAnswerMode` ledger row.
- **Acceptance criteria:**
  - [ ] Full-access Plan turns cannot write files.
  - [ ] The Implement turn runs in bypass or default as the thread setting says.
  - [ ] With a proved file, a file changed after capture is left untouched and reported `changed`, and a symlinked or out-of-root path is refused as `unsafe-path`.
  - [ ] Without proof, nothing outside Mcode's own plan file changes, and the receipt says `unproven`.
- **Verify:** `bun run --cwd packages/providers test -- src/__tests__/claude-factory.test.ts`, plus `native-plan-file.test.ts` for the shared validation. Live: a Claude Plan thread asked to "just edit the file" makes no edits.

### S07-13 Cursor and Copilot native capture fixes

- **Blocked by:** S07-01 Plan capture seam with a fenced fallback for all six providers; S07-07 Implement in this thread: split button, shortcut, palette, Accepted; S07-09 Plan-mode conversation: question dock, Planning, revise follow-ups, sidebar states.
- **Boards:** 07d `26L9-2`
- **Delivers:** Cursor plans wait for review in Mcode instead of being auto-accepted. Copilot can write its own session's `plan.md` in plan mode, and Mcode captures it. Before Implement, each provider's own plan file is rewritten or deleted only when its ownership is proved and its bytes are unchanged since capture.
- **Build notes:** Cursor's `create_plan` response outcome from the S07-00 capture; a plan file only when the request names it inside the worktree. Copilot's plan-mode policy allows exactly `session-state/<sessionId>/plan.md` for the adapter's own session id, plus the SDK capability check; record the SDK bump decision in the PR. Both use `native-plan-file.ts`.
- **Deletes:** the Cursor auto-accept ledger row.
- **Acceptance criteria:**
  - [ ] The Cursor fixture asserts the captured non-accepting reply.
  - [ ] Copilot's write to its own session's `plan.md` is allowed; another session's `plan.md` and every other write are denied.
  - [ ] A plan path outside the session's directory is refused even when the provider reports it.
  - [ ] No plan file is ever deleted by pattern.
- **Verify:** `bun run --cwd packages/providers test -- src/private/cursor/acp/__tests__/cursor-create-plan.test.ts src/conformance/__tests__/conformance.test.ts`, plus the Copilot provider tests.

### S07-14 Devin and OpenCode native plan modes and plan-file hygiene

- **Blocked by:** S07-01 Plan capture seam with a fenced fallback for all six providers; S07-07 Implement in this thread: split button, shortcut, palette, Accepted; S07-09 Plan-mode conversation: question dock, Planning, revise follow-ups, sidebar states.
- **Boards:** 07d `26L9-2`
- **Delivers:** Devin and OpenCode plan turns run in their plan modes where S07-00 confirmed them. Mcode captures a plan file only when an event names it for the session. Before Implement, OpenCode's named in-worktree plan file is deleted when its bytes are unchanged since capture, so git status stays clean. An unproven or changed file is left alone and reported.
- **Build notes:** Devin `applyMode` for every plan turn; OpenCode `agent: "plan"` on `prompt_async` if confirmed; `prepareImplement` through `native-plan-file.ts`. No turn-scoped directory watch, diff of the folder, or glob.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] With a proved OpenCode file, the file is gone after Implement and `git status` in the fixture repo is clean.
  - [ ] Another session's plan file in the same folder is untouched.
  - [ ] A file edited after capture is left in place and reported `changed`.
  - [ ] Devin plan capture is unit-tested at the mapper seam.
- **Verify:** `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-provider.test.ts`. Live: run an OpenCode Plan thread, then check `git status` in `.dev/fixture-repo`.

## Tests

- **Highest seams.**
  - `PlanService` on real SQLite: versions, draft revisions, keyed forks, comments, Implement, replay, compensation, restart recovery.
  - The canonical start writer with `planImplement` and `planCommentIds`, through both the direct and the worker-owned parent start paths (`canonical-parent-turn-write.test.ts`).
  - `PlanTurnService` classification and capture.
  - The pure functions `PlanFenceParser`, `reanchorPlanComment`, the web save scheduler, and `lib/plan-fences.ts`.
  - `native-plan-file.ts`: containment, symlink refusal, size bound, hash compare.
  - Provider conformance fixtures (`packages/providers/src/conformance/fixtures/*.json`): rename `planExitCount` (`fixture-safety.ts:392-433`) to `planCaptureCount`; add S07-00's captured plan fixtures.
- **Races and crashes.**
  - Implement against an ordinary Send, in both orders.
  - Two windows saving one draft; two windows forking one ready version, then the loser's Keep my text and the winner's next save; reordered saves; a lost first-save response.
  - A second-window save between displaying a version and pressing Implement.
  - Implement with stages faulted before the row, after file preparation, after thread creation, and inside admission; then restart recovery on the same database.
  - Implement in a new thread cancelled before and after admission, and replayed across a reconnect.
  - Implement in a new worktree cancelled, crashed and replayed while Setup holds its first turn; compensation leaves no thread, worktree or branch behind.
  - A Codex question across a window reload and across an app-server exit.
- **Historic data.** A stored message with a `plan-output` fence renders without JSON. Legacy `plans` rows and legacy canonical plan items load as `ready` versions.
- **Prior art.**
  - `apps/server/src/features/agents/planning/__tests__/*.test.ts`
  - `apps/server/src/features/agents/canonical/__tests__/canonical-plan-live-projection.test.ts`
  - `apps/server/src/features/agents/canonical/__tests__/canonical-parent-turn-write.test.ts`
  - `apps/server/src/features/agents/orchestration/__tests__/agent-service-plan-marker.test.ts`
  - `apps/server/src/features/thread-control/authority/__tests__/thread-control-mutation-reservation-service.test.ts`
  - `apps/server/src/runtime/persistence/sqlite/__tests__/database-migration-success.test.ts`
  - `packages/providers/src/__tests__/claude-factory.test.ts`
  - `packages/providers/src/__tests__/codex/codex-app-server-approval.test.ts`
  - `packages/providers/src/private/cursor/acp/__tests__/cursor-create-plan.test.ts`
  - `apps/web/src/components/panels/plan/PlanPanel.test.tsx` (rewrite)
  - `apps/web/src/stores/planStore.test.ts`
  - `apps/web/src/components/chat/PlanQuestionWizard.test.tsx` (becomes the dock test)
- **Not worth testing:** CodeMirror rendering in jsdom. Test decoration ranges and the save scheduler as pure logic, and prove the look live.
- **Live checks.** Use the Electron live-testing harness (`.agents/skills/electorn-live-testing/SKILL.md`) against `.dev/fixture-repo` only. Capture before and after screenshots for 07a through 07h for the PR.

## Risks and open questions

1. **Second plan in one thread.** After an accepted plan, a new Plan run either continues numbering (v3) or starts a fresh plan at v1. Recommendation: continue per thread; it needs no plan-group table. Decides: user.
2. **New-comment button.** Paper shows an amber check (`2CWN-2`); the todo says an up-arrow "Comment" button like composer Send (`screen-pass-todo.md:46`). Decides: user.
3. **Implement with open comments.** Recommendation: the comments are not sent (Implement sends exactly the plan text) and stay on the accepted version. Decides: user (confirm).
4. **"No structured plan" is not drawn.** Proposal: the overview row reads "No structured plan" (muted) and opens an empty state with one action, "Use last reply as plan", which creates v1 from the final assistant message. Decides: user, then a board.
5. **The dock has no "Accept recommended".** Proposal: retire `AcceptRecommended`; the recommended option is pre-selected, so Enter takes it (inferred). Decides: user.
6. **Reverse of Resolve.** Decided (decisions.md L6): an Undo toast (F-07b) that reopens through `plan.comment.setStatus`.
7. **Plan rail icon.** Board doc icon or code ListChecks; still open from 08 (`screen-pass-todo.md:52`). Decides: user.
8. **Protocol facts.** S07-00 measures them before any native ticket starts: the Codex minimum version and `requestUserInput` semantics, the Copilot SDK plan API, the Cursor `create_plan` response, the OpenCode `agent` field, Devin's plan files, and whether any provider names its plan file per session. A native promise that S07-00 cannot prove ships as fence capture.
9. **User edits are blocked while a turn runs or an Implement is preparing** (`plan_busy`). This trades a small UX limit for no version races with the canonical writer. Decides: engineering. The editor shows read-only during Planning.
10. **New dependency.** CodeMirror 6 for the live-preview editor, rather than Lexical. CodeMirror edits the markdown text directly (the record is text) and maps comment anchors through edits. Lexical would round-trip markdown through a rich model, and that is lossy. Decides: user (dependency approval).
11. **The attached slash tray replaces the floating popup for every slash command, not only `/plan`.** Decides: the composer section owner, together with S07-11.
12. **Sidebar plan states for background threads** need the server-side `plan_phase` delivered through the S01 model. If S01 picks another transport, S07-09 adapts. Decides: S01 author.
13. **Native plan file left unchanged.** No board shows the muted "{Provider}'s own plan file was left unchanged" line on the accepted version, or the Implement failure copy. Decides: user, then a board.
14. **Draft conflict notice.** No board shows the notice that offers "Keep my text" and "Use saved version". Decides: user, then a board.
15. **Unproven native files stay.** Where S07-00 cannot tie a provider's plan file to its session (inferred to be likely for Devin and OpenCode), Mcode leaves the file in place. An in-worktree OpenCode file then shows in git status until the user removes it. This is the honest cost of never deleting by pattern. Decides: engineering, revisited if S07-00 finds an identity source.
16. **Accepted is atomic with admission, not "before the turn".** An Implement whose provider fails after admission stays Accepted with a failed turn and Retry, because its message is in the transcript. Decides: engineering (confirm with the user if a rollback to implementable is preferred).
17. **Superseded versions are not implementable.** Decided (user, 2026-10-08, L9). The picker shows them read-only with no Implement split. A user who prefers an older agent version asks the agent to restore it, or copies its text into the draft. The ready version a draft forked from stays implementable.
18. **Implement in a new thread skips Setup.** Decided (user, 2026-10-08, E9). The new thread continues its source in the same checkout, like a branch, so Setup does not run even when no other thread is live there (`04-08f` section D, open question 13 there). The user also asked for "Implement vN in a new worktree" (S07-08b), which runs Setup.
19. **Two consequences of S07-08b to keep in view.** First, the worktree is branchless, like the composer's New worktree (ADR 0015, status proposed), so S07-08b adds no branch naming policy; the user names a branch later with Create branch. Second, Setup runs and S07-08's request rules hold, so the source thread keeps its reservation for as long as Setup takes and cannot take a Send meanwhile; the Plan panel says so and links the new thread. Decides: engineering, within the user's answer.
