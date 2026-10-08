# 06 · Needs approval: build brief

When an agent in Manual mode asks to run a command, edit a file, fetch a page, or act on another thread, the approval dock replaces the composer surface. The task tray stays above it. The dock says what the agent wants in plain terms: the command, or a diff preview for an edit. It offers numbered choices the user can pick from the keyboard, plus "Tell <agent> what to do instead…". The status line reads "Waiting for approval". Several waiting requests page as "2 of 3", and subagent requests name the subagent. Each decision leaves a durable receipt on the timeline ("Allowed once", "Denied"), so it survives turn end and reload. A thread in the background that needs approval shows "Approval required" in the sidebar even after a reload. Surfaces: contracts, server (agents), all six provider adapters, web (composer, timeline, sidebar data, stores), persistence.

## Boards

Page "05 · Ready for build" is `p-6-0`: https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0. Components page "04 · Components" is `p-5-0`.

| Board | Node | Shows |
|---|---|---|
| 06a · Needs approval · Command · Dark | `27P2-2` (p-6-0) | Dock replaces composer under the task tray; "Codex wants to run a command"; `$ bun run lint`; facts line "in mcode-3f2a · network off"; rows 1 Allow once (focused), 2 Allow for this session, 3 Deny, 4 Tell Codex what to do instead…; status line "Waiting for approval"; sidebar row "Approval required" |
| 06b · File edit with diff | `28FL-2` (p-6-0) | "Codex wants to edit a file"; path row `ThreadActionsMenu.tsx`, `+4 -9` pinned right; 2 diff lines; same choices |
| 06c · Several waiting, 2 of 3, subagent | `2864-2` (p-6-0) | Header "Wants to run a command", subagent chip (provider icon + "Review copy"), pager "‹ 2 of 3 ›"; row 4 reads "Tell the subagent what to do instead…" |
| 06d · Allowed, receipt, turn resumes | `2733-2` (p-6-0) | Receipt row "✓ Allowed once `bun run lint`" in the narrative, then "Running command"; composer back ("Queue a follow-up", chip Manual, Stop) |
| 06e · Denied with a note | `27E4-2` (p-6-0) | Receipt "✕ Denied `bun run lint`", note as a user bubble, agent adjusts in the same turn |
| 06f · Another thread needs approval, sidebar only | `200I-2` (p-6-0) | User on a new thread; background thread row shows amber ring + "Approval required" at full brightness |
| 06g · File edit · Long content · Dark | `2CTD-2` (p-6-0) | Dock at 760 and 520 wide: filename ink then folder muted with fade, `+1 −1` pinned right, 3 diff lines that clip with the 24px fade, no wrap |
| Approval prompts · Composer dock · Dark / Light | `13F0-0` / `13QO-0` (p-5-0) | Canonical component states: Command, File edit, Tool permission ("Claude wants to fetch a page"), Provider options (Devin: Allow once, Switch to Bypass + description, Reject), Question (owned by S07), Another thread ("Codex wants to message another thread", Allow/Deny only), Subagent 2 of 3, Submitting ("Allowing once…", others at 0.45 opacity), Failed to send ("Your answer didn't reach Codex." + Try again), Decided timeline records |
| Approval prompts · Directions · Dark | `138A-0` (p-5-0) | Directions A/B/C. B (composer dock) is the chosen one. Reference only |
| Navigation · Threads and projects · Dark / Light | `CW1-0` / `EBJ-0` (p-5-0), "Approval required" text `DBN-0` / `EUU-0` | Sidebar "Approval required" row (owned by S01, data from S06-02) |

Exact values (from `get_jsx`, not screenshots):

- Dock: `background var(--color-panel)`, `border 1px color-mix(var(--color-primary) 45%, transparent)`, `radius var(--radius-composer)`, padding 14/16, column gap 12, width 100% of the composer column.
- Header: 14px icon stroked `var(--color-primary)` 1.5; title 14/20 weight 500 `var(--color-ink)`; gap 8. In a subagent request the title drops the provider name. The chip then has: a 16×20 slot holding a 14px provider icon in `var(--color-muted)`, a 12/16 muted label, gap 6, and padding-left 4. A spacer follows, then a 14px chevron, "2 of 3" at 12/16 muted, and another 14px chevron.
- Subject block: `background var(--color-hover)`, `radius var(--radius-8)`, padding 8/12, gap 6. A command shows a muted `$` and the command in ink, both mono 13/20.
- Facts line: sans 12/16 muted ("in mcode-3f2a · network off").
- Choices: column gap 2. Each row has min-height 36, padding 6/10, gap 10, radius 8, and the focused row gets `var(--color-hover)`. Key chip: 20 tall, min-width 20, `1px var(--color-border)`, radius 5, padding-inline 5, mono 11/14 muted. Label: sans 14/20 ink, weight 500 on the focused row. The redirect label is muted. The Devin description is a second line under the label.
- File edit: the path row sits in a 20px clip frame with the `--spacing-text-fade` right mask. It shows the filename in mono 13 ink, then the folder in mono 13 muted (gap 8), then `+N` in `var(--color-success)` and `−N` in `var(--color-error)`, both mono 12, pinned right with additions first. Diff block: 60px tall (3 × 20), mono 12/20, `white-space: pre`, right fade mask. Context lines are muted, removed lines use `--color-error`, added lines use `--color-success`, and there are no line numbers.
- Status line: 24px row, padding-inline 8, gap 8, 6×6 dot radius 3 in `var(--color-primary)`, "Waiting for approval" at sans 12/16 muted. No step count or timer while waiting (06a vs 06d).
- Receipt row: 28px, padding-inline 8, gap 8. A 14px icon: a check stroked `--color-success` for allowed, an × stroked `--color-muted` for denied or cancelled. The label is sans 14/20 muted, followed by the subject in mono 12/20 muted.
- Submitting: the chosen row swaps its key chip for a 14px arc spinner stroked `--color-primary` and reads "Allowing once…" in weight 500. Other rows go to `opacity 0.45` and the redirect row is hidden.
- Failed to send: a line with a 14px error icon, "Your answer didn't reach Codex." at 14/20 `--color-error`, a spacer, and "Try again" at 14/20 weight 500 ink. The choices stay enabled.

## Locked decisions

- 2026-10-07: section 06 approved. Boards 06a–06f; 06g long content added the same day (`screen-pass-todo.md:40-41`).
- 2026-10-07: use the Components approval dock and the sidebar "Approval required" row as-is: amber dock border and dot, amber ring and label. A thread needing attention is never faded (`screen-pass-todo.md:42`, `implementation-notes.md:10`).
- 2026-10-07: the pending dock replaces the composer surface, and the task bubble stays above it. The status line becomes "Waiting for approval". The composer chip reads Manual on 06 boards because approvals only exist in Manual/Auto. The default is Full access (`screen-pass-todo.md:43`).
- 2026-10-07: dock width follows the composer (max 760, min 520). Diff lines never wrap: they clip at the block edge with the 24px fade and scroll horizontally. The block shows about 3 lines, with Open diff for the rest. The path row shows the filename first in ink, then the folder muted and faded, with +/- pinned right (`screen-pass-todo.md:41`, `implementation-notes.md:124-125`).
- 2026-10-07: the access-mode picker's selected row is neutral like the model picker, with no amber check (`screen-pass-todo.md:45`).
- 2026-10-07: show "Allow for this session" only when the scope can be stated. Persist receipts ("Allowed once", "Denied") on the timeline. For deny with a note, only Claude was believed to carry a reason natively; the other providers deliver it as a follow-up (`implementation-notes.md:120-122`; see the correction for Copilot below).
- Diff rendering: every diff surface uses `@pierre/diffs`. The dock uses `PatchDiff` (no header, unified, `overflow: "scroll"`). JetBrains Mono ligatures are off in code views (`--diffs-font-features` or `unsafeCSS`) (`implementation-notes.md:126, 128, 137`).
- 2026-10-07: subagents show their provider icon, never generic badges (`screen-pass-todo.md:35`).
- 2026-10-07: Full access and Stop are neutral, with no amber or red (`screen-pass-todo.md:30`).
- Truncation is a 24px right-edge fade, never an ellipsis (`screen-pass-todo.md:7`).

## How it works today

### Contract

- `PermissionRequestSchema` (`packages/contracts/src/models/permission.ts:64-84`) carries `requestId, threadId, toolName, input: unknown, title?`, thread-control fields (`ownerWorkspaceId, ownerThreadId, sourceThreadId, operation`), `questions?`, and verbatim `options?` (min 1). It has no request kind, no `toolCallId`, no provider id, no diff, no scope text, no deny reason, and no origin. Verified.
- Decisions are `allow | allow-session | deny | cancelled` (`permission.ts:5-10`).
- Wire: the push channels `permission.request` and `permission.resolved` (`ws/channels.ts:206-212`; the resolved payload has no `optionLabel`), and the RPCs `permission.respond` (returns `void`) and `permission.listPending({threadId})` (`ws/methods.ts:1153-1167`).
- Provider interface: `resolvePermission(): boolean` (synchronous), `listPendingPermissions(threadId)`, and the events `permission_request` and `permission_resolved` (`providers/interfaces.ts:200-227`).

### Server

- `publishAgentPermissionEvents` validates each provider request. **Bug (verified):** an invalid request is logged and dropped (`apps/server/src/features/agents/permissions/permission-publication.ts:24-31`), and a test pins that behavior (`permissions/__tests__/permission-publication.test.ts:51`). The provider still holds the pending promise, so the agent waits forever with nothing on screen. The log line carries `parsed.error.message` (`:26-29`), which can echo field values.
- `AgentPermissionService.respondToPermission` loops providers and only logs when none holds the id (`agent-permission-service.ts:27-33`). The RPC returns success either way. `listPendingPermissions` uses `.parse` (`:37-41`), so one bad request makes the whole thread's list throw. The client swallows that error (`auxiliary-hydrator.ts:160-162`), and the thread then shows no approvals at all. The effect is inferred.
- `permission.request` is broadcast to every client, not thread-scoped (`server-bootstrap.ts:898-905`; the scoped channels are listed at `application/transport/push.ts:17-22`).
- Thread-control approvals broadcast `permission.request` directly and skip validation (`thread-control-service.ts:555-560, 669-673, 1344-1348`). The push keys `threadId` to the target thread. `ownerThreadId` is the source thread when an Mcode agent asked and the target only for an external integration, which has no source thread (`:558`). The pending list returns a thread's approvals whether it is the target or the source (`:1156-1160`), so one request can show on both threads (effect inferred). The source agent's provider is known for internal callers (`thread-control-mcp-authority.ts:8, 21`).
- **Bug (verified):** the published `optionLabel` (`permission-publication.ts:46`) is not in the `permission.resolved` channel schema. The validating push adapter strips unknown keys (`payload-validation.ts:17-27`), so in dev builds Devin's label never reaches the web. Production behavior is inferred.

