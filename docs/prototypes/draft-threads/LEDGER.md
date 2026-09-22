# SureForge ledger — draft-threads prototype

Tier: **Full** (explicitly requested). Owner: Devin. Reviewer: fresh-context subagent.

## Contract v1 (locked via /agents:grilling, user confirmed)

Feature: thread drafts. Source: replaces/fixes GitHub issue #1731 scope in same PR.

Locked decisions:
1. Scope: draft rows for NEW threads + persisted drafts for existing threads (fixes 1731 via same mechanism).
2. Drafts per project: uncapped.
3. First keystroke materializes a draft row; emptying the composer removes it; leaving keeps it.
4. Persist: text, mentions, model/provider/reasoning, interaction mode, worktree/branch target, AND attachments. Amendment (user, post-review): attachments must survive restart — the real app already spills them to disk (`sourcePath`/`spillAppDataPath`), so only preview URLs need rebuilding.
5. Sidebar: draft rows pinned above real threads, `Draft` label + truncated first-line preview + relative time, no status dot, visually muted vs real rows.
6. Store: localStorage keyed by workspace. Cross-client sync out of scope.
7. Send consumes draft into a real thread; delete is instant, no confirm.
8. Draft ordering: last-edited first.
9. Click draft → composer bound to it; "new thread" always starts a fresh draft, never merges.
10. Workspace removal deletes its drafts.
11. Out of scope: branch-from-message drafts.
12. Amendment (user, post-review): existing-thread drafts persist and restore into the composer, but the project tree shows NO draft indicator on real thread rows. Draft rows in the sidebar are for new-thread drafts only.

## Prototype question

Does this state model feel right when driven — materialize, persist, restore, consume, delete, multi-draft ordering — and does the muted `Draft` row treatment read as not-yet-real next to real thread rows?

Branch: LOGIC (shareable single-file HTML, pure state module + thin shell). The shell renders a mini sidebar + composer using DESIGN.md dark tokens so the visual treatment is judgeable while driving the model.

## Deliverable

`docs/prototypes/draft-threads/index.html` — self-contained, double-click to open, no build, no backend, no real localStorage (simulated persisted store is rendered visibly so "restart" is inspectable).

## Coverage denominator (inspection units)

| ID | Unit |
|---|---|
| U1 | First keystroke in a new-thread composer creates a draft row |
| U2 | Emptying the composer removes its draft row |
| U3 | Navigating away preserves the draft |
| U4 | Multiple drafts per project, uncapped; "new thread" starts a fresh draft, no merge |
| U5 | Draft rows pinned above threads, ordered last-edited first |
| U6 | Draft row anatomy: `Draft` label, muted preview, relative time, no status dot, distinct from real rows |
| U7 | Clicking a draft binds the composer to it (text + config restored) |
| U8 | Send consumes the draft; a real thread appears |
| U9 | Delete removes a draft instantly |
| U10 | Restart restores drafts from the persisted store |
| U11 | Existing-thread drafts persist across restart (1731 semantics) |
| U12 | Workspace removal cleans up its drafts |
| U13 | Draft remembers composer config (model, mode, worktree target) |
| U14 | Attachments survive restart (restored from persisted disk-path metadata) |
| U15 | Visual: DESIGN.md dark slate tokens, amber reserved for primary action, no chips/dots on drafts |

Environments: file:// double-click in Chromium (puppeteer), plus source inspection.

## Plan

1. Build `index.html`: pure `DraftModel` module (dispatch + state) + shell rendering sidebar/composer/persisted-store panels + free-play buttons + guided scenario tabs.
2. Owner checks (execute gate): (a) drive every scenario + all free-play actions in a real browser via puppeteer, screenshot evidence; (b) static source inspection — module purity, token fidelity, no dead controls; (c) adversarial sequences not in scenarios (delete-all on open draft, send-empty, remove-workspace-with-open-draft, second workspace isolation).
3. Independent review: fresh-context subagent, reviewer brief, contract + artifact path, 3 self-chosen methods.
4. Deliver: report per deliver.md format.

---

# Implementation Phase (production)

## Architecture decision record

