# Codex branch + PR #484 merge plan

PR [#484](https://github.com/Mzeey-Empire/mcode/pull/484) (`fix/claude-provider-thoughts`) is **merged to `main`** (commit `c906a265`). This branch (`feat/openai-codex`) is **18 commits behind `main`** with Codex work mostly in the **working tree** (uncommitted). It adds the Codex provider, `isFinalResponse` on `TextDelta`, collab nesting, and `codex_fast_mode`.

Goal: merge `main` into this branch without losing Codex mapper behavior or PR #484 narrative fixes.

## What this branch changes (Codex-focused)

| Area | Change |
|------|--------|
| `codex-event-mapper.ts` | Maps `item/reasoning/*`, `item/plan/delta`, collab nesting, tool-state `isFinalResponse` on `item/agentMessage/delta`, `turnEnded` latch, silenced lifecycle methods |
| `codex-provider.ts` | Persistent app-server session, turn wait, trace hook |
| `threadStore.ts` | `isFinalResponse` rAF batching; thought segment merge/reopen; `codexFastMode` per thread |
| Contracts / DB | `codex_fast_mode` on `threads` (migration `0007_bitter_taskmaster`) |
| Docs | `codex-narrative-spec.md`, `codex-app-server-trace.md`, `CODEX-NARRATIVE-NOTES.md` |
| Tests | Expanded `codex-event-mapper.test.ts`, narrative nesting tests |

Evidence-backed trace: `docs/guides/codex-app-server-trace.md` (codex-cli 0.130.0). Sub-agent (`collabAgentToolCall`) paths are unit-tested but not yet in live traces.

## What PR #484 changes (overlap risk)

| Area | PR #484 change | Codex impact |
|------|----------------|--------------|
| `packages/contracts` | `AssistantMessageBoundary` event | Codex does not emit it today; must not break WS routing |
| `agent-service.ts` | `dropOpenThought()`, boundary handler | Codex still uses `isFinalResponse` on `TextDelta`; both can coexist |
| `threadStore.ts` | `session.assistantMessageBoundary` handler | **High conflict**: same file as Codex `textDelta` / thought logic |
| `build-narrative.ts` | Final text as `delta` row when `isFinalResponse` stream present | **Aligns with Codex** if `streamingText` still receives final deltas only |
| `NarrativeFlow.tsx` | Whisper layout, actions molecule, footer after body | Codex tools/thoughts must still render; no mapper change required |
| `ThoughtBlock.tsx` | Delegates to `DeltaBlock` | Thoughts may look like body prose (intentional in PR #484) |
| `virtual-items.ts` | `persisted-turn-footer`, `StreamingResponseRow` | Verify live Codex turn still shows streaming + footer |
| `messages.model` column | Migration `0007_lowly_moondragon` | **Blocks**: this branch already has `0007_bitter_taskmaster` |

## Recommended merge order

1. **Merge `main` into `feat/openai-codex`** (or rebase onto latest `main`). PR #484 is already on `main`; no separate PR merge step.
2. Resolve conflicts in the order below.
4. Run protocol capture + tests (see Verification).
5. Manual smoke: one Codex thread with tools and (if possible) sub-agents.

Do **not** merge Codex into PR #484's branch first unless you want a smaller PR #484 diff; merging PR #484 into the Codex feature branch keeps all Codex work in one place.

## Conflict resolution checklist

### 1. Drizzle migration `0007` (must fix)

- PR #484: `0007_lowly_moondragon.sql` adds `messages.model`.
- This branch: `0007_bitter_taskmaster.sql` adds `threads.codex_fast_mode`.

**Resolution:** Keep PR #484 as `0007_lowly_moondragon`. Codex `codex_fast_mode` ships as **`0009_fancy_ben_urich`** (generated after merge). Both columns coexist.

### 2. `threadStore.ts` (manual merge)

Keep **all** of the following:

- From PR #484: `session.assistantMessageBoundary` (flush pending deltas, drop/close open thought).
- From Codex branch: `PendingTextChunk.isFinalResponse`, rAF flush, thought reopen/continuation merge, `codexFastMode` in settings/sendMessage.

**Rule:** `assistantMessageBoundary` is Claude-only today. Codex classification stays on `isFinalResponse` from the mapper. Do not route Codex through boundary unless Codex later emits that event.

### 3. `agent-service.ts`

- Keep PR #484 `dropOpenThought` and boundary subscription.
- Keep Codex-related send paths (`codex_fast_mode`, any Codex-specific persist behavior).

### 4. Narrative UI (`build-narrative.ts`, `NarrativeFlow.tsx`, `virtual-items.ts`)

- Take PR #484 layout (footer after body, `StreamingResponseRow`, Whisper styling).
- Re-run unit tests: `build-narrative*.test.ts`, `virtual-items.test.ts`, `parallel-subagent-nesting.test.ts`.
- Confirm `buildNarrativeItems` still treats `streamingText` with final-only surplus as `delta` (Codex final stream).

### 5. `codex-event-mapper.ts`

- No changes required from PR #484 unless `threadStore` contract for `isFinalResponse` changes.
- After merge, re-run `codex-event-mapper.test.ts` and protocol coverage test.

### 6. `packages/contracts/src/events/agent-event.ts`

- Add `AssistantMessageBoundary` from PR #484.
- Keep `TextDelta.isFinalResponse` (already on main/Codex branch).

## Post-merge verification

```sh
# Unit
cd apps/server && bun run test
cd apps/web && bun run test

# Typecheck
(cd apps/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)

# Live protocol capture (optional; needs codex CLI + auth)
node scripts/codex-protocol-capture.mjs <cwd> apps/server/src/providers/codex/__tests__/fixtures/codex-protocol-golden.ndjson

# Replay fixture through mapper
cd apps/server && bun run test src/providers/codex/__tests__/codex-protocol-coverage.test.ts
```

### Manual smoke (after PR #484 UI)

1. Codex turn, text only: prose streams in `StreamingResponseRow` or equivalent; no duplicate thought copy of final answer.
2. Codex turn with `echo` command: tools in actions group; final reply below footer.
3. Codex turn with sub-agents (if CLI fires collab): child commands nested under Agent rows.
4. Thread reload: persisted narrative matches live run.

## Risk register

| Risk | Mitigation |
|------|------------|
| PR #484 retires italic thoughts; Codex reasoning looks like body text | Accept Whisper design; rely on position (above tools) not dimming |
| `assistantMessageBoundary` never fires for Codex | Rely on `isFinalResponse`; document in `codex-narrative-spec.md` |
| Empty `turn.items` | Do not implement reorder-from-items; trust live notification order |
| Parallel collabs | Mapper returns no parent when `collabScopeStack.length > 1` |
| Trailing deltas after `turn/completed` | `turnEnded` latch on mapper; verify after merge |

## Files safe to treat as Codex-only after merge

- `apps/server/src/providers/codex/**`
- `scripts/codex-*.mjs`
- `docs/guides/codex-*.md`
- `packages/contracts` Codex provider types / `codex_fast_mode` on thread schema

## Owner sign-off

- [ ] Migration `0008` applied on fresh DB and existing dev DB
- [ ] `bun run test` green in server + web
- [ ] Golden protocol fixture updated or sub-agent section marked unverified
- [ ] One headed Codex chat smoke on merged branch