### Providers (what each forwards today)

- **Claude** (`packages/providers/src/private/claude/claude-provider.ts:1114-1142`) emits only `toolName, input, title`. The SDK's `CanUseTool` options also carry `toolUseID`, `agentID` (subagent), `suggestions`, `decisionReason`, `blockedPath`, `displayName`, and `description` (`@anthropic-ai/claude-agent-sdk` 0.3.212 `sdk.d.ts:207-247`). None of these are read; `rg "toolUseID|agentID|decisionReason" claude/` returns nothing. `allow-session` returns `updatedPermissions: options?.suggestions` verbatim (`:1166-1171`). SDK destinations include `userSettings | projectSettings | localSettings | session` (`sdk.d.ts:2123`), so "this session" can write a persistent rule. That effect is inferred. Deny sends the fixed message "User denied" (`:1173`); the SDK's deny result carries a free `message` (`sdk.d.ts:2081-2087`).
- **Codex** (`private/codex/codex-permission-mapper.ts:101-140`): a file change forwards only `{itemId, grantRoot?}` (`:118-122`). The diff exists upstream as `FileUpdateChange { path, kind, diff }` (Codex `app-server-protocol/src/protocol/v2/item.rs:1146-1150`), keyed by the same `itemId`. The mapper's `fileChangeToolInput` keeps only `path, kind` (`codex-event-mapper.ts:1415-1421`), and the local type omits `diff` (`codex-types.ts:404-405`). The Codex command decision `decline` has no reason field. `turn/steer` is a stable method with an `expectedTurnId` precondition (`common.rs:1056-1061`, `turn.rs:308-329`). `acceptForSession` means "future changes to the same files" for files (`item.rs` `FileChangeApprovalDecision`) and the session approval cache for commands. Mcode ignores `params.threadId`, so child-thread (subagent) requests carry no origin (`codex-provider.ts:2794-2823`).
- **Cursor (ACP)** (`private/cursor/acp/cursor-acp-permission-mapper.ts:14-31`) forwards `title` and `rawInput` only. It drops `toolCall.toolCallId`, `kind` (ACP `ToolKind`), and the `content` diff blocks `{path, oldText, newText}` (ACP SDK 0.21.0 `types.gen.d.ts:1201-1222, 5046`). It also drops the verbatim options, although the mapper already tells `reject_once` from `reject_always` (`:71`). **Bug (verified):** deny with no reject option falls back to `options[0]` (`:73`), which can be an allow. The bridge reports the user's decision before it resolves the ACP promise (`cursor-acp-client-bridge.ts:68-75`), so that fallback is recorded as a Deny the provider never received. "Allow" without `allow_once` picks `allow_always` (`:67`), and "allow-session" maps to `allow_always` (`:69`). ACP outcomes carry no reason (`types.gen.d.ts:3664-3668`). Separately, Cursor on Windows is locked to Full access (`apps/web/src/lib/cursor-permission.ts:5-21`). That comment describes the old `cursor-agent --print` transport, but Cursor now runs over ACP with `requestPermission` (`runtime/cursor-acp-process-spawner.ts:82-100`). See open questions.
- **Copilot** (`private/copilot/copilot-provider.ts:284-298`) sets `toolName: native.kind` and `input: native` (the whole SDK object). `allow-session` sets `state.sessionApproval = true`, which approves every later request of any kind (`:291, :311`; verified). The SDK request carries `toolCallId`. Shell requests carry `fullCommandText`, `commands[].identifier`, and `canOfferSessionApproval`. Write requests carry `fileName` and a unified `diff` (`@github/copilot-sdk` 0.2.2 `types.d.ts:534-538`, `generated/session-events.d.ts:2570, 2582, 2608, 2629-2637`). **Correction to the locked note:** Copilot's deny result `denied-interactively-by-user` has `feedback?: string` (`generated/rpc.d.ts:1138-1139`). Copilot can carry the deny note natively. Whether the model sees it is inferred.
- **Devin (ACP)** (`private/devin/devin-provider.ts:762-786`) forwards verbatim options and hides `allow_always_global`. It mints the request id and takes the thread from its own session entry (`:770-771`), which is the routing model v2 keeps. Deny with no reject option answers `cancelled` (`:91-102, 729-739`). It looks up the tool snapshot by `toolCall.toolCallId` (`:767`) but does not forward the id. No diff. The client sends decision `allow` for every option button, Reject included (`PermissionRequestCard.tsx:165`); the server corrects it by option kind (`devin-provider.ts:713`).
- **OpenCode** (`apps/server/src/features/providers/adapters/opencode/opencode-permission-mapper.ts:77-95`) keeps only `action` and `resources[]` and drops `metadata` (test `opencode-permission-mapper.test.ts:58-69`). `allow-session` maps to `always` (`:64-68`). It cuts each resource pattern to 512 characters and keeps at most 32 (`boundStringList`, `:47-55, 86`), so the card can state less than an `always` reply grants (truncation verified; the grant effect is inferred). The same file already refuses to truncate question option labels because that would change the user's choice (`:102-104`); v2 applies that rule to approval scope. An ask without a usable `id` or action emits a System notice, "A provider request could not be shown safely.", but never answers upstream (`opencode-permission-mapper.ts:80-84`, `opencode-provider.ts:1067-1068, 1086-1101`). A failed reply is logged and the card "stays answerable", but nothing tells the user (`opencode-provider.ts:474-484`). Both verified.

### Web

- Store: `ThreadRecord.permissions: StoredPermission[]` (`apps/web/src/stores/thread-record.ts:48-53, 175`), with `addPermissionRequest` / `resolvePermissionRequest` at `threadStore.ts:4084-4118`. **Decisions vanish (verified):** the terminal runtime patch sets `permissions: []` (`threadStore.ts:2337`), and so does `discardLostProgress` (`:837`). Nothing is persisted.
- Hydration: pending approvals load only for the open thread. The auxiliary hydrator runs only when `state.currentThreadId === threadId` (`features/conversation/hydration/thread-hydrator.ts:1051-1055`, `auxiliary-hydrator.ts:83-96, 111-173`). After a reload, a background thread's approval is missing from the sidebar until the user opens it (verified chain). The sidebar derives `pendingPermissionThreadIds` from loaded records (`features/projects/ProjectTree.tsx:519-531`), then `ThreadStateMarker.tsx:63` shows "Action required" as an aria-label only.
- Card: `PermissionRequestCard.tsx` renders inline in the transcript as a volatile item (`virtual-items.ts:296-310, 523, 544-546`, renderer `TranscriptItemRenderer.tsx:102-110, 186`). It shows raw JSON (`:386-389`, `<pre>` at `:110`) and 24px controls (`h-6` at `:118, :125, :143`), has no keyboard handling, and arms after 600ms (`:350-357`). Questions use the same card (`:224-325`; S07-09 owns that).
- Status line: `NarrativeIndicator.tsx:122-132` shows the active tool's phase (`activity-label.ts:42-49`), so a blocked command reads as "Running a command…", not waiting.
- Access picker: the selected row draws an amber check `className="text-primary"` (`features/conversation/composer/ComposerOptionControls.tsx:98`). Labels are already Manual / Auto / Full access (`:31-35`).
- `components/chat/DiffViewer.tsx` (Pierre `PatchDiff`) has no callers (verified with `rg`). Pierre 1.4.1 supports `disableFileHeader`, `diffStyle: "unified"`, `overflow: "scroll"`, `disableLineNumbers`, `diffIndicators: "classic"`, and `unsafeCSS` (`dist/types.d.ts:332-352`), and its stylesheet reads `--diffs-font-features`.
- Composer seam: `ComposerContentSurface` renders plan preview → task bubble → queue → new-thread → input surface (`ComposerContentSurface.tsx:698-707`). The dock swaps in for `ComposerInputSurface` only. The draft lives in `composerDraftStore` (`docs/internals/conversation/composer-drafts.md`).
- Queue: the composer queue is client-only and in-memory (`stores/queueStore.ts`, item shape at `:15`, `enqueue` at `:80, 208`), and an errored turn clears it (`threadStore.ts:2687-2688`). S08F-05 owns queue retention. Mcode has no steer anywhere (`rg -i steer apps packages` is empty).

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Dock replaces composer, tray stays above | Inline transcript card | `ApprovalDock` swaps for `ComposerInputSurface`; editor stays mounted and hidden so the draft and caret survive | web |
| Title "Codex wants to run a command" | "Permission requested: {toolName}" | Web builds the title from `providerId` + `subject.kind` ("Wants to …" when the origin is a subagent) | contracts, web |
| Command block + facts line | Raw JSON `<pre>` | `subject: command {command, cwd, facts[]}`; web maps `cwd` to the worktree label | contracts, providers, web |
| File edit path row + 3-line diff | None; Codex/Cursor drop the diff | `subject: file_edit {files[{path, change, additions, deletions, patch?}]}`; `PatchDiff` preview; Open diff | contracts, providers, web |
| Numbered choices, keys, focused row | 24px buttons, no keys | `choices[]` stated by the adapter, keeping every genuine deny option (ACP `reject_once` and `reject_always`) with its own id and label; key map; arm delay | contracts, providers, web |
| "Allow for this session" only when statable | Always offered; Copilot = everything, Cursor = allow_always | Adapter emits an `allow_scoped` choice only with a statable scope; `description` when the scope is broader than the subject | providers |
| Scope shown in full | OpenCode cuts resource patterns | Scope fields are never truncated; a request whose scope cannot be stated within bounds fails closed | contracts, providers |
| "Tell X what to do instead…" | None | `respond({choiceId: noteChoiceId, note})`; per-adapter delivery `native`, `steer` or `next_turn`; delivery intent stored with the outcome, keyed by request id | contracts, server (DB), providers, web |
| 2 of 3 pager + subagent chip | Cards stack in the transcript | Ordered pending list per thread; `origin: subagent {label}` | contracts, providers, web |
| Submitting / Failed to send | "Failed to send response" only on RPC throw | `approval.respond` returns `resolved`, `not_pending` or `failed` | contracts, server, providers, web |
| Status line "Waiting for approval" | Tool phase label | Status-line state when the thread has pending approvals | web (S05 seam) |
| Receipts "Allowed once" / "Denied" persist | Cleared at turn end | `approvalDecided` event → `approval_receipts` table → narrative entry kind `approval` | contracts, providers, server (DB), web |
| Note as user bubble (06e) | None | Receipt carries `note`; rendered as a user bubble after the receipt when delivered native or steer | web |
| Sidebar "Approval required" for background threads | Only after opening the thread | `approval.listPending()` with no thread, at connect and reconnect | contracts, server, web |
| Invalid request | Dropped, agent hangs; Cursor deny can select an allow | Deny upstream and fix the Cursor fallback now (S06-00); then Auto-denied only after the provider acknowledges, else stop the owning turn (S06-01); durable receipt (S06-03) | server, providers, web |
| Access picker selected row neutral | Amber check | Neutral check via F-04 | web |
| Ligatures off in code | Default | `--diffs-font-features: "liga" 0, "calt" 0` on the preview; `font-variant-ligatures: none` on mono blocks | web |