- **Owner model**: composer owner = `{kind:"thread"|"draft"|"new"}`. Thread owners key `composerDraftStore.drafts[threadId]` (unchanged keys). Draft owners key `threadDraftStore.drafts[draftId]` (new store). `new` is ephemeral; first sendable content materializes a draft entity whose id is pushed to `workspaceStore.activeDraftId`, which arrives as the `draftId` prop next render. No remount needed; owner transitions reuse the existing transition+resolve pair.
- **1731 fix**: persist-on-change effect gated on `restoredDraftOwnerRef.current === ownerKey` (skips the mount pass before session restore, so a stored draft with attachments is never wiped by the pre-restore empty state). Replaces "save only on owner switch" for both owner kinds; store is always current, so unmount/remount/refresh/restart all restore.
- **Selection state**: `workspaceStore.activeDraftId`. `openThreadDraft(workspaceId, draftId)` restores `newThread*` target fields from the entity (bypasses `setPendingNewThread`'s reset). `setActiveThread`, `beginNewThread`, `setActiveWorkspace`, `deleteWorkspace`, `removeWorkspaceFromState` clear `activeDraftId`; the two workspace-removal paths also call `removeWorkspaceDrafts`.
- **Composer prop**: `draftId?: string | null`. `null` = tracked fresh new-thread (NewThreadSurface only). `undefined` = untracked (PullRequestForkDialog, which must not leak drafts into the sidebar).
- **Send consumption**: `clearSubmittedDraft` removes the draft entity and stashes it in `submittedDraftClearRef`; `restoreFailedDispatch` recreates it. Existing `composerDraft` pass-through in pending-thread creation still restores text into the placeholder thread on later failure.
- **Attachments**: persist `PendingAttachment` minus `previewUrl` (rebuilt as `""` on rehydrate, matching queued-message restore). `filePath`/spill paths are durable. Rehydrate sanitizes `spillAppDataPath` (reject `..`/absolute) so draft deletion can never release files outside the spill dir.
- **Persistence**: zustand `persist` + `createJSONStorage(localStorage)` per `modelFavoritesStore` convention. Keys `mcode-composer-drafts` (thread drafts) and `mcode-thread-drafts` (entities), v1, sanitizing merge, quota-safe storage adapter.

## File plan

1. `apps/web/src/lib/composer-draft-storage.ts` (new): serialize/parse `ComposerDraft` + `PendingAttachment`, spill-path sanitize, safe storage adapter.
2. `apps/web/src/stores/composerDraftStore.ts`: export `draftHasNoSendableContent` + attachment release helper; add `persist` for `drafts`.
3. `apps/web/src/stores/threadDraftStore.ts` (new): `ThreadDraft` entity `{id, workspaceId, createdAt, updatedAt, draft, selection, target}`; `saveDraft` (create/upsert, deep-equal skip, empty→remove), `removeDraft`, `restoreDraft`, `removeWorkspaceDrafts`.
4. `apps/web/src/lib/composer-session/index.ts`: `ComposerSession` gains optional `orchestrationMode`/`approvalReviewMode`; export saved-session builder for draft owners.
5. `composer-session-lifecycle.ts`: owner union replaces `threadId` in transition/resolve.
6. `useComposerFormController.ts`: `draftId` option, owner plumbing, persist effect, materialization, send-consume + rollback, selectionRef.
7. `useComposerAttachments.ts`: `draftId` in preparation-invalidation context.
8. `Composer.tsx`: `draftId` prop passthrough.
9. `useChatViewState.ts` + `ChatViewSurface.tsx`: `activeDraftId` → `<Composer draftId>`.
10. `workspaceStore.ts`: `activeDraftId`, `openThreadDraft`, `discardThreadDraft`, `setActiveDraftId`, clearing + `removeWorkspaceDrafts` in teardown paths.
11. `ProjectTree.tsx`: `ThreadDraftRow` (Draft label + muted preview + relative time, no dot, hover/context delete), rows pinned above threads in `WorkspaceThreadSection` active view.

## Coverage denominator (unchanged contract, 15 units) + new unit

Same 15 units as prototype contract plus U16: PR-fork dialog composer does not materialize drafts. Live proof bar: real Electron/browser session driving production UI (type→row→navigate→reload→open→send→delete→workspace-delete→1731 settings round-trip), plus focused vitest regressions.