## Backend architecture

One seam: an `ApprovalService` on the server and approval v2 at the adapter boundary. Adapters own all provider semantics: what the subject is, which choices exist and what they mean, how a deny note travels, and what the receipt says. The server validates, routes, and fails closed. The web renders. S06-00 first fixes the two live bugs on today's contract (the silent drop and the Cursor deny fallback). S06-01 then converts every consumer to v2 in one ticket; v2 is never split into adapter contracts that ship separately.

### 1. Approval request v2 (`packages/contracts/src/models/approval.ts`, replaces `permission.ts`)

```ts
export const ApprovalSubjectSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string().min(1).max(65_536),
    cwd: z.string().max(4_096).optional(),
    /** Short provider-stated facts, e.g. "network off". Rendered after the worktree label. */
    facts: z.array(z.string().min(1).max(80)).max(4).optional() }).strict(),
  z.object({ kind: z.literal("file_edit"), files: z.array(ApprovalFilePatchSchema()).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("fetch"), url: z.string().min(1).max(8_192) }).strict(),
  z.object({ kind: z.literal("tool"), toolName: z.string().min(1).max(200),
    /** Adapter-built rendering of the arguments being approved. Never the raw native payload. */
    preview: z.string().max(65_536).optional() }).strict(),
  z.object({ kind: z.literal("thread_operation"),
    operation: z.enum(["thread_create_batch", "thread_send", "thread_stop"]),
    /** The thread the operation acts on. The request itself shows on the owner thread (section 3). */
    targetThreadId: z.string(), targetTitle: z.string().max(200).optional(),
    message: z.string().max(THREAD_SEND_MESSAGE_MAX_LENGTH).optional() }).strict(),
  /** Body and UI owned by S07 (question dock). Moved here unchanged from PermissionQuestionSchema. */
  z.object({ kind: z.literal("question"), questions: z.array(ApprovalQuestionSchema()).min(1).max(10) }).strict(),
]));

export const ApprovalFilePatchSchema = lazySchema(() => z.object({
  path: z.string().min(1).max(4_096),
  change: z.enum(["edited", "added", "removed", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Unified diff for this file, display only. Absent when the provider sent none (Devin). */
  patch: z.string().max(262_144).optional(),
  /** True when the adapter clipped `patch`; the dock says the diff is clipped. */
  patchTruncated: z.boolean().optional(),
}).strict());

/** What a choice does. Drives the receipt and the deny-note row, never the label. */
export const ApprovalChoiceIntentSchema = z.enum(["allow_once", "allow_scoped", "deny", "provider"]);

export const ApprovalChoiceSchema = lazySchema(() => z.object({
  /** Adapter-owned and echoed on respond. The native option id where one exists (ACP `optionId`). */
  id: z.string().min(1).max(200),
  intent: ApprovalChoiceIntentSchema,
  label: z.string().min(1).max(200),       // "Allow once", "Allow for this session", "Reject always", "Switch to Bypass"
  /** Stated scope or consequence, never truncated. Shown only when it says more than the subject (Devin, Claude rules, OpenCode patterns). */
  description: z.string().min(1).max(500).optional(),
}).strict());

export const ApprovalOriginSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("subagent"), label: z.string().min(1).max(200),
    parentToolCallId: z.string().max(256).optional() }).strict(),
  /** An external integration with no source thread (thread operations only). Label source inferred. */
  z.object({ kind: z.literal("integration"), label: z.string().min(1).max(200) }).strict(),
]));

/** Display and decision data built from native input. Untrusted until validated. */
export const ApprovalRequestBodySchema = lazySchema(() => z.object({
  toolCallId: z.string().max(256).optional(),
  requestedAt: z.string(),                 // ISO; orders the pager
  reason: z.string().max(1_000).optional(),// provider-stated, display only (Codex reason, Claude decisionReason, Copilot intention)
  subject: ApprovalSubjectSchema(),
  /** Ordered as rendered. At least one deny-intent choice (questions excepted). Every genuine provider deny option is kept. */
  choices: z.array(ApprovalChoiceSchema()).min(1).max(10),
  noteDelivery: z.enum(["native", "steer", "next_turn", "none"]),
  /** The deny choice the note row answers with. Required unless noteDelivery is "none". */
  noteChoiceId: z.string().min(1).max(200).optional(),
  origin: ApprovalOriginSchema(),
}).strict());

/** What clients receive: routing identity from adapter state plus the validated body. */
export const ApprovalRequestSchema = lazySchema(() => ApprovalRequestBodySchema().extend({
  requestId: z.string().min(1).max(256),
  /** Owning thread: its dock and sidebar row show the request. For thread operations, the owner thread. */
  threadId: z.string().min(1),
  /** Taken from the emitting provider, never from the body. Null only with origin "integration". */
  providerId: ProviderIdSchema.nullable(),
}).strict().superRefine(denyChoicesAndNoteChoice));
```

```ts
// packages/contracts/src/providers/interfaces.ts
/** Routing identity comes from adapter state, never from the native payload. */
export interface ApprovalRequestEnvelope {
  readonly requestId: string;   // the id the adapter answers with: the native id, or one it minted
  readonly threadId: string;    // owning thread, from the adapter's session map
  readonly body: unknown;       // validated by ApprovalRequestBodySchema
}
```

Routing and display are separate. The adapter supplies `requestId` and `threadId` from its pending map and session state; Devin already mints the id and takes the thread from its session entry (`devin-provider.ts:770-771`). The server takes `providerId` from the emitting provider. Only `body` comes from native data, so a malformed body never stops Mcode from answering the request it belongs to.

`denyChoicesAndNoteChoice` requires at least one deny-intent choice, except for questions, and requires `noteChoiceId` to name a deny-intent choice whenever `noteDelivery` is not `"none"`. ACP's `reject_once` and `reject_always` are two genuine choices with different meanings, so both stay, each with its native option id and label. An adapter adds a synthetic deny choice only when the provider offered none (section 7).

**Scope is never truncated.** A field that states what the user authorizes is sent whole or not at all. Scope fields are the command, `cwd` and `facts`, every file path and the file list, the URL, the tool name and `preview`, the thread operation's target and message, and each choice's label and description. Bounds are set so real requests fit: a command or tool preview up to 65,536 characters, and the thread message reuses `THREAD_SEND_MESSAGE_MAX_LENGTH` (`packages/contracts/src/thread-control.ts:515`). The dock may clip long text visually with the fade, but the wire value is complete. When a subject field would exceed its bound, the adapter fails closed with `autoDeny: "too_large"` (section 4). When only a scoped choice's description is too long, the adapter omits that choice, and it never omits a deny choice. Only display-only fields may be clipped, and they say so: `patch` with `patchTruncated`, and `reason`. OpenCode's resource truncation (`opencode-permission-mapper.ts:47-55, 86`) is retired by this rule; its option-label rule (`:102-104`) is the precedent.

### 2. Decision, outcome, wire

```ts
"approval.respond": {
  params: z.object({ requestId: z.string(), choiceId: z.string().min(1).max(200),
    note: z.string().trim().min(1).max(4_000).optional(),   // valid only with a deny-intent choice (normally noteChoiceId)
    answers: ApprovalAnswersSchema().optional() }),            // question kind only (S07)
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), noteDelivery: z.enum(["native", "steer", "next_turn"]).optional() }),
    z.object({ status: z.literal("not_pending") }),           // decided elsewhere, or session ended → drop from dock
    z.object({ status: z.literal("failed"), message: z.string().max(500) }), // → "Your answer didn't reach Codex."
  ]),
},
"approval.listPending": { params: z.object({ threadId: z.string().optional() }), result: z.array(ApprovalRequestSchema()).max(500) },

// Note delivery (S06-07, section 6)
"approval.listQueuedNotes": { params: z.object({}),
  result: z.array(z.object({ requestId: z.string(), threadId: z.string(), note: z.string() })).max(500) },
"approval.updateNote": { params: z.object({ requestId: z.string(), note: z.string().trim().min(1).max(4_000) }),
  result: z.object({ status: z.enum(["updated", "not_queued"]) }) },
"approval.removeNote": { params: z.object({ requestId: z.string() }),
  result: z.object({ status: z.enum(["removed", "not_queued"]) }) },
// "agent.send" params (methods.ts:1033) gain approvalNoteRequestId?: string

// channels (global broadcast, like today)
"approval.requested": ApprovalRequestSchema(),               // upsert by requestId (a late diff re-emits)
"approval.resolved": z.object({ requestId: z.string(), threadId: z.string(), outcome: ApprovalOutcomeSchema() }),

export const ApprovalOutcomeSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed"), intent: z.enum(["allow_once", "allow_scoped", "provider"]), choiceLabel: z.string().max(200) }),
  z.object({ status: z.literal("denied"), choiceLabel: z.string().max(200), note: z.string().max(4_000).optional(),
    noteDelivery: z.enum(["native", "steer", "next_turn"]).optional() }),
  z.object({ status: z.literal("answered"), count: z.number().int().min(1) }),           // S07
  z.object({ status: z.literal("cancelled"), reason: z.enum(["session_stopped", "turn_ended", "unanswerable"]) }),
  z.object({ status: z.literal("auto_denied"), reason: z.enum(["unreadable", "too_large"]) }),
]));
```

Provider interface (`packages/contracts/src/providers/interfaces.ts`, replaces `:200-227`):

```ts
resolveApproval?(requestId: string, response:
  | { choiceId: string; note?: string; answers?: ApprovalAnswers }
  | { autoDeny: "unreadable" | "too_large" }): Promise<ApprovalRespondResult>;
  // "resolved" only after the native answer is acknowledged (section 4); "not_pending" when unknown
listPendingApprovals?(threadId?: string): ApprovalRequestEnvelope[];  // bodies raw; the server validates
on(event: "approval_request", handler: (envelope: ApprovalRequestEnvelope) => void): void;
on(event: "approval_resolved", handler: (p: { requestId: string; threadId: string; outcome: ApprovalOutcome }) => void): void;
```

### 3. `ApprovalService` (`apps/server/src/features/agents/approvals/approval-service.ts`)

It replaces `permission-publication.ts` and `agent-permission-service.ts`. Providers keep their pending maps, as they do today. The service's own state is the note table (section 6) and a map of in-flight responds keyed by request id, which coalesces concurrent answers to one request.

- **Publish:** subscribe to `approval_request`, validate `body` with `ApprovalRequestBodySchema`, compose `{ requestId, threadId, providerId: provider.id, ...body }`, then broadcast `approval.requested` and `portPush`. On failure, use the fail-closed path (section 4).
- **Respond:** route to the provider holding `requestId` (the same loop as `agent-permission-service.ts:27-32`) and return its result. `ThreadControlService.respondToApproval` is tried first, as today (`agent-rpc.ts:194-197`).
- **List:** fan out to `listPendingApprovals(threadId?)` on every provider plus `ThreadControlService.listPendingApprovals`, which needs an all-threads variant (inferred API addition). Validate each body. An invalid item goes down the fail-closed path and is omitted. The list never throws because of one item.
- **Thread operations belong to the owner thread.** `ThreadControlService` publishes through `ApprovalService.publish` instead of calling `broadcast("permission.request")` directly (`thread-control-service.ts:555-560, 669-673, 1344-1348`). The envelope's `threadId` is today's `ownerThreadId` (`:558`): the source thread when an Mcode agent asked, and the target thread only for an external integration, which has no source thread. The target goes in the `thread_operation` subject. `providerId` is the source agent's provider (`authority.sourceProviderId`, `thread-control-mcp-authority.ts:8, 21`) with `origin: agent`; an external integration gets `providerId: null` and `origin: integration`. `listPendingApprovals` lists by owner only, replacing today's target-or-source union (`:1156-1160`), so each request shows on exactly one thread. S01-03's approval waiting source reads this same list, so the dock and the sidebar marker always agree.

### 4. Fail closed

Mcode never leaves an agent waiting on a request the user cannot see, and never reports a denial the provider did not receive.

1. **Unreadable or too large.** When `body` fails validation, `ApprovalService` calls `provider.resolveApproval(requestId, { autoDeny: "unreadable" })`. When an adapter finds a subject field over its bound while building the body, it takes the same path itself with `"too_large"` and emits no pending request. The adapter sends its native deny (table below). It returns `resolved` only once that deny is acknowledged, and only then emits `approval_resolved { auto_denied }` and the receipt.
2. **The deny is not acknowledged.** The adapter returns `failed`, or throws. `ApprovalService` stops the owning turn with `AgentService.stopSession(threadId)` (`agent-rpc.ts:149`). The session drain resolves the pending entry as `cancelled { reason: "unanswerable" }` with its receipt. A provider that ignores the stop is killed after its settle timeout, as Devin's is (`devin-provider.ts:108-113`; the same guarantee for every adapter is inferred).
3. **No routing identity.** When a native request lacks what the adapter must answer with, the adapter cannot reply upstream. The known case is an OpenCode ask without a usable `id` (`opencode-permission-mapper.ts:80-81`). The adapter aborts the owning turn natively, publishes a `cancelled { unanswerable }` receipt under an id it mints, and emits no pending request. This replaces OpenCode's `emitAskDiagnostic` for permissions.

| Provider | Native deny | Acknowledged when |
|---|---|---|
| Claude | `deny` with the message "Mcode could not display this permission request" | the `canUseTool` callback settles with the deny while the query is live (inferred) |
| Codex | `decline` | the JSON-RPC response is written to a live app-server connection |
| ACP (Cursor, Devin) | `reject_once` when offered, else the `cancelled` outcome | the `requestPermission` promise resolves on an open connection |
| Copilot | `denied-no-approval-rule-and-could-not-request-from-user` | the permission handler returns the deny to a live session (inferred) |
| OpenCode | `reject` | the HTTP reply succeeds (`replyPermission` and its failure branch, `opencode-provider.ts:442-485`) |

Receipt copy: "Denied automatically · Mcode couldn't read this request", "Denied automatically · too large to show", and "Stopped · Mcode couldn't answer this request" (copy open, Risks 1). The server logs `providerId`, `requestId`, and the zod issue paths and codes only, never values, because the payload can hold secrets.

Until S06-03 lands receipts, the visible record is the S06-00 stand-in: a server-built request with a fixed title and no provider payload, published and then resolved, so the open thread shows a settled card. `ApprovalService` keeps it until S06-03 replaces it with the receipt and deletes it.

### 5. Persisted receipts

- Event: add `ApprovalDecided: "approvalDecided"` to `AgentEventType` (`packages/contracts/src/events/agent-event.ts:20-46`) with `{ threadId, requestId, toolCallId?, kind, subjectLabel, outcome, origin? }`. `subjectLabel` is a short adapter-built string: the command, the file name, the host, or the tool name. A fail-closed receipt (`auto_denied`, `cancelled { unanswerable }`) uses a fixed label, because its body was unreadable or too large to show.
- Emission: each adapter publishes it through its own `CanonicalLiveEventPublisher` with the turn routing it already holds (`packages/providers/src/private/canonical-live-event-publisher.ts:14-19, 58-75`). That keeps it ordered with that turn's tool events. One shared builder, `packages/providers/src/approvals/approval-receipt.ts`, keeps six call sites to one line each.
- Durable path: whitelist the type in `validNarrativeEvent` (`apps/server/src/features/agents/canonical/canonical-execution-semantic-writer.ts:1656-1663`) and project it into a new `approval_receipts` table. The projection follows `hook_executions` (`apps/server/src/runtime/persistence/sqlite/schema.ts:535-553`; writer branch `canonical-execution-semantic-writer.ts:885-930`):

```ts
export const approvalReceipts = sqliteTable("approval_receipts", {
  id: text("id").primaryKey().notNull(),               // = requestId (idempotency key)
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  toolCallId: text("tool_call_id"),
  kind: text("kind").notNull(),
  subjectLabel: text("subject_label").notNull(),
  outcome: text("outcome").notNull(),                   // JSON ApprovalOutcome
  origin: text("origin"),                               // JSON ApprovalOrigin | null
  decidedAt: text("decided_at").notNull().default(timestampDefault),
  sortOrder: integer("sort_order").notNull(),           // shares the message's narrative sort sequence
}, (t) => [index("idx_approval_receipts_message_sort_order_id").on(t.messageId, t.sortOrder, t.id)]);
```

  Generate the migration with `bun run db:generate` (`docs/internals/persistence/db-migrations.md`).
- Read: add `"approval"` to `NarrativeDetailKindSchema` (`packages/contracts/src/models/narrative-entry.ts:52-57`) and interleave receipts by sort order in `NarrativeStore.load` (`apps/server/src/features/agents/conversation/narrative/narrative-store.ts:270-290`; tools, narration, and hooks already interleave that way). Also add an `approvals` list to `narrative.list` (`agent-rpc.ts:187-191`).
- Idempotency: a second write with identical content is a no-op; conflicting content throws and logs. This is the goal-receipt prior art at `apps/server/src/features/agents/turns/turn-conversation-write-operations.ts:29-36`.
- `ThreadControlService` is not a provider adapter and holds no turn routing, so thread-operation approvals write no narrative receipt in this section. ThreadControl's audit trail stays.

### 6. Deny with a note

The web sends `respond({ choiceId: noteChoiceId, note })`. The adapter delivers the note according to its declared `noteDelivery`:

- `native`: the note travels in the deny itself (Claude `message`, Copilot `feedback`).
- `steer`: Codex `decline`, then `turn/steer { threadId, expectedTurnId, input: [{type: "text", text: note}] }`. A child thread steers that child's turn (inferred). If steer fails because the turn ended, the id mismatched, or the method is unsupported, the adapter returns `noteDelivery: "next_turn"`.
- `next_turn`: deny now, and send the note as the next message on that thread. It waits in the composer queue tray, stays editable and removable, and sends when the turn ends. This matches the 05e queued follow-up.

The note must survive a lost response, a provider error, a reconnect and a duplicate answer, so its delivery intent is stored with the approval outcome before the adapter is called. One row per request id:

```ts
export const approvalNotes = sqliteTable("approval_notes", {
  requestId: text("request_id").primaryKey().notNull(),     // dedupe key = the approval's request id
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  delivery: text("delivery"),                                // native | steer | next_turn; null until the adapter answers
  state: text("state").notNull(),                            // pending | queued | delivered | removed
  createdAt: text("created_at").notNull().default(timestampDefault),
  updatedAt: text("updated_at").notNull().default(timestampDefault),
});
```

- **Respond with a note.** `ApprovalService` inserts the row as `pending` through the database writer, then calls the adapter. A second respond for the same request id while the first is in flight waits for the first result instead of calling the adapter again. A later respond with the same note replays the stored result. A different note for an already-answered request returns `failed` ("This request was already answered").
- **Adapter result.** `resolved` with `native` or `steer` sets `delivered`. `resolved` with `next_turn` sets `queued`. `failed` leaves `pending`, and the dock keeps the note in its input for Try again.
- **Lost response.** When a retry gets `not_pending` from the adapter and the row is `delivered` or `queued`, the service returns the stored `resolved` result, not `not_pending`. When the row is still `pending` and nothing is in flight, the adapter's outcome is unknown, so the row becomes `queued` and the result says `next_turn`. On server start, every `pending` row becomes `queued`, because the provider session that held its request is gone. A note can then arrive twice, but it is never lost; the user can remove the extra copy.
- **Restore.** On connect and reconnect, next to `approval.listPending()`, the web calls `approval.listQueuedNotes()` and puts each note in its thread's queue unless an item with that `approvalNoteRequestId` is already there. Queue items gain `approvalNoteRequestId` (`queueStore.ts:15`). Editing a note calls `approval.updateNote`; removing it calls `approval.removeNote` (state `removed`), so a removed note does not come back on the next reconnect.
- **Send once.** `agent.send` carries `approvalNoteRequestId`. Turn admission marks the row `delivered` with `WHERE state = 'queued'` in the same transaction that projects the user message, beside `consumeRetry` (`canonical-parent-turn-lifecycle.ts:88-91`). When no row changes, admission fails with `note_already_delivered`, and the client drops its copy because another window already sent it.
- **Queue retention is S08F-05's.** An error or turn ending never silently clears queued input; the queue pauses visibly with an explicit send. S06-07 adds no clearing path of its own.

The receipt records `note` and the final `noteDelivery`. The web renders the note as a user bubble after the receipt only for `native` and `steer`. For `next_turn` the queued message becomes the real user message, so the bubble is not duplicated.

### 7. Per-provider decisions

| | Claude | Codex | Cursor (ACP) | Copilot | Devin (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| Subject | Bash → command; Edit/Write/MultiEdit/NotebookEdit → file_edit; WebFetch → fetch; else tool | commandExecution/execCommand → command (`facts` from `networkApprovalContext`, inferred); fileChange/applyPatch → file_edit; permissions → tool | `toolCall.kind`: execute → command; edit/delete/move → file_edit; fetch → fetch; else tool | shell → command; write → file_edit; url → fetch; read/mcp/memory/custom-tool → tool | command when `_meta` editable command exists (`devin-acp-event-mapper.ts:658-663`), else tool | bash → command; edit → file_edit; webfetch → fetch; else tool (action names inferred) |
| `toolCallId` | `options.toolUseID` | `params.itemId` | `toolCall.toolCallId` | `native.toolCallId` | `toolCall.toolCallId` | `tool.callID` (inferred) |
| Diff | Build the patch from `old_string/new_string`/`content` with `createTextPatch` (`packages/shared/src/git/text-patch.ts:4-18`). For Write, read the current file inside the worktree, bounded (inferred) | Cache `item/started` and `item/fileChange/patchUpdated` changes by `itemId`. If the diff lands after the request, re-emit `approval.requested` with the same id (arrival order inferred) | `content[]` `{type:"diff", path, oldText, newText}` → `createTextPatch` | `diff` (unified) | none; omit `patch` | `metadata.diff` (inferred; verify) |
| Session choice | Only when `suggestions` is non-empty. Rewrite every update's `destination` to `"session"`; description from the rules (e.g. `Bash(npm test:*)` → "npm test commands") | `acceptForSession`; statable for commands (this command) and files (these files); no description | No generic session row. ACP options verbatim: `allow_once` → allow_once, `allow_always` → provider (Cursor's own label), and `reject_once` and `reject_always` → two deny rows, each with Cursor's label and option id. `noteChoiceId` is `reject_once` when offered. No reject option → Mcode adds one deny choice that answers `cancelled`, never `options[0]` (fixed first in S06-00) | Replace the global `sessionApproval` with scoped grants: shell when `canOfferSessionApproval` (scope = `commands[].identifier`), url (host), mcp (server/tool). None for write/read | Verbatim as today; kind → intent, so both reject kinds are deny rows; keep hiding `allow_always_global`; "Switch to Bypass" stays provider intent with its description | `always` → allow_scoped with every `resources` pattern, untruncated, as the description; omitted when there are no resources or the patterns exceed the bound (session semantics inferred) |
| Deny note | native `message` | steer → fallback next_turn | next_turn | native `feedback` | next_turn | next_turn (native if the v2 reply accepts `message`; inferred, verify) |
| Origin | `options.agentID` → subagent, label from the matching subagent tool call (`tool_call_records.subagent_agent_id`, inferred mapping) | `params.threadId` ≠ the root native thread → subagent, label from child thread metadata (inferred) | agent | agent | agent | agent (child sessions not routed; inferred) |
| Unreadable or too large | deny with message | decline | `reject_once` or `cancelled` | `denied-no-approval-rule-…` | `reject_once` or `cancelled` | reject; an ask without `id` aborts the turn (replaces the diagnostic-only path) |

## Components

### New

- `apps/web/src/features/conversation/approvals/ApprovalDock.tsx`: the dock shell (header, subject, choices, note row, error line). It mounts in `ComposerContentSurface` in place of `ComposerInputSurface` when the active thread has pending approvals, and has a live region (`aria-live="assertive"` announcing the title; DESIGN.md "Announce … incoming permission requests").
- `ApprovalSubject.tsx`: `CommandSubject`, `FileEditSubject` (path row with F-02 fade, plus `ApprovalPatchPreview` = Pierre `PatchDiff` with `disableFileHeader`, `diffStyle: "unified"`, `overflow: "scroll"`, `disableLineNumbers`, `diffIndicators: "classic"`, a 60px max-height clip with the fade, ligatures off), `FetchSubject`, `ToolSubject`, `ThreadOperationSubject`.
- `ApprovalChoiceRow.tsx` (key chip, label, optional description, submitting spinner), `ApprovalNoteRow.tsx` (inline input reading "Tell {Provider|the subagent} what to do instead…"), `ApprovalPager.tsx` ("‹ N of M ›" with 32px hit areas around 14px glyphs).
- `features/conversation/narrative/ApprovalReceiptRow.tsx`: a 28px receipt row with the narrative entry kind `approval`.
- `stores/approvalStore.ts`: pending approvals by thread, ordered by `requestedAt`, plus `activeIndex` and `submission: {requestId, choiceId, state: "submitting" | "failed", message?}`.
- Server: `features/agents/approvals/approval-service.ts`, `approval-receipt-repo.ts`, `approval-note-repo.ts`, and the `approval_receipts` and `approval_notes` schemas and migrations.
- Providers: `packages/providers/src/approvals/approval-receipt.ts` (event builder), `acp-approval-choices.ts` (ACP kind → intent mapping shared by Cursor and Devin, one row per genuine option), `approval-scope.ts` (the shared "whole or fail closed" check every adapter runs on scope fields), and `tool-input-subject.ts` (Claude input → subject and patch).

Keyboard (active only while focus is inside the dock; the dock takes focus on mount only if focus was in the composer editor or on `body`):

| Key | Action |
|---|---|
| `1`–`9` | Choose that row; the note row's number focuses its input |
| `↑` / `↓` | Move the focused row |
| `Enter` | Choose the focused row |
| `[` / `]` | Previous or next request when several wait |
| Note input `Enter` | Deny with the note |
| Note input `Shift+Enter` | Newline |
| Note input `Esc` | Back to the rows |

Keep the 600ms arm delay from `PermissionRequestCard.tsx:350-357` for pointer and keys. Also ignore digit keys that arrive within 600ms of the last composer keystroke, so typing a "1" into the draft cannot approve anything.

### Changed

- `ComposerContentSurface.tsx:698-707`: swap in the dock; keep the editor mounted and hidden.
- Status line (`NarrativeIndicator.tsx`, through S05's status-line ticket): a `waiting` state renders the dot and "Waiting for approval".
- `ProjectTree.tsx:519-531`, `ThreadSearchView.tsx:80-96, 186`, and `lib/thread-status.ts:28-38, 64-74`: read `approvalStore` (rename `hasPendingPermission` → `hasPendingApproval`). S01 owns the visuals.
- Adapters: all six (table above). `ThreadControlService` publishes through `ApprovalService` with the owner thread as `threadId` and lists by owner only.
- Note delivery (S06-07): `QueuedMessage` (`stores/queueStore.ts:15`) gains `approvalNoteRequestId`; `agent.send` (`packages/contracts/src/ws/methods.ts:1033`) gains the same optional param; turn admission marks the note delivered beside `consumeRetry` (`canonical-parent-turn-lifecycle.ts:88-91`).
- `AccessModeSelector` (`ComposerOptionControls.tsx:98`): neutral selected row through F-04.
- `docs/internals/providers/provider-architecture.md:211-216` (Devin "Permissions pass through verbatim"): rewrite it as a short "Approvals" section covering choice intents, scope rules, and deny-note delivery per adapter. This is cross-adapter reasoning a maintainer would get wrong without it.

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| Silent drop of a permission request that fails validation, and the test that pins it | `permission-publication.ts:24-31`; `permissions/__tests__/permission-publication.test.ts:51` | Deny upstream with a settled stand-in card, or stop the turn | S06-00 | `rg -n "does not publish malformed provider permission events" apps/server/src` empty |
| Cursor deny fallback to `options[0]` | `cursor-acp-permission-mapper.ts:73` | `cancelled` when no option of the decided kind exists | S06-00 | `rg -n "optionId \?\? options\[0\]" packages/providers/src/private/cursor` empty |
| `PermissionRequestSchema`, `PermissionDecisionSchema`, `PermissionRequestOptionSchema`, `PermissionRequest`/`PermissionDecision` types; `permission.ts` renamed and question schemas moved | `packages/contracts/src/models/permission.ts`, `index.ts:895-911`, `thread-control.ts:4, 472` | `models/approval.ts` | S06-01 | `rg -n "PermissionRequestSchema\|PermissionDecisionSchema\|PermissionRequestOptionSchema\|models/permission" apps packages -g '!*.ndjson'` empty (the Copilot SDK's own `PermissionRequest` type stays, so the bare type name is not searched; typecheck proves the contract types are gone) |
| `permission.request` / `permission.resolved` channels; `permission.respond` / `permission.listPending` methods | `ws/channels.ts:206-212`, `ws/methods.ts:1153-1167`, `agent-rpc.ts:62-63, 194-201`, `server-bootstrap.ts:898-905`, `ws-transport.ts:1240-1248`, `ws-events.ts:621-646` | `approval.*` | S06-01 | `rg -n "permission\.(request\|resolved\|respond\|listPending)" apps packages -g '!*.ndjson'` empty |
| `resolvePermission`, `listPendingPermissions`, `permission_request`/`permission_resolved` events | `providers/interfaces.ts:200-227` and all six adapters | `resolveApproval`, `listPendingApprovals`, `approval_*` | S06-01 | `rg -n "\bresolvePermission\b\|\blistPendingPermissions\b\|permission_re(quest\|solved)" apps packages -g '!*.ndjson'` empty |
| `permission-publication.ts`, `agent-permission-service.ts` (+ tests) | `apps/server/src/features/agents/permissions/` | `approvals/approval-service.ts` | S06-01 | `rg --files apps/server/src/features/agents/permissions \| rg -v scoped-pre-grant` empty |
| `synthesizeCodexPermissionRequest`, `synthesizeCursorAcpPermissionRequest`, `synthesizeOpenCodePermissionRequest`, `mapDecisionToAcpOutcome`, `mapPermissionDecisionToReply` | codex, cursor, opencode mappers | v2 mappers per adapter | S06-01 | `rg -n "synthesize\w*PermissionRequest\|mapDecisionToAcpOutcome\|mapPermissionDecisionToReply" apps packages -g '!*.ndjson'` empty |
| OpenCode resource truncation (`boundStringList`) | `opencode-permission-mapper.ts:47-55, 86` | Whole scope or fail closed (`approval-scope.ts`) | S06-01 | `rg -n "boundStringList" apps/server/src/features/providers/adapters/opencode` empty |
| OpenCode `emitAskDiagnostic` permission branch (a notice with no upstream answer) | `opencode-provider.ts:1067-1068` | Turn abort with a `cancelled { unanswerable }` outcome; the question path keeps the diagnostic until S07 | S06-01 | `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-provider-permissions.test.ts` passes with the unanswerable-ask case (the name `emitAskDiagnostic` stays for questions) |
| Web `StoredPermission`, `ThreadRecord.permissions`, `addPermissionRequest`, `resolvePermissionRequest`, `hasPendingPermissions`, `respondToPermission`, `listPendingPermissions` | `thread-record.ts:48-53, 175, 263`; `threadStore.ts:490-492, 837, 2337, 4084-4118, 4363-4369`; `transport/types.ts:435`; `hydration/types.ts:55` | `approvalStore` | S06-01 | `rg -n "StoredPermission\|addPermissionRequest\|hasPendingPermissions\|respondToPermission" apps/web/src` empty |
| Auxiliary permission hydration (`hydratePermissions`, `permissionSnapshotGenerations`, `pendingPermissionHydrations`, `invalidatePermissions`, `invalidatePermissionSnapshots`) | `auxiliary-hydrator.ts:48-76, 95, 111-173`; `threadStore.ts:4085, 4101` | App-wide `approval.listPending()` on connect | S06-02 | `rg -n "PermissionSnapshot\|hydratePermissions" apps/web/src` empty |
| `hasPendingPermission` props and `pendingPermissionThreadIds` | `ProjectTree.tsx`, `ThreadSearchView.tsx`, `ThreadStateMarker.tsx:52-63`, `lib/thread-status.ts` | `hasPendingApproval` from `approvalStore` | S06-02 | `rg -n "hasPendingPermission\|pendingPermissionThreadIds" apps/web/src` empty |
| S06-00 unreadable-request stand-in | `approvals/approval-service.ts` (moved there from `permission-publication.ts` by S06-01) | `auto_denied` and `cancelled { unanswerable }` receipts | S06-03 | `rg -n "publishUnreadableStandIn\|UNREADABLE_APPROVAL_TITLE" apps packages -g '!*.ndjson'` empty |
| `SettledPermissionRequest`, `badgeVariantFor`, `decisionLabel` | `PermissionRequestCard.tsx:47-80, 391-393` | `ApprovalReceiptRow` | S06-03 | `rg -n "SettledPermissionRequest\|decisionLabel" apps/web/src` empty |
| `PendingPermissionRequest`, `PendingOptionsRequest`, `OptionButton`, allow-mode dropdown; approval items in the transcript (`permissionRequestItems` keeps only `kind: "question"`) | `PermissionRequestCard.tsx:82-222, 397-400`; `virtual-items.ts:544-546` | `ApprovalDock` | S06-04 | `rg -n "PendingPermissionRequest\|PendingOptionsRequest\|Allow in session" apps/web/src -g '!*.test.*'` empty (the question card's test file goes with S07-09) |
| `PermissionRequestCard.tsx` (question branch), `"permission-request"` virtual item, `PermissionRequestTranscriptItemRenderer`, size estimate, vlist probe row, `PermissionRequestCard.test.tsx` | `components/chat/`, `virtual-items.ts:296-310, 612-613, 660`, `TranscriptItemRenderer.tsx:102-110, 186`, `message-list-virtualization.ts:25`, `performance/vlist-react-adapter-prototype.tsx:7, 157-160` | Question dock | S07-09 | `rg -n "PermissionRequestCard\|permission-request" apps/web/src` empty |
| `components/chat/DiffViewer.tsx` (no callers) | web | `ApprovalPatchPreview` | S06-05 | `rg --files apps/web/src/components/chat \| rg DiffViewer` empty |
| Codex `fileChangeToolInput` diff drop; `CompletedItem.changes` type without `diff` | `codex-event-mapper.ts:1415-1421`, `codex-types.ts:405` | Changes cache with `diff` | S06-05 | `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts` passes with a case asserting `diff` survives (the function name stays) |
| Cursor conformance validator requiring `toolCall` keys `["title"]` | `packages/providers/src/conformance/fixture-safety.ts:363-379` | Validator accepting `toolCallId`, `kind`, `content`, `rawInput` | S06-05 | `bun run --cwd packages/providers test -- src/conformance/__tests__/conformance.test.ts` passes with a Cursor fixture carrying diff content |
| Copilot `sessionApproval` flag | `copilot-provider.ts:115, 291, 311` | Scoped grant set | S06-06 | `rg -n "sessionApproval" packages/providers` empty |
| Claude verbatim `updatedPermissions: options?.suggestions` | `claude-provider.ts:1166-1171` | Session-scoped rewrite | S06-06 | `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-provider-permission-mode.test.ts` passes with a case asserting every destination is `"session"` |
| Claude fixed "User denied" message | `claude-provider.ts:1173` | Note or default message | S06-07 | `rg -n "User denied" packages/providers` empty |
| Amber `text-primary` check in the access picker | `ComposerOptionControls.tsx:98` | F-04 neutral check | S06-09 | `rg -n "Check size=\{13\} className=\"text-primary\"" apps/web/src` empty |

## Proposed tickets

### S06-00 Fail closed on unreadable approvals and fix Cursor deny

- **Blocked by:** None (can start immediately).
- **Reconciled:** Small first fix, before the v2 contract: Cursor deny never selects an allow option, and a request that fails validation is denied upstream with a visible receipt instead of hanging the agent.
- **Boards:** none (bug fix on today's contract and card).
- **Delivers:** Two live bugs end before the v2 conversion starts. A permission request that fails validation no longer vanishes while the agent waits forever. Mcode answers Deny through the provider, and the open thread shows a settled card titled "Mcode couldn't read this request". When the provider cannot take the Deny, Mcode stops the turn and the card settles as Cancelled. On Cursor, Deny never selects an allow option.
- **Build notes:**
  - Server, `permission-publication.ts:24-31`. Parse routing (`requestId`, `threadId`) with its own small schema before the full `PermissionRequestSchema`. On a full-schema failure with valid routing, `publishUnreadableStandIn` first broadcasts a server-built `permission.request` for that id and thread: tool name "Unreadable request", the fixed title `UNREADABLE_APPROVAL_TITLE` ("Mcode couldn't read this request"), empty input, and nothing copied from the payload. It then calls the emitting provider's `resolvePermission(requestId, "deny")` and broadcasts `permission.resolved` with `deny`. When that call returns `false` or throws, it broadcasts `cancelled` instead and calls `AgentService.stopSession(threadId)` (`agent-rpc.ts:149`). The stand-in is published before the resolution so the card never sticks in a pending state; a second resolution from the adapter for the same id is harmless. The card uses today's settled rendering, so there are no web changes.
  - When routing itself fails, log at error level with the provider id only. Every adapter builds `requestId` and `threadId` from its own state (for example `devin-provider.ts:770-771`), so this is a programming error; S06-01 makes it unrepresentable with the routing envelope.
  - Log provider id, request id and zod issue paths and codes only. Today's line logs `parsed.error.message` (`:26-29`), which can echo values.
  - Cursor, `cursor-acp-permission-mapper.ts:65-77`. Delete the `options[0]` fallback. A decision with no option of its kind answers `{ outcome: "cancelled" }`, and the bridge reports `cancelled`, not the user's decision (`cursor-acp-client-bridge.ts:68-75`). `reject_once` stays preferred over `reject_always` for Deny.
  - Known limit, closed by S06-01: OpenCode relays its reply over HTTP after `resolvePermission` returns (`opencode-provider.ts:442-485`), so a failed relay there is still only logged. OpenCode's own unreadable-ask path (`opencode-provider.ts:1067-1068`) never reaches the server; S06-01 handles it with the routing rule.
- **Deletes:** ledger rows marked S06-00.
- **Acceptance criteria:**
  - [ ] A fake provider emitting a request that fails `PermissionRequestSchema` but carries `requestId` and `threadId` receives `resolvePermission(requestId, "deny")`. Clients receive the stand-in request and then `permission.resolved` with `deny`. The agent is not left waiting.
  - [ ] When the fake provider returns `false` (or throws), clients receive `cancelled` and `stopSession` is called for that thread.
  - [ ] The log line names the provider, request id and failing paths, and contains no field value from the payload.
  - [ ] Cursor: Deny with only allow options answers `cancelled` and reports `cancelled`. Deny with `reject_once` and `reject_always` selects `reject_once`. Allow with only reject options answers `cancelled`.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/permissions/__tests__/permission-publication.test.ts` (rewrite the "does not publish malformed" case to assert the fail-closed path). `bun run --cwd packages/providers test -- src/private/cursor/acp/__tests__/cursor-acp-permission-mapper.test.ts`. No live check: an invalid request cannot be produced from the UI, so the server test drives a fake provider through the real publication code.

### S06-01 Approval v2 contract, ApprovalService, fail-closed path

- **Blocked by:** S06-00 Fail closed on unreadable approvals and fix Cursor deny.
- **Boards:** none directly; enables all 06 boards.
- **Delivers:** Approvals still look as they do today, but every request is typed by kind with a `toolCallId`, provider id, adapter-stated choices, and origin. Routing identity comes from adapter state, so a malformed request can still be answered. Every genuine deny option is kept. An unreadable or oversized request is auto-denied only after the provider acknowledges the deny; if the deny cannot be delivered, the owning turn stops. Approval scope is never truncated. A failed answer reports failure. Thread-operation approvals show on the owner thread only.
- **Build notes:** Builds on S06-00: its fail-closed path and stand-in move into `ApprovalService`, now with routing from the envelope and an awaited adapter result. Contracts `approval.ts` plus wire (Backend 1–2). Server `ApprovalService` (Backend 3–4), with thread control routed through it by owner thread. Adapters emit `ApprovalRequestEnvelope` with the data each already has; no new native fields yet, except ids that are free (`toolUseID`, `itemId`, ACP `toolCallId`, Copilot `toolCallId`). Every adapter runs scope fields through `approval-scope.ts` (whole or `too_large`), which retires OpenCode's resource truncation. The ACP choices helper is shared by Cursor and Devin and keeps `reject_once` and `reject_always` as separate deny rows. `resolveApproval` becomes async and returns `resolved` only after the native answer is acknowledged (Backend 4 table); OpenCode returns `failed` when the relay throws. In the web, migrate transport, `ws-events`, and the store to `approvalStore`, and point the existing card at v2 fields (temporary, deleted in S06-03/S06-04). Test at the `ApprovalService` seam with a fake provider registry, and at each adapter's public boundary with recorded native payloads.
- **Deletes:** ledger rows marked S06-01.
- **Acceptance criteria:**
  - [ ] Malformed display data: a body that fails `ApprovalRequestBodySchema` reaches the adapter as `autoDeny: "unreadable"`. `approval.resolved { auto_denied }` is broadcast only after the fake provider acknowledges the deny. The log line has no payload values.
  - [ ] Rejection transport failure: when the fake provider's deny returns `failed` or throws, the server calls `stopSession` for the owning thread and the pending entry ends `cancelled { unanswerable }`. Nothing is left waiting and no `auto_denied` is broadcast.
  - [ ] Missing routing data: an OpenCode ask without a usable `id` aborts the turn and publishes no pending request.
  - [ ] Oversized scope: a 70,000-character command, and an OpenCode ask whose resources exceed the bound, are auto-denied with `too_large`. No shortened value reaches a client. An OpenCode `always` description is never cut.
  - [ ] Two reject options: an ACP request offering `reject_once` and `reject_always` yields two deny choices with Cursor's labels and option ids. Choosing `reject_always` sends that option id, and the outcome carries its label.
  - [ ] `approval.listPending` returns the valid items when one provider item is invalid.
  - [ ] Cursor "allow once" never selects `allow_always`.
  - [ ] `approval.respond` returns `not_pending` for an unknown id and `failed` when OpenCode's reply throws.
  - [ ] Owner thread: a supervised `thread_send` from thread A to thread B is published with `threadId` A and B in the subject. `approval.listPending({ threadId: "B" })` does not return it.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/approvals/__tests__/approval-service.test.ts` (prior art `permissions/__tests__/permission-publication.test.ts`, `transport/__tests__/agent-rpc-route.test.ts`). Provider mapper tests: `bun run --cwd packages/providers test -- src/__tests__/codex/codex-permission-mapper.test.ts src/private/cursor/acp/__tests__/cursor-acp-permission-mapper.test.ts src/private/devin/__tests__/devin-provider.test.ts`, and `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-permission-mapper.test.ts src/features/providers/adapters/opencode/__tests__/opencode-provider-permissions.test.ts`. Live: `agent:up`, then a Codex thread in Manual on `.dev/fixture-repo` asking for `bun run lint` shows the current card, and Allow resumes.

### S06-02 Approvals load for background threads

- **Blocked by:** S06-01 Approval v2 contract, ApprovalService, fail-closed path; S01-03 Thread attention facts on the server.
- **Boards:** 06f (`200I-2`); sidebar row `DBN-0`/`EUU-0`.
- **Delivers:** After an app reload or reconnect, every thread with a pending approval is flagged in the sidebar without being opened. S01 renders "Approval required"; S09 toasts consume `approval.requested` for non-active threads.
- **Build notes:** on connect and reconnect, call `approval.listPending()` with no thread to replace `approvalStore`. Live `approval.requested/resolved` patch it. Delete the auxiliary permission hydration. The sidebar consumers read `hasPendingApproval`.
- **Deletes:** ledger rows marked S06-02.
- **Acceptance criteria:**
  - [ ] With thread B waiting and thread A open, reloading the renderer flags B within one round trip.
  - [ ] A WebSocket reconnect does not duplicate or drop pending items.
  - [ ] Resolving B from another client clears B's flag.
- **Verify:** `bun run --cwd apps/web test -- src/stores/__tests__/approvalStore.test.ts src/transport/ws-events.test.ts` (prior art `__tests__/threadStore-reconnect-queue.test.ts`, `hydration/__tests__/auxiliary-hydrator.test.ts`). Live (Electron): start an approval in thread B, open A, reload with Ctrl+R; B's row is flagged.

### S06-03 Decision receipts persist on the timeline

- **Blocked by:** S06-01 Approval v2 contract, ApprovalService, fail-closed path.
- **Boards:** 06d (`2733-2`), 06e receipt (`27E4-2`), Decided records (`13PT-0`).
- **Delivers:** "Allowed once `bun run lint`", "Allowed for this session …", "Denied …", "Cancelled · session stopped …", "Denied automatically …", "Stopped · Mcode couldn't answer this request", and "Answered 2 questions" rows sit in the narrative where the decision happened and survive turn end, thread switch, and reload.
- **Build notes:** Backend 5. The adapters call the shared receipt builder on every resolve path, including session drains (`cancelled`) and the fail-closed outcomes (`auto_denied` after acknowledgement, `cancelled { unanswerable }`). Add the schema, migration, and repo, plus the writer branch, narrative entry kind, and `narrative.list` field. Web `ApprovalReceiptRow` uses the Paper values. Stop relying on `terminalRuntimePatch` for decision display. Delete the S06-00 stand-in now that the receipt is the durable record.
- **Deletes:** `SettledPermissionRequest` and friends; the S06-00 unreadable-request stand-in.
- **Acceptance criteria:**
  - [ ] A receipt renders live, then from DB after a reload, in the same position relative to tool rows.
  - [ ] A duplicate `approvalDecided` delivery writes one row.
  - [ ] Stopping a session with a pending approval writes a "Cancelled · session stopped" receipt.
  - [ ] An auto-denied request leaves a "Denied automatically" receipt that survives a reload; a deny that failed leaves the "Stopped" receipt instead, never "Denied".
  - [ ] Devin's "Switch to Bypass" receipt and Cursor's "Reject always" receipt show those labels verbatim.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/__tests__/agent-storage-write.test.ts` plus narrative load tests under `features/agents/conversation/narrative/__tests__/`. Web: `src/__tests__/virtual-items.test.ts`. Live: allow a command, switch threads and back, reload; the receipt is still there.

### S06-04 Approval dock replaces the composer

- **Blocked by:** S06-01 Approval v2 contract, ApprovalService, fail-closed path; S06-03 Decision receipts persist on the timeline; S05-02 Status line: labels, clock and holding states; S05-09 Composer tray with the task row; F-01b Token vocabulary rename; F-02 Fade truncation primitive; F-06 Provider icon and disc stack.
- **Boards:** 06a (`27P2-2`), 06c (`2864-2`), components `13F0-0`/`13QO-0` (Command, Tool permission, Provider options, Another thread, Submitting, Failed to send).
- **Delivers:** Pending approvals show in the dock under the task tray, with the provider title, subject, numbered choices, keys, pager, submitting and failed states, and "Waiting for approval" in the status line. Deciding the last one restores the composer with the draft intact.
- **Build notes:** web only, apart from the status-line state through S05's seam. Approvals leave the transcript; questions stay there until S07-09. Exact values are under Boards. The note row renders but stays disabled until S06-07, and only when `noteDelivery !== "none"`.
- **Deletes:** pending branches of `PermissionRequestCard`.
- **Acceptance criteria:**
  - [ ] Pressing `1` allows once; arrows plus Enter work; digits within 600ms of the dock mounting or of the last composer keystroke are ignored.
  - [ ] "2 of 3" follows `requestedAt` order; deciding advances to the next.
  - [ ] Submitting dims the other rows to 0.45; a `failed` result shows "Your answer didn't reach {Provider}." and Try again resends the same choice.
  - [ ] Focus is not stolen from the terminal or the browser panel.
  - [ ] Screen readers announce the request.
  - [ ] Dock width follows the composer column at 760 and 520 with no clipping of the choices.
  - [ ] Two deny rows (ACP `reject_once` and `reject_always`) each take their own number and send their own choice id.
  - [ ] A supervised `thread_send` from thread A to thread B shows the dock on A, reading "{Provider} wants to message another thread" with B's title in the subject. B shows no dock.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/approvals/__tests__/ApprovalDock.test.tsx` (prior art `components/chat/PermissionRequestCard.test.tsx`, `features/conversation/messages/__tests__/MessageList.thread-switch.test.tsx`). Live (Electron, Manual, Codex, fixture repo): ask for two commands in parallel, page with `]`, allow with `1`, deny with `3`; capture before and after screenshots.

### S06-05 File edit approvals show the diff

- **Blocked by:** S06-04 Approval dock replaces the composer.
- **Boards:** 06b (`28FL-2`), 06g (`2CTD-2`), components File edit `13GG-0`.
- **Delivers:** Edit approvals show the filename (ink) and folder (muted, faded), `+N −N` pinned right, and about 3 diff lines that never wrap and scroll sideways. Open diff shows the full patch.
- **Build notes:** adapter diff sources per the table: Codex itemId cache with re-emit on a late diff; Claude via `createTextPatch`; Cursor ACP `content` diff; Copilot `diff`; OpenCode `metadata.diff` (verify first; omit if absent). Web `ApprovalPatchPreview` uses Pierre `PatchDiff` with the options in Components, `--diffs-font-features` ligatures off, and the F-02 fade. Update the Cursor conformance validator and fixtures.
- **Deletes:** `DiffViewer.tsx`; the Codex diff drop.
- **Acceptance criteria:**
  - [ ] For each of Codex, Claude, Cursor, and Copilot, a fixture produces `file_edit.files[0].patch`.
  - [ ] A 500-character line clips with the fade and scrolls horizontally.
  - [ ] `=>` renders as two glyphs.
  - [ ] A diff over 3 lines shows Open diff, which opens the full patch.
  - [ ] A Devin edit shows the path row without a diff block.
- **Verify:** `bun run --cwd packages/providers test -- src/__tests__/codex/codex-provider-permission.test.ts src/private/cursor/acp/__tests__/cursor-acp-event-mapper.test.ts src/private/copilot/__tests__/copilot-factory.test.ts`; the conformance harness (`src/conformance/harness.ts`). Live: in Manual, ask Codex to edit a file in the fixture repo; the dock matches 06b, and at a narrow window it matches the 06g 520 state.

### S06-06 Session scope only when it can be stated

- **Blocked by:** S06-04 Approval dock replaces the composer.
- **Boards:** 06a row 2; components Provider options (`13IN-0`).
- **Delivers:** "Allow for this session" appears only where the adapter can say what it covers. Broader scopes carry a description line. No adapter grants more than it states.
- **Build notes:** per-adapter rules in Backend 7: the Claude destination rewrite, Copilot scoped grants, Cursor verbatim options, OpenCode patterns, Codex as is. Update `provider-architecture.md`.
- **Deletes:** Copilot `sessionApproval`; Claude verbatim suggestions.
- **Acceptance criteria:**
  - [ ] Claude with no suggestions shows no session row, and the forwarded `updatedPermissions` all use the `"session"` destination.
  - [ ] Copilot session-approving `git status` does not auto-approve a write.
  - [ ] Cursor never shows "Allow for this session"; its `allow_always` option shows Cursor's own label.
  - [ ] An OpenCode ask with `resources: ["git *"]` shows the description "git *".
- **Verify:** `bun run --cwd packages/providers test -- src/private/claude/__tests__/claude-provider-permission-mode.test.ts src/private/copilot/__tests__/copilot-factory.test.ts`; `bun run --cwd apps/server test -- src/features/providers/adapters/opencode/__tests__/opencode-provider-permissions.test.ts`. Live: Copilot in Manual; allow a shell command for the session, then ask for an edit; the edit still prompts.

### S06-07 Deny with a note

- **Blocked by:** S06-03 Decision receipts persist on the timeline; S06-04 Approval dock replaces the composer; S08F-05 End notice and Retry.
- **Reconciled:** Persists note-delivery intent with the approval outcome, deduplicated by request id, so a lost response or reconnect cannot drop the note.
- **Boards:** 06e (`27E4-2`), row 4 on 06a/06b/06c.
- **Delivers:** "Tell Codex what to do instead…" takes a note. The deny receipt appears, and then either the note appears as a user bubble and the agent adjusts in the same turn (Claude, Copilot, Codex), or the note waits in the queue tray and sends when the turn ends (Cursor, Devin, OpenCode, and Codex steer fallback). The note is never lost: a dropped response, a provider error, a reload or a second window cannot drop or duplicate it.
- **Build notes:** Backend 6. The `approval_notes` table, migration and repo; `ApprovalService` stores the delivery intent with the outcome before calling the adapter, coalesces concurrent responds by request id, and replays the stored result on retry. Add `approval.listQueuedNotes`, `approval.updateNote` and `approval.removeNote`, the `approvalNoteRequestId` queue field and `agent.send` param, and the conditional `delivered` update at turn admission. Codex `turn/steer` gated by capability, falling back to next_turn. The web enqueues on `noteDelivery: "next_turn"` and on restore, deduplicated by request id. Subagent requests read "Tell the subagent…". Queue retention on errors and endings is S08F-05's; this ticket relies on it and adds no clearing path.
- **Deletes:** Claude "User denied".
- **Acceptance criteria:**
  - [ ] A Claude deny note arrives as the deny `message`.
  - [ ] A Copilot note arrives as `feedback`.
  - [ ] A Codex note steers the active turn, or queues when the turn ended.
  - [ ] An ACP note queues and sends exactly once.
  - [ ] Lost RPC response: the server resolves the deny and the reply is dropped. Try again returns `resolved` with the stored delivery, and the note is delivered or queued exactly once.
  - [ ] Immediate provider error: the dock shows "Your answer didn't reach {Provider}." with the note still in the input, and Try again delivers it once.
  - [ ] Reconnect: after a reload, a queued note is back in the queue tray. An edit made before the reload survives. A removed note does not come back.
  - [ ] Duplicate response: two responds for one request (a double press or two windows) call the adapter once and deliver the note once.
  - [ ] Two clients sending the same queued note produce one user message; the second send fails with `note_already_delivered` and its queue item is dropped.
  - [ ] A server restart with a note still `pending` keeps the note as a queued item.
  - [ ] An empty note is impossible: Enter on an empty input does nothing.
  - [ ] No duplicate bubble for queued notes.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/approvals/__tests__/approval-notes.test.ts` (new; real SQLite, prior art `src/features/thread-control/persistence/__tests__/thread-writer.integration.test.ts`) for lost response, provider error, restart, duplicate respond and the admission check. Provider tests above. `bun run --cwd apps/web test -- src/__tests__/queueStore.test.ts src/__tests__/threadStore-reconnect-queue.test.ts` for restore and dedupe. Live: Codex in Manual on `.dev/fixture-repo`; deny `bun run lint` with "Only lint the web app"; 06e appears. Then, on an ACP provider available locally, deny with a note, reload before the turn ends, and confirm the note is still queued and sends once.

### S06-08 Subagent origin on approvals

- **Blocked by:** S06-04 Approval dock replaces the composer; F-06 Provider icon and disc stack.
- **Boards:** 06c (`2864-2`), components Subagent request (`13M5-0`).
- **Delivers:** A subagent's request shows "Wants to run a command" with the provider icon and subagent name, and is counted in "N of M".
- **Build notes:** Claude `agentID` → subagent tool call label; Codex child-thread `params.threadId` → child metadata label. Other adapters send `origin: agent`.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] Claude and Codex fixtures with child requests produce `origin.subagent.label`.
  - [ ] The chip uses the 16px provider icon (F-06), not a badge.
- **Verify:** `packages/providers` Claude and Codex permission tests. Live: Claude in Manual dispatching a subagent that runs a command.

### S06-09 Access-mode picker selected row is neutral

- **Blocked by:** F-04a Menu primitive.
- **Boards:** composer chip "Manual" on 06d/06e.
- **Delivers:** The access picker marks the selected mode with a neutral check like the model picker. The chip reads Manual for supervised threads.
- **Build notes:** `AccessModeSelector` adopts the F-04 picker row.
- **Deletes:** the amber check.
- **Acceptance criteria:**
  - [ ] No `--color-primary` in the picker.
  - [ ] Manual, Auto, and Full access labels are unchanged.
- **Verify:** an F-04 picker test plus a live screenshot of the open picker.

## Tests

- Contract: rename `packages/contracts/src/models/__tests__/permission.test.ts` to `approval.test.ts`. Cover the bounds, at least one deny-intent choice, `noteChoiceId` naming a deny choice, two deny choices accepted, the `note` length, and the outcome union.
- Server, highest seam: `ApprovalService` with a fake `IProviderRegistry` covering publish, respond results, list fan-out, the owner-thread rule, and the fail-closed ladder: malformed display data, missing routing data, oversized scope, a deny that is acknowledged, and a deny whose transport fails (prior art `apps/server/src/features/agents/permissions/__tests__/permission-publication.test.ts`). The RPC route: `features/agents/transport/__tests__/agent-rpc-route.test.ts`. Persistence: `features/agents/__tests__/agent-storage-write.test.ts`, the narrative load tests, and `approval-notes.test.ts` against a real SQLite file for lost response, provider error, restart, duplicate respond and the admission check.
- Adapters: test at each adapter's public `resolveApproval`/event boundary with recorded native payloads. The conformance harness covers Cursor ACP (`packages/providers/src/conformance/harness.ts:246-297`). Fixtures need a diff, a reject-less option set, an option set with both `reject_once` and `reject_always`, an OpenCode ask without `id`, and an oversized command and resource list.
- Web: `ApprovalDock` component tests for keys, arm delay, pager, submitting, failed, focus, and two deny rows. `approvalStore` tests for snapshot plus live events and reconnect. `queueStore` tests for restored notes and dedupe by request id. `virtual-items` and `MessageList.thread-switch` for receipts and the removal of approvals from the transcript.
- Live: `bun run --shell system agent:up --desktop`, then `bun run agent:ready`, using only `.dev/fixture-repo` in Manual mode. Per provider available locally: command, edit, deny with note, two in parallel, reload. Report a provider that is not installed or signed in locally as pending, not passed, and label recorded fixtures as captured-trace evidence rather than real-provider proof. Capture screenshots for the PR with the Electron live-testing harness.

## Risks and open questions

1. **Fail-closed copy** (user). The behavior is settled: auto-deny only after the provider acknowledges the deny, otherwise stop the owning turn, and never truncate scope (review C6). The receipt wording is open: "Denied automatically · Mcode couldn't read this request", "Denied automatically · too large to show", and "Stopped · Mcode couldn't answer this request".
2. **Next-turn note delivery for Cursor, Devin, and OpenCode** (user). Queueing means the agent continues the turn before reading the note. The alternative is to stop the turn and send the note now, which interrupts other parallel work. Recommendation: queue.
3. **Stop while the dock is up** (user, design). Paper's dock has no Stop, and the dock replaces the composer that hosts Stop. Proposal: the existing Stop shortcut and turn menu keep working, and stopping writes "Cancelled · session stopped" receipts. Confirm or add a Stop control to the dock.
4. **Open diff placement and target** (design). The decision exists (`screen-pass-todo.md:41`), but no dock board draws it; it appears only on the Buttons board. Proposal: a text button at the diff block's bottom-right that opens the full `PatchDiff` in a dialog, because pending edits are not in the worktree, so the Review panel cannot show them.
5. **Multi-file edit requests** (design). Codex `fileChange` can hold several files, and Paper draws one. Proposal: the first file, with the path row showing "+N files"; Open diff shows all.
6. **Cursor on Windows is locked to Full access** (user; fact to check live). `cursor-permission.ts` assumes the old print transport. ACP now has a per-tool gate, so Manual may work on Windows. If it does, unlocking it belongs in S06-01.
7. **Revoking session grants** (user; reverse state). There is no UI. Grants end with the provider session (inferred for Claude session rules, Codex's approval cache, Copilot's scoped set, and OpenCode `always`). Decide whether a "Clear session approvals" action is needed.
8. **Copilot carries a native deny reason** (fact; implementer verifies). This corrects the locked note, which says only Claude does. The intent, getting the note to the agent, is unchanged. OpenCode v2 `reject` with `message` is unverified.
9. **Claude suggestions can name persistent destinations** (implementer verifies with a fixture). Today "Allow in session" may write `.claude/settings.local.json` rules (inferred from SDK types). S06-06 forces `session`.
10. **Integration-origin thread operations** (ThreadControl owner). Thread operations show on the owner thread (decided; Backend 3). An external integration has no source thread, so its request shows on the target thread with `origin: integration` and no provider (`thread-control-service.ts:558`). The integration label's source is unverified.
11. **Ending copy for a fail-closed stop** (S08F-05 owner). `AgentService.stopSession` carries no reason today, so a stop that Mcode starts after a failed deny could end the turn as "You stopped", which is false. Proposal: pass a stop reason that S08F renders as "Stopped by Mcode"; the `cancelled { unanswerable }` receipt explains why.
12. **Section seams:** the S05 status line and task tray own the visual rows S06 plugs into. S07-09 owns the question kind body and deletes the rest of `PermissionRequestCard`. S01 owns the sidebar visuals and reads the owner-thread pending list (S01-03). F-07b's lane and S09-02 consume `approval.requested` for toasts. S08F-05 owns queue retention that S06-07's queued notes rely on. A change of ticket ids there must update the "Blocked by" lines here.
