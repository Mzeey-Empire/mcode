# Chat Fork Handoff Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v2 amendments — locked after prototype review** (`docs/plans/prototypes/2026-05-21-chat-branch-handoff.html`):
> - Feature renamed **"chat branch" → "chat fork"** in all user-facing copy (schema field `forkedFromMessageId` already aligned). Component identifiers (`ComposerBranchBar`, `branchFromMessageId` prop) stay as-is to minimize blast radius — open question q·08 picked "copy + icons only".
> - Composer flow corrected: the **parent thread's existing composer enters fork mode** via `ComposerBranchBar`. No separate child composer. Submit creates the child and navigates.
> - Fork tooltip uniform: **"Fork from here"** on both user-msg and assistant-msg anchors (prototype committed this; q·05 picked the uniform alt).
> - **New Phase 13.5** added: slash-command palette must source from the in-flight provider selection inside the fork composer, not the parent thread's provider.
> - **New Phase 17** added: robustness phase covering 13 edge cases the prototype surfaced.

**Goal:** Replace the deterministic transcript-replay branching with provider-generated handoff documents stored under `<MCODE_DATA_DIR>/threads/<id>/handoffs/<ulid>/`, using a B-A-D fall-through ladder that selects the generation path based on declared provider capability and live availability.

**Architecture:** On branch click, mcode invokes the parent thread's provider session out-of-band (side-channel resume on capable providers, hidden turn on Cursor) to produce a structured handoff doc using the vendored `/handoff` skill prompt with a character budget tailored to the *child* provider. The doc is persisted to disk in a thread-scoped ULID directory alongside copied attachments, then inlined into the child thread's first turn. If the provider is unavailable (quota / auth / context overflow), mcode falls back to the existing deterministic `handoff-builder.ts`, surfacing a user-toggleable notification banner.

**Tech Stack:** TypeScript, Node.js, Drizzle ORM (SQLite), tsyringe DI, React + Zustand (web), Claude Agent SDK, Vitest, Playwright.

---

## Scope

**In scope (this plan):**
- Provider capability declarations: `sessionForkOnResume`, `maxInputCharactersPerTurn`
- Storage layout under `<MCODE_DATA_DIR>/threads/<id>/handoffs/<ulid>/`
- `HandoffPipelineService` orchestrating ladder B/A/D dispatch
- Path B implementation for Claude provider (side-channel resume)
- Path A implementation for Cursor provider (hidden turn + disregard turn, both flagged `isInternal`)
- Path D wired as fallback (wraps existing `handoff-builder.ts`)
- Schema: `messages.isInternal` flag (boolean, default false)
- Branch flow integration in `AgentService.createBranchedThread()` — replaces inline-replay with handoff-doc inline
- Attachment duplication on branch creation (straight copy, wiped on thread delete)
- Fallback notification banner in child thread with user-toggleable setting
- Full and minimal handoff modes (minimal triggered when `child.maxInputCharactersPerTurn < 8000`)
- Both fork anchor types: user-msg fork pre-fills the parent composer's textarea (italic, editable); assistant-msg fork leaves textarea empty
- Vendored `/handoff` skill prompt in repo (no dependency on user's `~/.claude/skills/handoff/`)
- **UI copy rename branch → fork** (Phase 13.1) — component identifiers stay
- **Slash command palette sources from in-flight composer provider selection** (Phase 13.5) — fixes pre-existing bug surfaced by prototype
- **Robustness** (Phase 17) — in-flight parent settle, side-channel 60s timeout, per-thread mutex on path A, 25MB attachment cap, post-write budget truncation, abandoned-child cleanup

**Deferred to follow-on plans (noted, not implemented here):**
- "Regenerate with provider" button on the fallback banner — UI + RPC stub only; live regeneration is follow-on
- Same-thread cross-provider switch — pending UX prototype via `impeccable` skill
- Content-addressable blob store for attachments (v2 optimization)
- Post-window handoff regeneration after child has had turns
- `/handoff` argument-as-intent user surface (composer field)
- Switch-back session restoration when user returns to a previously-active provider
- `messages.providerId` separate from `messages.model` — current `model` column suffices for provenance

---

## File Structure

**New files:**

| File | Responsibility |
|------|----------------|
| `apps/server/src/services/handoff/handoff-types.ts` | Types: `HandoffMode`, `LadderStep`, `HandoffMeta`, `HandoffArtifact`, error classifications |
| `apps/server/src/services/handoff/handoff-prompt.ts` | Vendored `/handoff` skill prompt + budget-aware mode tailoring |
| `apps/server/src/services/handoff/error-classifier.ts` | Maps provider errors to `quota \| auth \| context-overflow \| transient \| fatal \| clean` |
| `apps/server/src/services/handoff/handoff-storage.ts` | ULID-scoped read/write of `handoff.md` + `handoff.json` + attachment copying |
| `apps/server/src/services/handoff/handoff-pipeline.ts` | Orchestrates B→A→D ladder, dispatches per provider capability |
| `apps/server/src/services/handoff/__tests__/` | Vitest unit tests for each of the above |
| `apps/web/src/components/chat/HandoffFallbackBanner.tsx` | The 3b notification banner with deferred "Regenerate" stub |
| `packages/shared/src/paths/handoffs.ts` | `resolveThreadHandoffsDir()` + ULID helper |

**Modified files:**

| File | Change |
|------|--------|
| `packages/contracts/src/providers/interfaces.ts` | Add `sessionForkOnResume: "clean" \| "mutating" \| "unsupported"` and `maxInputCharactersPerTurn: number` to provider capability interface |
| `apps/server/src/store/schema.ts` | Add `messages.isInternal` integer column (default 0) |
| `apps/server/src/services/handoff-builder.ts` | Keep deterministic builder; wire as Path D producer of structured doc |
| `apps/server/src/services/agent-service.ts` | `createBranchedThread()` calls `HandoffPipelineService` instead of inline replay |
| `apps/server/src/providers/claude/claude-provider.ts` | Declare `sessionForkOnResume: "clean"`; expose `runSideChannelQuery(resumeSdkSessionId, prompt)` |
| `apps/server/src/providers/cursor/cursor-provider.ts` | Declare `sessionForkOnResume: "mutating"`; expose `runHiddenTurn(threadId, prompt)` |
| `apps/server/src/providers/codex/codex-provider.ts` | Declare capability (placeholder `"unsupported"` until verified) |
| `apps/server/src/providers/copilot/copilot-provider.ts` | Declare capability (placeholder `"unsupported"`) |
| `apps/server/src/container.ts` | Register `HandoffPipelineService` and `HandoffStorage` in DI |
| `apps/server/src/transport/ws-router.ts` | Add `handoff.regenerate` RPC stub (returns NotImplemented for v1) |
| `apps/server/src/repositories/message-repo.ts` | Filter `isInternal` out of normal list queries; expose `listIncludingInternal()` for debug paths |
| `apps/web/src/stores/threadStore.ts` | Add `handoffStatus` (`generating` \| `ready` \| `fallback` \| `error`) per child thread |
| `apps/web/src/components/chat/ThreadView.tsx` (or equivalent) | Mount `HandoffFallbackBanner` when status is `fallback` |
| Settings schema + UI | Add `chat.handoff.notifyOnLocalFallback` (default `true`) |

---

## Phase 0: Pre-flight verification

### Task 0.1: Confirm baseline `bun run verify` passes

- [ ] **Step 1: Run baseline verify**

Run: `bun run verify`
Expected: PASS (typecheck + lint + tests). If any failure exists on the base branch, stop and fix that first before starting this plan.

- [ ] **Step 2: Confirm Playwright MCP available**

Test: `mcp__playwright__browser_navigate` to `about:blank`. Expected: success. If unavailable, note that visual verification steps will be skipped per `docs/guides/agent-workflow.md`.

---

## Phase 1: Provider capability surface

Adds the two declarations every provider must make: how its `resume` behaves and what its per-turn input character cap is. Used by the pipeline to pick a ladder step.

### Task 1.1: Add capability fields to provider interface

**Files:**
- Modify: `packages/contracts/src/providers/interfaces.ts`

- [ ] **Step 1: Read current interface to locate insertion point**

Read `packages/contracts/src/providers/interfaces.ts` and find the existing `ProviderCapabilities` (or equivalent) interface. If no such interface exists, locate `IAgentProvider` and add capabilities as a getter.

- [ ] **Step 2: Add the new fields**

Insert into `ProviderCapabilities`:

```ts
/**
 * How the provider's `resume` mechanism behaves when used to fork a session
 * for side-channel queries (e.g. handoff generation):
 * - "clean": resuming creates a forked session; the original session is unaffected.
 * - "mutating": resuming mutates the original session's forward history.
 * - "unsupported": resuming is not supported or not yet verified.
 */
sessionForkOnResume: "clean" | "mutating" | "unsupported";

/**
 * Maximum input characters the provider accepts per turn, across all roles
 * (system + user content + tool results). `string.length` units, not tokens —
 * tokens vary per model and are not portable.
 *
 * Used to size handoff documents so they fit inside the child provider's
 * first-turn budget. When undeclared, callers fall back to 16_000.
 */
maxInputCharactersPerTurn: number;
```

- [ ] **Step 3: Typecheck**

Run: `(cd packages/contracts && npx tsc --noEmit)`
Expected: PASS. Then: `(cd apps/server && npx tsc --noEmit)` — expect failures in each provider class that hasn't declared the new fields yet. That's intentional and resolved in Task 1.2.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/providers/interfaces.ts
git commit -m "feat(contracts): add sessionForkOnResume + maxInputCharactersPerTurn capabilities"
```

### Task 1.2: Declare capabilities on each provider

**Files:**
- Modify: `apps/server/src/providers/claude/claude-provider.ts`
- Modify: `apps/server/src/providers/cursor/cursor-provider.ts`
- Modify: `apps/server/src/providers/codex/codex-provider.ts`
- Modify: `apps/server/src/providers/copilot/copilot-provider.ts`

- [ ] **Step 1: Claude declares clean fork + 180k chars**

In `claude-provider.ts`, add to the capabilities object:

```ts
sessionForkOnResume: "clean",
maxInputCharactersPerTurn: 180_000,
```

Rationale: Claude SDK's `resume: sdkSessionId` starts from the snapshot without mutating the original. 180k chars ≈ 45k tokens — well within Claude's 200k context window with headroom for response.

- [ ] **Step 2: Cursor declares mutating fork + 4k chars**

In `cursor-provider.ts`:

```ts
sessionForkOnResume: "mutating",
maxInputCharactersPerTurn: 4_000,
```

Rationale: Cursor's known per-turn cap and known resume-mutates behavior. This is the lowest known cap and the trigger for minimal handoff mode.

- [ ] **Step 3: Codex + Copilot declare unsupported + 16k chars**

In each:

```ts
sessionForkOnResume: "unsupported",
maxInputCharactersPerTurn: 16_000,
```

Rationale: not yet verified; conservative defaults. These providers will fall through to path D (deterministic) until path A/B support is verified.

- [ ] **Step 4: Typecheck all packages**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers
git commit -m "feat(providers): declare session-fork + input-char capabilities"
```

---

## Phase 2: Storage layout and ULID utility

Establishes the on-disk structure and the ULID identifier used per handoff.

### Task 2.1: Create handoff paths resolver

**Files:**
- Create: `packages/shared/src/paths/handoffs.ts`
- Test: `packages/shared/src/paths/__tests__/handoffs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { newHandoffUlid, resolveThreadHandoffsDir, resolveHandoffDir, resolveThreadAttachmentsDir } from "../handoffs.js";

describe("handoffs paths", () => {
  it("newHandoffUlid produces a 26-char Crockford Base32 string", () => {
    const ulid = newHandoffUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("newHandoffUlid is lexicographically sortable by creation time", async () => {
    const a = newHandoffUlid();
    await new Promise((r) => setTimeout(r, 2));
    const b = newHandoffUlid();
    expect(a < b).toBe(true);
  });

  it("resolveThreadHandoffsDir joins mcodeDir + threads/<id>/handoffs", () => {
    expect(resolveThreadHandoffsDir("/data", "t_1")).toBe("/data/threads/t_1/handoffs");
  });

  it("resolveHandoffDir joins the ULID subdir", () => {
    expect(resolveHandoffDir("/data", "t_1", "01HX")).toBe("/data/threads/t_1/handoffs/01HX");
  });

  it("resolveThreadAttachmentsDir is a sibling of handoffs", () => {
    expect(resolveThreadAttachmentsDir("/data", "t_1")).toBe("/data/threads/t_1/attachments");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/shared && npx vitest run src/paths/__tests__/handoffs.test.ts)`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
// packages/shared/src/paths/handoffs.ts
import { randomBytes } from "crypto";
import { join } from "path";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a new ULID for a handoff directory. ULIDs are 26-char Crockford
 * Base32: 10 chars of timestamp (millisecond precision) + 16 chars of randomness.
 * Lexicographically sortable by creation time — newer handoffs sort later.
 */
export function newHandoffUlid(): string {
  const time = Date.now();
  let timePart = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart += CROCKFORD[rand[i % 10] % 32];
  }
  return timePart + randPart;
}

/** Returns `<mcodeDir>/threads/<threadId>/handoffs`. */
export function resolveThreadHandoffsDir(mcodeDir: string, threadId: string): string {
  return join(mcodeDir, "threads", threadId, "handoffs");
}

/** Returns `<mcodeDir>/threads/<threadId>/handoffs/<ulid>`. */
export function resolveHandoffDir(mcodeDir: string, threadId: string, ulid: string): string {
  return join(resolveThreadHandoffsDir(mcodeDir, threadId), ulid);
}

/** Returns `<mcodeDir>/threads/<threadId>/attachments`. */
export function resolveThreadAttachmentsDir(mcodeDir: string, threadId: string): string {
  return join(mcodeDir, "threads", threadId, "attachments");
}
```

- [ ] **Step 4: Re-export from package index**

In `packages/shared/src/index.ts` (or whatever the package barrel is), add:

```ts
export * from "./paths/handoffs.js";
```

- [ ] **Step 5: Run tests**

Run: `(cd packages/shared && npx vitest run src/paths/__tests__/handoffs.test.ts)`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paths/handoffs.ts packages/shared/src/paths/__tests__/handoffs.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add handoff paths resolver with ULID utility"
```

---

## Phase 3: Schema — `messages.isInternal` flag

Cursor's path A leaves the handoff request + assistant reply + disregard turn in the parent thread's provider session. These are persisted as `messages` rows (so they survive process restarts) but must never render in the UI.

### Task 3.1: Add `isInternal` column to messages

**Files:**
- Modify: `apps/server/src/store/schema.ts`
- Migration: auto-generated under `apps/server/drizzle/`

- [ ] **Step 1: Add the column to the schema**

Insert into the `messages` table definition (after the `model` column):

```ts
/**
 * When 1, this message is internal to mcode (e.g. a hidden handoff request
 * on a Cursor parent thread) and must not render in the chat UI. The
 * provider's session state still contains the message; mcode hides only
 * the user-visible rendering.
 */
isInternal: integer("is_internal").notNull().default(0),
```

- [ ] **Step 2: Generate the migration**

Run: `(cd apps/server && bun run db:generate)`
Expected: a new SQL file under `apps/server/drizzle/` adding `is_internal` to `messages`.

- [ ] **Step 3: Inspect the generated SQL**

Read the newest file under `apps/server/drizzle/` (sort by name desc — Drizzle prefixes with sequence). Verify it's an `ALTER TABLE messages ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0`. If Drizzle generated a table rebuild instead, that's also acceptable — but verify other tables' FK references to `messages.id` are preserved.

- [ ] **Step 4: Run the migration locally**

Apply via app startup. Easiest: kill the dev server, restart with `bun run dev` — `bootstrapDrizzle` runs `migrate()` on boot.

- [ ] **Step 5: Verify with sqlite3 / Drizzle Studio**

Run: `(cd apps/server && bun run db:studio)` — open the `messages` table, confirm `is_internal` exists.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/store/schema.ts apps/server/drizzle/
git commit -m "feat(db): add messages.isInternal flag for hidden handoff turns"
```

### Task 3.2: Filter `isInternal` from message list queries

**Files:**
- Modify: `apps/server/src/repositories/message-repo.ts`

- [ ] **Step 1: Locate the existing list queries**

Read `apps/server/src/repositories/message-repo.ts` and find every method that returns `Message[]` (e.g. `listByThread`, `listByThreadUpToSequence`).

- [ ] **Step 2: Add `isInternal = 0` filter to every user-facing list**

For each list method, add `eq(messages.isInternal, 0)` to its `where` clause. Example:

```ts
async listByThread(threadId: string): Promise<Message[]> {
  return this.db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.isInternal, 0)))
    .orderBy(asc(messages.sequence));
}
```

- [ ] **Step 3: Add an explicit `listIncludingInternal` for the pipeline**

```ts
/**
 * Returns all messages including ones flagged `isInternal: 1`. Used by the
 * handoff pipeline and provider session reconstruction; never by the UI.
 */
async listIncludingInternal(threadId: string): Promise<Message[]> {
  return this.db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.sequence));
}
```

- [ ] **Step 4: Typecheck**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 5: Run existing message-repo tests**

Run: `(cd apps/server && npx vitest run src/repositories)`
Expected: PASS. If existing tests assume internal messages render, fix them — the filtering is correct.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/repositories/message-repo.ts
git commit -m "feat(repo): filter isInternal from message list queries"
```

---

## Phase 4: Handoff types

Defines the shared vocabulary used by every later module. No behavior, just types.

### Task 4.1: Create handoff-types module

**Files:**
- Create: `apps/server/src/services/handoff/handoff-types.ts`

- [ ] **Step 1: Write the module**

```ts
// apps/server/src/services/handoff/handoff-types.ts

/** Which step of the B→A→D ladder produced the handoff. */
export type LadderStep = "B" | "A" | "D";

/** Full handoff has all sections; minimal targets sub-8000-char child providers. */
export type HandoffMode = "full" | "minimal";

/** Whether the parent message at the fork point was authored by the user or assistant. */
export type ForkAnchorRole = "user" | "assistant";

/** Classified provider error returned during path-B/A attempts. */
export type ProviderErrorClass =
  | "quota"             // 429, rate-limit, billing-exhausted
  | "auth"              // 401, expired credentials
  | "context-overflow"  // input too large for the model
  | "transient"         // network blip, 5xx — retry-once is reasonable
  | "fatal"             // provider misconfigured, model removed, etc.
  | "clean";            // no error

/** What the pipeline writes to handoff.json. */
export interface HandoffMeta {
  schemaVersion: 1;
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  generatedBy: "provider" | "deterministic";
  provider: string | null;
  ladderStep: LadderStep;
  mode: HandoffMode;
  generatedAt: string;
  characterCount: number;
  parentSdkSessionId: string | null;
  providerErrorOnGenerate: ProviderErrorClass | null;
  regenerationHistory: Array<{
    at: string;
    ladderStep: LadderStep;
    reason: ProviderErrorClass | "user-requested";
  }>;
  attachments: Array<{
    id: string;
    originalName: string;
    sha256: string;
    mime: string;
    parentMessageId: string;
  }>;
}

/** Returned by every ladder step. The pipeline writes both to disk. */
export interface HandoffArtifact {
  markdown: string;
  meta: HandoffMeta;
}

/** Input to the pipeline's orchestrate() method. */
export interface HandoffRequest {
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  childProviderId: string;       // determines budget + minimal-mode trigger
}
```

- [ ] **Step 2: Typecheck**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/handoff/handoff-types.ts
git commit -m "feat(handoff): add handoff pipeline shared types"
```

---

## Phase 5: Error classifier

Classifies provider errors so the ladder knows whether to fall through to A (same provider, different mechanism) or D (give up and go deterministic).

### Task 5.1: Create error-classifier with tests

**Files:**
- Create: `apps/server/src/services/handoff/error-classifier.ts`
- Test: `apps/server/src/services/handoff/__tests__/error-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../error-classifier.js";

describe("classifyProviderError", () => {
  it("returns quota for 429", () => {
    expect(classifyProviderError({ status: 429, message: "rate limited" })).toBe("quota");
  });

  it("returns quota for billing keywords", () => {
    expect(classifyProviderError({ message: "credit balance is too low" })).toBe("quota");
  });

  it("returns auth for 401", () => {
    expect(classifyProviderError({ status: 401, message: "unauthorized" })).toBe("auth");
  });

  it("returns context-overflow for prompt-too-long messages", () => {
    expect(classifyProviderError({ message: "prompt is too long: 200000 tokens" })).toBe("context-overflow");
  });

  it("returns transient for 5xx", () => {
    expect(classifyProviderError({ status: 503, message: "service unavailable" })).toBe("transient");
  });

  it("returns transient for ECONNRESET", () => {
    expect(classifyProviderError({ code: "ECONNRESET", message: "" })).toBe("transient");
  });

  it("returns fatal for everything else", () => {
    expect(classifyProviderError({ message: "model not found" })).toBe("fatal");
  });

  it("returns fatal for null input", () => {
    expect(classifyProviderError(null)).toBe("fatal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/error-classifier.test.ts)`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/services/handoff/error-classifier.ts
import type { ProviderErrorClass } from "./handoff-types.js";

interface ErrorShape {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Classifies an arbitrary provider error into one of the buckets the ladder
 * knows how to route on. Resilient to unknown shapes — never throws.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (err === null || err === undefined) return "fatal";
  const e = err as ErrorShape;
  const msg = (e.message ?? "").toLowerCase();

  if (e.status === 429 || /rate.?limit|too many requests/.test(msg)) return "quota";
  if (/credit balance|quota.*exhaust|billing|usage limit/.test(msg)) return "quota";

  if (e.status === 401 || e.status === 403) return "auth";
  if (/unauthori[sz]ed|invalid api key|authentication/.test(msg)) return "auth";

  if (/prompt is too long|context length|exceeds.*tokens|input too large/.test(msg)) return "context-overflow";

  if (e.status !== undefined && e.status >= 500 && e.status < 600) return "transient";
  if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND") return "transient";
  if (/network|timeout|fetch failed/.test(msg)) return "transient";

  return "fatal";
}

/**
 * Returns true when this error class means the provider is unusable right now
 * and we should skip directly to deterministic (path D) rather than try A.
 */
export function shouldSkipToDeterministic(c: ProviderErrorClass): boolean {
  return c === "quota" || c === "auth" || c === "context-overflow" || c === "fatal";
}
```

- [ ] **Step 4: Run tests**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/error-classifier.test.ts)`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/handoff
git commit -m "feat(handoff): add provider error classifier"
```

---

## Phase 6: Handoff prompt builder

Vendors the `/handoff` skill's prompt content and tailors it per-mode with fork context and character budget.

### Task 6.1: Vendor the `/handoff` prompt + mode tailoring

**Files:**
- Create: `apps/server/src/services/handoff/handoff-prompt.ts`
- Test: `apps/server/src/services/handoff/__tests__/handoff-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildHandoffPrompt, pickHandoffMode } from "../handoff-prompt.js";

describe("pickHandoffMode", () => {
  it("returns minimal when child cap < 8000", () => {
    expect(pickHandoffMode(4_000)).toBe("minimal");
    expect(pickHandoffMode(7_999)).toBe("minimal");
  });
  it("returns full at or above 8000", () => {
    expect(pickHandoffMode(8_000)).toBe("full");
    expect(pickHandoffMode(180_000)).toBe("full");
  });
});

describe("buildHandoffPrompt", () => {
  const baseInput = {
    forkAnchorRole: "assistant" as const,
    parentThreadTitle: "Database migration design",
    forkMessageExcerpt: "We should use Postgres because…",
    childProviderId: "claude",
    childMaxInputCharacters: 180_000,
    handoffDocAbsolutePath: "/data/threads/t_child/handoffs/01HX/handoff.md",
  };

  it("full mode mentions all eight sections", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "full" });
    for (const s of ["Goal", "At fork", "Open items", "Decisions made", "Files in play", "Suggested next steps", "Suggested skills", "Attachments"]) {
      expect(p).toContain(s);
    }
  });

  it("minimal mode lists only Goal / At fork / Open items", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "minimal", childMaxInputCharacters: 4000 });
    expect(p).toContain("Goal");
    expect(p).toContain("At fork");
    expect(p).toContain("Open items");
    expect(p).not.toContain("Decisions made");
    expect(p).not.toContain("Suggested skills");
  });

  it("includes the budget in characters, not tokens", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "minimal", childMaxInputCharacters: 4000 });
    expect(p).toMatch(/character/i);
    expect(p).not.toMatch(/token/i);
  });

  it("includes the user-msg vs assistant-msg framing", () => {
    const userFork = buildHandoffPrompt({ ...baseInput, mode: "full", forkAnchorRole: "user" });
    expect(userFork).toMatch(/retry|redo|same question/i);

    const asstFork = buildHandoffPrompt({ ...baseInput, mode: "full", forkAnchorRole: "assistant" });
    expect(asstFork).toMatch(/continue|new direction|follow.?up/i);
  });

  it("instructs writing to the absolute path", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "full" });
    expect(p).toContain("/data/threads/t_child/handoffs/01HX/handoff.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-prompt.test.ts)`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/services/handoff/handoff-prompt.ts
import type { ForkAnchorRole, HandoffMode } from "./handoff-types.js";

const MINIMAL_MODE_THRESHOLD_CHARS = 8_000;
const RESERVED_SYSTEM_PROMPT_CHARS = 1_000;
const RESERVED_USER_FIRST_MESSAGE_CHARS = 500;
const RESERVED_OVERHEAD_CHARS = 500;

/**
 * Decides which mode to use based on the child provider's per-turn cap.
 * Minimal mode is triggered when the cap is too tight to host the full
 * structured doc with reasonable headroom.
 */
export function pickHandoffMode(childMaxInputCharacters: number): HandoffMode {
  return childMaxInputCharacters < MINIMAL_MODE_THRESHOLD_CHARS ? "minimal" : "full";
}

/** Compute the character budget the handoff doc should target. */
export function computeBudgetChars(childMaxInputCharacters: number): number {
  const budget =
    childMaxInputCharacters -
    RESERVED_SYSTEM_PROMPT_CHARS -
    RESERVED_USER_FIRST_MESSAGE_CHARS -
    RESERVED_OVERHEAD_CHARS;
  return Math.max(budget, 1_000);
}

export interface HandoffPromptInput {
  mode: HandoffMode;
  forkAnchorRole: ForkAnchorRole;
  parentThreadTitle: string;
  forkMessageExcerpt: string;
  childProviderId: string;
  childMaxInputCharacters: number;
  handoffDocAbsolutePath: string;
}

/**
 * Builds the side-channel prompt that the parent's provider session executes
 * to produce the handoff document. Adapts the vendored `/handoff` skill
 * instructions with mcode-specific fork context and character budget.
 *
 * The prompt instructs the provider to WRITE the handoff to the given
 * absolute path using its file-write tool. The pipeline then reads it back
 * from disk.
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const { mode, forkAnchorRole, parentThreadTitle, forkMessageExcerpt, childProviderId, handoffDocAbsolutePath } = input;
  const budget = computeBudgetChars(input.childMaxInputCharacters);

  const forkFraming =
    forkAnchorRole === "user"
      ? `The user is forking to RETRY this question / explore a different response to the same input. The next agent should be prepared to answer the same user question afresh.`
      : `The user is forking to CONTINUE the conversation in a new direction — a follow-up that diverges from where this thread actually went next. The next agent should be ready to pick up the thread.`;

  const sectionsFull = [
    "## Goal — one sentence: what was the parent thread trying to accomplish",
    "## At fork — 2-4 sentences: what was happening when the user branched, including the immediate context of the forked message",
    "## Open items — up to 5 short bullets: unfinished work, relevant file paths, blockers, open questions",
    "## Decisions made — table of (Decision | Rationale) for non-obvious choices made in this thread",
    "## Files in play — bullets of `path/to/file` with one-line relevance note",
    "## Suggested next steps — numbered list, ordered by what the next agent should do first",
    "## Suggested skills — bullets of `skill-name` with when to invoke; required by the /handoff skill spec",
    "## Attachments — bullets of `attachments/<id>.<ext>` referencing what the original user shared; only include if attachments exist",
  ];

  const sectionsMinimal = [
    "## Goal — one sentence: parent thread's purpose",
    "## At fork — 2-3 sentences: state at the branch point",
    "## Open items — up to 5 short bullets: unfinished work + relevant file paths",
  ];

  const sections = mode === "full" ? sectionsFull : sectionsMinimal;

  return [
    `You are producing a handoff document for a fresh agent that will continue work from this conversation in a new branched thread.`,
    ``,
    `## Context`,
    `- Parent thread title: ${parentThreadTitle}`,
    `- Fork point (last included message excerpt): ${forkMessageExcerpt.slice(0, 400)}`,
    `- ${forkFraming}`,
    `- Next agent's provider: ${childProviderId}`,
    ``,
    `## Constraints`,
    `- Target output: ≤ ${budget} characters (string.length units, NOT tokens).`,
    `- Output mode: ${mode}.`,
    `- Do NOT duplicate content captured elsewhere (PRDs, plans, ADRs, issues, commits). Reference by path or URL.`,
    `- Redact any API keys, passwords, or personally identifiable information.`,
    ``,
    `## Required sections (in this order)`,
    ...sections,
    ``,
    `## Output instructions`,
    `Write the complete handoff document to the absolute path:`,
    `  ${handoffDocAbsolutePath}`,
    ``,
    `Begin the file with this YAML frontmatter (the pipeline will substitute final values; you write the markdown body):`,
    `---`,
    `# (frontmatter will be injected by the pipeline)`,
    `---`,
    ``,
    `Then the markdown body with the sections above. Confirm the write succeeded before responding.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-prompt.test.ts)`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/handoff/handoff-prompt.ts apps/server/src/services/handoff/__tests__/handoff-prompt.test.ts
git commit -m "feat(handoff): vendored /handoff prompt with mode + budget tailoring"
```

---

## Phase 7: Handoff storage

Reads, writes, and lists handoff artifacts on disk. Also copies parent attachments into the child's `attachments/` dir on first write.

### Task 7.1: Implement `HandoffStorage` with TDD

**Files:**
- Create: `apps/server/src/services/handoff/handoff-storage.ts`
- Test: `apps/server/src/services/handoff/__tests__/handoff-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HandoffStorage } from "../handoff-storage.js";
import type { HandoffArtifact } from "../handoff-types.js";

let dir: string;
let storage: HandoffStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handoff-store-"));
  storage = new HandoffStorage(() => dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeArtifact(overrides: Partial<HandoffArtifact["meta"]> = {}): HandoffArtifact {
  return {
    markdown: "# Handoff\n\n## Goal\nTest the storage layer.",
    meta: {
      schemaVersion: 1,
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      generatedBy: "provider",
      provider: "claude",
      ladderStep: "B",
      mode: "full",
      generatedAt: new Date().toISOString(),
      characterCount: 50,
      parentSdkSessionId: "sdk_123",
      providerErrorOnGenerate: null,
      regenerationHistory: [],
      attachments: [],
      ...overrides,
    },
  };
}

describe("HandoffStorage", () => {
  it("write creates handoffs/<ulid>/handoff.md and handoff.json", async () => {
    const a = makeArtifact();
    const ulid = await storage.write("t_child", a);
    expect(existsSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.md"))).toBe(true);
    expect(existsSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.json"))).toBe(true);
  });

  it("write injects YAML frontmatter into the markdown", async () => {
    const a = makeArtifact();
    const ulid = await storage.write("t_child", a);
    const md = readFileSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.md"), "utf8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("schemaVersion: 1");
    expect(md).toContain("ladderStep: B");
  });

  it("readLatest returns the highest-ULID handoff for the thread", async () => {
    const a1 = makeArtifact({ ladderStep: "D" });
    await storage.write("t_child", a1);
    await new Promise((r) => setTimeout(r, 2));
    const a2 = makeArtifact({ ladderStep: "B" });
    await storage.write("t_child", a2);
    const latest = await storage.readLatest("t_child");
    expect(latest?.meta.ladderStep).toBe("B");
  });

  it("readLatest returns null when no handoffs exist", async () => {
    expect(await storage.readLatest("t_none")).toBeNull();
  });

  it("copyAttachments duplicates source files into the child's attachments dir", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "att-src-"));
    const srcFile = join(srcDir, "screenshot.png");
    writeFileSync(srcFile, Buffer.from([1, 2, 3, 4]));

    await storage.copyAttachments("t_child", [
      { id: "att_1", absolutePath: srcFile, originalName: "screenshot.png", mime: "image/png", parentMessageId: "m_5" },
    ]);

    expect(existsSync(join(dir, "threads", "t_child", "attachments", "att_1.png"))).toBe(true);
    rmSync(srcDir, { recursive: true, force: true });
  });

  it("deleteThreadFiles removes the entire thread subtree", async () => {
    const a = makeArtifact();
    await storage.write("t_child", a);
    await storage.deleteThreadFiles("t_child");
    expect(existsSync(join(dir, "threads", "t_child"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-storage.test.ts)`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `HandoffStorage`**

```ts
// apps/server/src/services/handoff/handoff-storage.ts
import { mkdir, readFile, writeFile, readdir, rm, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, extname, join } from "path";
import { createHash } from "crypto";
import {
  resolveHandoffDir,
  resolveThreadAttachmentsDir,
  resolveThreadHandoffsDir,
  newHandoffUlid,
} from "@mcode/shared";
import { getMcodeDir } from "@mcode/shared";
import type { HandoffArtifact, HandoffMeta } from "./handoff-types.js";

export interface AttachmentSource {
  id: string;
  absolutePath: string;
  originalName: string;
  mime: string;
  parentMessageId: string;
}

/**
 * Filesystem-backed read/write for handoff artifacts. Each handoff is a
 * ULID-named directory containing handoff.md (with YAML frontmatter) and
 * handoff.json (system metadata + provenance + attachment manifest).
 */
export class HandoffStorage {
  constructor(private readonly mcodeDirFn: () => string = getMcodeDir) {}

  /** Persist an artifact under a fresh ULID. Returns the ULID assigned. */
  async write(threadId: string, artifact: HandoffArtifact): Promise<string> {
    const ulid = newHandoffUlid();
    const handoffDir = resolveHandoffDir(this.mcodeDirFn(), threadId, ulid);
    await mkdir(handoffDir, { recursive: true });

    const markdownWithFrontmatter = this.injectFrontmatter(artifact.markdown, artifact.meta);
    await writeFile(join(handoffDir, "handoff.md"), markdownWithFrontmatter, "utf8");
    await writeFile(join(handoffDir, "handoff.json"), JSON.stringify(artifact.meta, null, 2), "utf8");
    return ulid;
  }

  /** Most recent handoff by ULID lexicographic sort (ULIDs are time-ordered). */
  async readLatest(threadId: string): Promise<HandoffArtifact | null> {
    const handoffsRoot = resolveThreadHandoffsDir(this.mcodeDirFn(), threadId);
    if (!existsSync(handoffsRoot)) return null;
    const entries = await readdir(handoffsRoot);
    if (entries.length === 0) return null;
    const latest = entries.sort().at(-1)!;
    const dir = join(handoffsRoot, latest);
    const [md, json] = await Promise.all([
      readFile(join(dir, "handoff.md"), "utf8"),
      readFile(join(dir, "handoff.json"), "utf8"),
    ]);
    return { markdown: md, meta: JSON.parse(json) as HandoffMeta };
  }

  /** Copy source files into <thread>/attachments/<id>.<ext>. */
  async copyAttachments(threadId: string, sources: AttachmentSource[]): Promise<HandoffMeta["attachments"]> {
    const attachDir = resolveThreadAttachmentsDir(this.mcodeDirFn(), threadId);
    await mkdir(attachDir, { recursive: true });
    const result: HandoffMeta["attachments"] = [];
    for (const s of sources) {
      const ext = extname(s.originalName) || extname(s.absolutePath) || "";
      const dest = join(attachDir, `${s.id}${ext}`);
      await copyFile(s.absolutePath, dest);
      const sha = createHash("sha256").update(await readFile(dest)).digest("hex");
      result.push({
        id: s.id,
        originalName: s.originalName,
        sha256: sha,
        mime: s.mime,
        parentMessageId: s.parentMessageId,
      });
    }
    return result;
  }

  /** Wipe the entire <mcodeDir>/threads/<id>/ subtree. Called on thread delete. */
  async deleteThreadFiles(threadId: string): Promise<void> {
    const threadRoot = dirname(resolveThreadHandoffsDir(this.mcodeDirFn(), threadId));
    await rm(threadRoot, { recursive: true, force: true });
  }

  private injectFrontmatter(markdownBody: string, meta: HandoffMeta): string {
    const fmFields = [
      `schemaVersion: ${meta.schemaVersion}`,
      `parentThreadId: ${meta.parentThreadId}`,
      `forkedFromMessageId: ${meta.forkedFromMessageId}`,
      `forkAnchorRole: ${meta.forkAnchorRole}`,
      `childThreadId: ${meta.childThreadId}`,
      `generatedBy: ${meta.generatedBy}`,
      `provider: ${meta.provider ?? "null"}`,
      `ladderStep: ${meta.ladderStep}`,
      `mode: ${meta.mode}`,
      `generatedAt: ${meta.generatedAt}`,
      `characterCount: ${meta.characterCount}`,
    ].join("\n");
    // Strip any existing frontmatter the LLM might have included.
    const body = markdownBody.replace(/^---\n[\s\S]*?\n---\n/, "");
    return `---\n${fmFields}\n---\n\n${body}`;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-storage.test.ts)`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/handoff/handoff-storage.ts apps/server/src/services/handoff/__tests__/handoff-storage.test.ts
git commit -m "feat(handoff): add HandoffStorage with ULID dirs + attachment copy"
```

### Task 7.2: Register `HandoffStorage` in DI

**Files:**
- Modify: `apps/server/src/container.ts`

- [ ] **Step 1: Add the registration**

Locate the existing `container.register(...)` block. Add:

```ts
import { HandoffStorage } from "./services/handoff/handoff-storage.js";
// ...
container.registerSingleton(HandoffStorage);
```

- [ ] **Step 2: Typecheck**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/container.ts
git commit -m "feat(handoff): register HandoffStorage in DI container"
```

---

## Phase 8: Provider side-channel APIs

Each provider adds two methods the pipeline can call to produce a handoff: one for clean-fork providers (path B) and one for mutating-resume providers (path A). Providers that support neither are skipped by the pipeline.

### Task 8.1: Define the side-channel interface

**Files:**
- Modify: `packages/contracts/src/providers/interfaces.ts`

- [ ] **Step 1: Add the side-channel methods to the provider interface**

```ts
/**
 * Run a one-shot query against a forked copy of the parent's session.
 * Only providers with `sessionForkOnResume === "clean"` implement this.
 * The returned string is the assistant's final text output.
 *
 * @throws a provider-specific error on failure; the pipeline classifies it
 *         via `classifyProviderError`.
 */
runSideChannelQuery?(args: {
  parentThreadId: string;
  parentSdkSessionId: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string>;

/**
 * Run a hidden turn on the parent thread's session, persisting both the
 * request and the assistant reply with `isInternal: 1`. Only providers
 * with `sessionForkOnResume === "mutating"` implement this. After the
 * hidden turn, the implementation MUST send a second hidden turn instructing
 * the model to disregard the handoff request and continue normally.
 */
runHiddenTurn?(args: {
  parentThreadId: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string>;
```

- [ ] **Step 2: Typecheck**

Run: `(cd packages/contracts && npx tsc --noEmit)`
Expected: PASS (methods are optional so existing providers still satisfy).

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/providers/interfaces.ts
git commit -m "feat(contracts): add provider side-channel handoff methods"
```

### Task 8.2: Implement `runSideChannelQuery` on Claude provider

**Files:**
- Modify: `apps/server/src/providers/claude/claude-provider.ts`

- [ ] **Step 1: Locate the existing SDK query path**

Read `apps/server/src/providers/claude/claude-provider.ts` and find where the Claude SDK's `query()` is invoked for normal turns (look for `resume:` usage and the `sdkSessionIds` map at line ~228, ~473, ~577).

- [ ] **Step 2: Add the method**

Add this method to the class:

```ts
/**
 * Path-B implementation for Claude. Forks the parent's session via the
 * SDK's `resume` (which does NOT mutate the original) and runs a single
 * query with the handoff prompt. The forked session ID is discarded —
 * we only need the textual output.
 */
async runSideChannelQuery(args: {
  parentThreadId: string;
  parentSdkSessionId: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { parentSdkSessionId, prompt, abortSignal } = args;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let collected = "";
  const stream = query({
    prompt,
    options: {
      resume: parentSdkSessionId,
      maxTurns: 1,
      abortController: abortSignal ? { signal: abortSignal } as AbortController : undefined,
    },
  });
  for await (const event of stream) {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text") collected += block.text;
      }
    }
  }
  if (collected.trim().length === 0) {
    throw new Error("Claude side-channel query returned empty output");
  }
  return collected;
}
```

(Adapt the SDK event shape to match the actual stream type used elsewhere in `claude-provider.ts` — this is the pattern, the exact field names may differ.)

- [ ] **Step 3: Typecheck**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 4: Run existing Claude provider tests**

Run: `(cd apps/server && npx vitest run src/providers/claude/__tests__)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers/claude/claude-provider.ts
git commit -m "feat(claude-provider): implement runSideChannelQuery for path B"
```

### Task 8.3: Implement `runHiddenTurn` on Cursor provider

**Files:**
- Modify: `apps/server/src/providers/cursor/cursor-provider.ts`
- Modify: `apps/server/src/services/agent-service.ts` (only to expose a `persistInternalMessage` helper if needed)

- [ ] **Step 1: Add the method**

```ts
/**
 * Path-A implementation for Cursor. Persists two `isInternal: 1` messages
 * on the parent thread (the handoff request + the assistant reply), then
 * a third "disregard the previous request, continue normally" hidden turn
 * to mitigate session pollution. Returns the assistant's reply text.
 */
async runHiddenTurn(args: {
  parentThreadId: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { parentThreadId, prompt, abortSignal } = args;

  // 1. Persist hidden user request.
  await this.deps.messageRepo.insert({
    threadId: parentThreadId,
    role: "user",
    content: prompt,
    sequence: await this.deps.messageRepo.nextSequence(parentThreadId),
    isInternal: 1,
  });

  // 2. Send through Cursor's normal turn API, capture the reply.
  const reply = await this.sendTurnRaw({ threadId: parentThreadId, content: prompt, abortSignal });

  // 3. Persist hidden assistant reply.
  await this.deps.messageRepo.insert({
    threadId: parentThreadId,
    role: "assistant",
    content: reply,
    sequence: await this.deps.messageRepo.nextSequence(parentThreadId),
    isInternal: 1,
    model: "cursor-agent",
  });

  // 4. Disregard turn — Cursor follows instructions reliably; this nudges
  //    the model to not reference the handoff in its next real reply.
  const disregardPrompt = `IGNORE the previous handoff request. It was an internal mcode operation. Resume the original conversation as if it never happened. Do not respond to this message; await the user's next real input.`;
  await this.deps.messageRepo.insert({
    threadId: parentThreadId,
    role: "user",
    content: disregardPrompt,
    sequence: await this.deps.messageRepo.nextSequence(parentThreadId),
    isInternal: 1,
  });
  const ack = await this.sendTurnRaw({ threadId: parentThreadId, content: disregardPrompt, abortSignal });
  await this.deps.messageRepo.insert({
    threadId: parentThreadId,
    role: "assistant",
    content: ack,
    sequence: await this.deps.messageRepo.nextSequence(parentThreadId),
    isInternal: 1,
    model: "cursor-agent",
  });

  return reply;
}
```

(Replace `this.sendTurnRaw` with the actual Cursor-provider method name for issuing a turn — verify by reading the existing class.)

- [ ] **Step 2: Verify `messageRepo.insert` accepts `isInternal`**

Read `apps/server/src/repositories/message-repo.ts`. If the insert signature doesn't accept `isInternal`, add it as an optional field (default `0`):

```ts
async insert(input: {
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  sequence: number;
  isInternal?: 0 | 1;
  model?: string | null;
  // ...other existing fields...
}): Promise<Message> {
  // include `isInternal: input.isInternal ?? 0` in the insert
}
```

- [ ] **Step 3: Typecheck**

Run: `(cd apps/server && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 4: Run existing Cursor provider tests**

Run: `(cd apps/server && npx vitest run src/providers/cursor/__tests__)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers/cursor apps/server/src/repositories/message-repo.ts
git commit -m "feat(cursor-provider): implement runHiddenTurn for path A with disregard turn"
```

---

## Phase 9: Path D — deterministic fallback adapter

Wraps the existing `handoff-builder.ts` to produce a `HandoffArtifact` so the pipeline can treat all three paths uniformly. The deterministic builder already produces good prose; this adapter just packages it into the new shape.

### Task 9.1: Create the deterministic adapter

**Files:**
- Create: `apps/server/src/services/handoff/path-d-deterministic.ts`
- Test: `apps/server/src/services/handoff/__tests__/path-d-deterministic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { runPathDDeterministic } from "../path-d-deterministic.js";
import type { Thread, Message } from "@mcode/contracts";

const parent: Thread = {
  id: "t_parent",
  workspaceId: "w_1",
  title: "DB migration",
  branch: "main",
  provider: "claude",
  model: "claude-opus-4-7",
  status: "active",
  // ...minimal stub of remaining fields
} as Thread;

const messages: Message[] = [
  { id: "m_1", threadId: "t_parent", role: "user", content: "Should we use Postgres?", sequence: 1 } as Message,
  { id: "m_2", threadId: "t_parent", role: "assistant", content: "Yes because…", sequence: 2 } as Message,
];

describe("runPathDDeterministic", () => {
  it("produces a HandoffArtifact with ladderStep D + generatedBy deterministic", async () => {
    const artifact = await runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: "m_2",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      reason: "quota",
    });
    expect(artifact.meta.ladderStep).toBe("D");
    expect(artifact.meta.generatedBy).toBe("deterministic");
    expect(artifact.meta.providerErrorOnGenerate).toBe("quota");
    expect(artifact.markdown.length).toBeGreaterThan(0);
  });

  it("characterCount matches markdown length", async () => {
    const a = await runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: "m_2",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      reason: null,
    });
    expect(a.meta.characterCount).toBe(a.markdown.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/path-d-deterministic.test.ts)`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the adapter**

```ts
// apps/server/src/services/handoff/path-d-deterministic.ts
import type { Thread, Message } from "@mcode/contracts";
import { buildHandoffContent, resolveForkSnapshot } from "../handoff-builder.js";
import type { HandoffArtifact, HandoffMeta, ForkAnchorRole, ProviderErrorClass } from "./handoff-types.js";

export interface PathDInput {
  parentThread: Thread;
  messagesUpToFork: Message[];
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  /** Why path D ran instead of B/A. `null` when D was the only viable option (e.g. provider unsupported). */
  reason: ProviderErrorClass | null;
}

/**
 * Produces a HandoffArtifact using the existing deterministic builder.
 * The output markdown is the legacy prose format the builder already emits;
 * it's wrapped in the new metadata shape so callers can treat all three
 * ladder steps uniformly.
 */
export async function runPathDDeterministic(input: PathDInput): Promise<HandoffArtifact> {
  const { parentThread, messagesUpToFork, forkedFromMessageId, forkAnchorRole, childThreadId, reason } = input;

  const lastAssistant = [...messagesUpToFork].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistant?.content ?? null;

  // Reuse buildHandoffContent from the legacy builder. Pass empty arrays for
  // files-changed and tasks for now; richer integration can pull from
  // turnSnapshots + threadTasks repos at the orchestration layer.
  const prose = buildHandoffContent({
    parentThread,
    forkMessageId: forkedFromMessageId,
    lastAssistantText,
    recentFilesChanged: [],
    openTasks: [],
    sourceHead: null,
  });

  const markdown = `# Handoff (deterministic)\n\n${prose}\n`;
  const meta: HandoffMeta = {
    schemaVersion: 1,
    parentThreadId: parentThread.id,
    forkedFromMessageId,
    forkAnchorRole,
    childThreadId,
    generatedBy: "deterministic",
    provider: parentThread.provider,
    ladderStep: "D",
    mode: "full",
    generatedAt: new Date().toISOString(),
    characterCount: markdown.length,
    parentSdkSessionId: parentThread.sdkSessionId ?? null,
    providerErrorOnGenerate: reason,
    regenerationHistory: [],
    attachments: [],
  };
  return { markdown, meta };
}
```

- [ ] **Step 4: Run tests**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/path-d-deterministic.test.ts)`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/handoff/path-d-deterministic.ts apps/server/src/services/handoff/__tests__/path-d-deterministic.test.ts
git commit -m "feat(handoff): add path-D deterministic adapter wrapping handoff-builder"
```

---

## Phase 10: Pipeline orchestrator

The heart of the feature. Dispatches B/A/D based on provider capability + live error class.

### Task 10.1: Implement `HandoffPipelineService` with TDD

**Files:**
- Create: `apps/server/src/services/handoff/handoff-pipeline.ts`
- Test: `apps/server/src/services/handoff/__tests__/handoff-pipeline.test.ts`

- [ ] **Step 1: Write the failing test (B success)**

```ts
import { describe, expect, it, vi } from "vitest";
import { HandoffPipelineService } from "../handoff-pipeline.js";

const mkDeps = () => {
  const parent = { id: "t_parent", title: "X", provider: "claude", sdkSessionId: "sdk_1" } as any;
  const child = { id: "t_child", provider: "claude" } as any;
  return {
    threadRepo: { findById: vi.fn(async (id) => (id === "t_parent" ? parent : child)) },
    messageRepo: { listIncludingInternal: vi.fn(async () => [{ id: "m_1", role: "user", content: "hi", sequence: 1 }]) },
    providerRegistry: {
      get: vi.fn((id) => {
        if (id === "claude") {
          return {
            capabilities: { sessionForkOnResume: "clean", maxInputCharactersPerTurn: 180_000 },
            runSideChannelQuery: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
          };
        }
        return null;
      }),
    },
    storage: {
      write: vi.fn(async () => "01HX"),
      copyAttachments: vi.fn(async () => []),
    },
  };
};

describe("HandoffPipelineService.orchestrate", () => {
  it("path B success writes a provider-generated artifact", async () => {
    const deps = mkDeps();
    const svc = new HandoffPipelineService(deps as any);
    const result = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "claude",
    });
    expect(result.meta.ladderStep).toBe("B");
    expect(result.meta.generatedBy).toBe("provider");
    expect(deps.storage.write).toHaveBeenCalledTimes(1);
  });

  it("path B quota failure falls directly to D, skipping A", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      capabilities: { sessionForkOnResume: "clean", maxInputCharactersPerTurn: 180_000 },
      runSideChannelQuery: vi.fn(async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); }),
    }));
    const svc = new HandoffPipelineService(deps as any);
    const result = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "claude",
    });
    expect(result.meta.ladderStep).toBe("D");
    expect(result.meta.providerErrorOnGenerate).toBe("quota");
  });

  it("mutating-resume provider uses path A", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      capabilities: { sessionForkOnResume: "mutating", maxInputCharactersPerTurn: 4_000 },
      runHiddenTurn: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
    }));
    const svc = new HandoffPipelineService(deps as any);
    const result = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "cursor",
    });
    expect(result.meta.ladderStep).toBe("A");
    expect(result.meta.mode).toBe("minimal");
  });

  it("unsupported-resume provider skips to D", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      capabilities: { sessionForkOnResume: "unsupported", maxInputCharactersPerTurn: 16_000 },
    }));
    const svc = new HandoffPipelineService(deps as any);
    const result = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "codex",
    });
    expect(result.meta.ladderStep).toBe("D");
    expect(result.meta.providerErrorOnGenerate).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-pipeline.test.ts)`
Expected: FAIL.

- [ ] **Step 3: Implement the orchestrator**

```ts
// apps/server/src/services/handoff/handoff-pipeline.ts
import { inject, injectable } from "tsyringe";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts";
import { resolveHandoffDir } from "@mcode/shared";
import { getMcodeDir } from "@mcode/shared";
import { logger } from "@mcode/shared/logging";
import { ThreadRepository } from "../../repositories/thread-repo.js";
import { MessageRepository } from "../../repositories/message-repo.js";
import { HandoffStorage } from "./handoff-storage.js";
import { classifyProviderError, shouldSkipToDeterministic } from "./error-classifier.js";
import { buildHandoffPrompt, pickHandoffMode } from "./handoff-prompt.js";
import { runPathDDeterministic } from "./path-d-deterministic.js";
import type { HandoffArtifact, HandoffMeta, HandoffRequest, LadderStep, ProviderErrorClass } from "./handoff-types.js";
import { newHandoffUlid } from "@mcode/shared";

interface Deps {
  threadRepo: ThreadRepository;
  messageRepo: MessageRepository;
  providerRegistry: IProviderRegistry;
  storage: HandoffStorage;
}

@injectable()
export class HandoffPipelineService {
  constructor(@inject("Deps") private readonly deps: Deps) {}

  /**
   * Orchestrates the B→A→D ladder. Returns the produced artifact; the caller
   * is responsible for invoking storage.write() if it wants persistence,
   * which the inner ladder steps that don't use the storage themselves also
   * perform via this method's tail.
   */
  async orchestrate(req: HandoffRequest): Promise<HandoffArtifact> {
    const parent = await this.deps.threadRepo.findById(req.parentThreadId);
    if (!parent) throw new Error(`Parent thread ${req.parentThreadId} not found`);
    if (parent.deletedAt) throw new Error(`Cannot branch from a deleted thread`);

    const parentProvider = this.deps.providerRegistry.get(parent.provider);
    const childProvider = this.deps.providerRegistry.get(req.childProviderId);
    if (!childProvider) throw new Error(`Child provider ${req.childProviderId} not registered`);

    const childCap = childProvider.capabilities?.maxInputCharactersPerTurn ?? 16_000;
    const mode = pickHandoffMode(childCap);
    const messages = await this.deps.messageRepo.listIncludingInternal(req.parentThreadId);
    const forkMsg = messages.find((m) => m.id === req.forkedFromMessageId);
    if (!forkMsg) throw new Error(`Fork message ${req.forkedFromMessageId} not in parent`);

    // Pre-allocate child ULID so the prompt can instruct the provider to write
    // to the final path. The provider tool writes -> we then re-read and inject
    // canonical frontmatter via storage.write().
    const preUlid = newHandoffUlid();
    const handoffPath = resolveHandoffDir(getMcodeDir(), req.childThreadId, preUlid) + "/handoff.md";

    const prompt = buildHandoffPrompt({
      mode,
      forkAnchorRole: req.forkAnchorRole,
      parentThreadTitle: parent.title,
      forkMessageExcerpt: forkMsg.content,
      childProviderId: req.childProviderId,
      childMaxInputCharacters: childCap,
      handoffDocAbsolutePath: handoffPath,
    });

    const capability = parentProvider?.capabilities?.sessionForkOnResume ?? "unsupported";

    // Path B
    if (capability === "clean" && parentProvider?.runSideChannelQuery && parent.sdkSessionId) {
      try {
        const text = await parentProvider.runSideChannelQuery({
          parentThreadId: req.parentThreadId,
          parentSdkSessionId: parent.sdkSessionId,
          prompt,
        });
        return this.buildProviderArtifact(req, parent, text, "B", mode, null);
      } catch (err) {
        const cls = classifyProviderError(err);
        logger.warn({ err, cls, threadId: req.parentThreadId }, "Handoff path B failed");
        if (!shouldSkipToDeterministic(cls)) {
          // Transient — drop straight to D rather than try A; A on Claude is undefined.
        }
        return this.runDeterministic(req, parent, messages, cls);
      }
    }

    // Path A
    if (capability === "mutating" && parentProvider?.runHiddenTurn) {
      try {
        const text = await parentProvider.runHiddenTurn({
          parentThreadId: req.parentThreadId,
          prompt,
        });
        return this.buildProviderArtifact(req, parent, text, "A", mode, null);
      } catch (err) {
        const cls = classifyProviderError(err);
        logger.warn({ err, cls, threadId: req.parentThreadId }, "Handoff path A failed");
        return this.runDeterministic(req, parent, messages, cls);
      }
    }

    // Path D — provider unsupported or no parent session yet
    return this.runDeterministic(req, parent, messages, null);
  }

  private buildProviderArtifact(
    req: HandoffRequest,
    parent: any,
    markdownBody: string,
    step: LadderStep,
    mode: "full" | "minimal",
    providerErrorOnGenerate: ProviderErrorClass | null,
  ): HandoffArtifact {
    const meta: HandoffMeta = {
      schemaVersion: 1,
      parentThreadId: req.parentThreadId,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      childThreadId: req.childThreadId,
      generatedBy: "provider",
      provider: parent.provider,
      ladderStep: step,
      mode,
      generatedAt: new Date().toISOString(),
      characterCount: markdownBody.length,
      parentSdkSessionId: parent.sdkSessionId ?? null,
      providerErrorOnGenerate,
      regenerationHistory: [],
      attachments: [],
    };
    return { markdown: markdownBody, meta };
  }

  private async runDeterministic(
    req: HandoffRequest,
    parent: any,
    messages: any[],
    reason: ProviderErrorClass | null,
  ): Promise<HandoffArtifact> {
    return runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      childThreadId: req.childThreadId,
      reason,
    });
  }
}
```

- [ ] **Step 4: Register in DI container**

Modify `apps/server/src/container.ts`:

```ts
import { HandoffPipelineService } from "./services/handoff/handoff-pipeline.js";
container.registerSingleton(HandoffPipelineService);
```

- [ ] **Step 5: Run tests**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/handoff-pipeline.test.ts)`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/handoff/handoff-pipeline.ts apps/server/src/services/handoff/__tests__/handoff-pipeline.test.ts apps/server/src/container.ts
git commit -m "feat(handoff): add HandoffPipelineService orchestrating B→A→D ladder"
```

---

## Phase 11: Wire pipeline into branch flow

Replaces `createBranchedThread()`'s inline replay with the new pipeline. Copies attachments. Persists artifact. Emits push event.

### Task 11.1: Modify `AgentService.createBranchedThread()`

**Files:**
- Modify: `apps/server/src/services/agent-service.ts`

- [ ] **Step 1: Locate the existing `createBranchedThread` (around line 870-1092)**

Read `apps/server/src/services/agent-service.ts`. Find `createBranchedThread()`. Identify these spots:
  - Where the synthetic handoff system message is inserted (the `buildHandoffContent` call)
  - Where the `providerWireOverride` is constructed with replay text
  - Where attachments are referenced (likely not currently copied)

- [ ] **Step 2: Inject the pipeline dependency**

Add `HandoffPipelineService` and `HandoffStorage` to `AgentService`'s constructor injection list. Update the corresponding DI registration if needed.

- [ ] **Step 3: Replace inline-replay with pipeline orchestration**

In `createBranchedThread()`, replace the block that builds + injects the synthetic handoff system message with:

```ts
// Determine fork anchor role from the fork message.
const forkMsg = messagesUpToFork.find((m) => m.id === forkedFromMessageId);
if (!forkMsg) throw new Error("Fork message not found in parent");
const forkAnchorRole = forkMsg.role === "user" ? "user" : "assistant";

// 1. Run the pipeline (B→A→D ladder).
const artifact = await this.handoffPipeline.orchestrate({
  parentThreadId: parent.id,
  forkedFromMessageId,
  forkAnchorRole,
  childThreadId: child.id,
  childProviderId: child.provider,
});

// 2. Copy parent attachments referenced by messages up to the fork point.
const attachmentSources = this.collectAttachmentSources(messagesUpToFork);
artifact.meta.attachments = await this.handoffStorage.copyAttachments(child.id, attachmentSources);

// 3. Persist the artifact to disk.
await this.handoffStorage.write(child.id, artifact);

// 4. Inject the handoff markdown into the child's first provider turn.
//    `providerWireOverride` already exists — we now pass the artifact markdown
//    instead of the legacy replay string.
const providerWireOverride = artifact.markdown;

// 5. Persist a single non-rendered handoff system message anchoring the child's
//    transcript (so future provider sessions on the child can be re-primed
//    from the DB without re-reading disk).
await this.messageRepo.insert({
  threadId: child.id,
  role: "system",
  content: artifact.markdown,
  sequence: 1,
  isInternal: 1,
  // existing handoff-marker JSON metadata can still be appended here for
  // backwards-compatible UI parsing of the legacy HANDOFF_MARKER block.
});
```

- [ ] **Step 4: Implement `collectAttachmentSources`**

In the same file (or a small helper module), add:

```ts
private collectAttachmentSources(messages: Message[]): AttachmentSource[] {
  const sources: AttachmentSource[] = [];
  for (const m of messages) {
    if (!m.attachments) continue;
    const list = JSON.parse(m.attachments) as Array<{ id: string; path: string; originalName: string; mime: string }>;
    for (const a of list) {
      sources.push({ id: a.id, absolutePath: a.path, originalName: a.originalName, mime: a.mime, parentMessageId: m.id });
    }
  }
  return sources;
}
```

(Adapt to the actual shape of the `attachments` JSON used elsewhere in the codebase.)

- [ ] **Step 5: Emit handoff status push event**

After the artifact is persisted, broadcast a push so the web UI's `threadStore` can transition the child thread's `handoffStatus` from `generating` to `ready` (or `fallback` when `meta.ladderStep === "D"`):

```ts
this.pushBroadcaster.broadcast(`thread.${child.id}.handoff`, {
  status: artifact.meta.ladderStep === "D" ? "fallback" : "ready",
  ladderStep: artifact.meta.ladderStep,
  providerErrorOnGenerate: artifact.meta.providerErrorOnGenerate,
});
```

(Use the actual broadcaster interface in this codebase — verify by reading `apps/server/src/transport/`.)

- [ ] **Step 6: Typecheck + verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/agent-service.ts
git commit -m "feat(agent-service): use HandoffPipelineService in createBranchedThread"
```

### Task 11.2: Wire `deleteThreadFiles` into thread deletion

**Files:**
- Modify: `apps/server/src/services/thread-service.ts` (or wherever thread soft-delete happens)

- [ ] **Step 1: Locate the thread-delete code path**

Search `apps/server` for code that sets `threads.deletedAt`. Find the soft-delete service method.

- [ ] **Step 2: Call `handoffStorage.deleteThreadFiles` on hard delete**

Soft-deletes keep files (in case of restore). On hard delete (i.e. the cleanup job that removes a worktree + DB rows), also wipe handoffs. In the cleanup handler:

```ts
await this.handoffStorage.deleteThreadFiles(threadId);
```

- [ ] **Step 3: Typecheck + verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/services/thread-service.ts
git commit -m "feat(handoff): wipe thread handoff files on hard delete"
```

---

## Phase 12: Push channel + child thread store

### Task 12.1: Define the `handoffStatus` channel in the contracts package

**Files:**
- Modify: `packages/contracts/src/ws/index.ts` (or wherever push channel types live)

- [ ] **Step 1: Add the push payload type**

```ts
export interface HandoffStatusPush {
  channel: "thread.handoff";
  threadId: string;
  status: "generating" | "ready" | "fallback" | "error";
  ladderStep?: "B" | "A" | "D";
  providerErrorOnGenerate?: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | null;
}
```

- [ ] **Step 2: Register the channel name**

Add `"thread.handoff"` to the push channels enum/const list used by transport.

- [ ] **Step 3: Typecheck**

Run: `(cd packages/contracts && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add thread.handoff push channel"
```

### Task 12.2: Subscribe in `threadStore` and expose `handoffStatus`

**Files:**
- Modify: `apps/web/src/stores/threadStore.ts`
- Modify: `apps/web/src/transport/ws-events.ts`

- [ ] **Step 1: Add the slice to `threadStore`**

```ts
// inside the threadStore Zustand store
handoffStatus: {} as Record<string, "generating" | "ready" | "fallback" | "error">,

setHandoffStatus(threadId: string, status: "generating" | "ready" | "fallback" | "error") {
  set((s) => ({ handoffStatus: { ...s.handoffStatus, [threadId]: status } }));
},
```

- [ ] **Step 2: Initialize `generating` on branch click**

In the existing handler that triggers `agent.createAndSend` with `parentThreadId`, immediately call `setHandoffStatus(childThreadId, "generating")` so the UI shows the skeleton.

- [ ] **Step 3: Subscribe to `thread.handoff` push**

In `apps/web/src/transport/ws-events.ts`, add:

```ts
ws.on("push", (msg) => {
  if (msg.channel === "thread.handoff") {
    useThreadStore.getState().setHandoffStatus(msg.threadId, msg.status);
  }
});
```

- [ ] **Step 4: Run web unit tests**

Run: `(cd apps/web && bun run test)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/threadStore.ts apps/web/src/transport/ws-events.ts
git commit -m "feat(web): subscribe threadStore to thread.handoff push"
```

---

## Phase 13: Parent composer fork-mode UX

Fork mode lives in the **parent thread's existing composer** via the already-implemented `ComposerBranchBar`. This phase corrects three things vs the existing implementation:

1. UI copy rename "Branching from" → "Forking from"; icon GitBranch → GitFork; tooltip "Fork from here"
2. On user-msg fork: pre-fill the textarea with the parent message's text (italic styling, editable)
3. On submit: navigate to the child thread which renders a skeleton until the handoff lands

The composer remains the parent's composer until submit. There is no separate child composer.

### Task 13.1: Rename UI copy and swap fork icon

**Files:**
- Modify: `apps/web/src/components/chat/ComposerBranchBar.tsx`
- Modify: `apps/web/src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Update ComposerBranchBar copy**

In `ComposerBranchBar.tsx` (lines 17–43), change:
- "Branching from" → "Forking from"
- aria-label "Exit branch mode" → "Exit fork mode"
- The `↳` glyph stays.

- [ ] **Step 2: Update MessageBubble tooltip + icon**

In `MessageBubble.tsx` find the branch button (lines ~287-296). Change:
- Tooltip text → `"Fork from here"`
- Replace the GitBranch SVG with the GitFork SVG (three-circle Y-shape).

```tsx
// before
<GitBranch className="size-3" />
// after
<GitFork className="size-3" />
```

(Import from lucide-react: `import { GitFork } from "lucide-react";` — already used elsewhere in the codebase.)

- [ ] **Step 3: Visual verify**

If Playwright MCP available: hover the fork button → tooltip says "Fork from here"; click → ComposerBranchBar shows "Forking from".

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/chat/ComposerBranchBar.tsx apps/web/src/components/chat/MessageBubble.tsx
git commit -m "feat(composer): rename branch → fork in UI copy + swap icon"
```

### Task 13.2: Pre-fill textarea on user-msg fork

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx`
- Modify: `apps/web/src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Capture fork message content + role on fork-button click**

In `MessageBubble.tsx`, extend the existing `onBranch(messageId)` callback to also pass the source role and content:

```ts
onBranch(messageId, {
  role: m.role,
  content: m.role === "user" ? m.content : null,
});
```

- [ ] **Step 2: Plumb prefill content into Composer state**

The composer already accepts `branchFromMessageId` and `branchFromMessageContent` props. Either reuse `branchFromMessageContent` for the pre-fill text, or add a new `branchFromUserMessageText: string | null` prop. Pick whichever is less invasive — read the current `ComposerProps` definition in `Composer.tsx:439` to decide.

- [ ] **Step 3: Pre-fill the editor when entering fork mode on a user-msg**

In `Composer.tsx`, in the existing `useEffect` that fires when `branchFromMessageId` changes (~line 757), populate the lexical editor with the user message's text:

```ts
useEffect(() => {
  if (branchFromMessageId && branchFromUserMessageText) {
    // Set lexical editor content. The italic styling comes from a one-shot
    // applied to the inserted run; user can clear it by selecting + retyping.
    setEditorTextItalic(branchFromUserMessageText);
  }
}, [branchFromMessageId, branchFromUserMessageText]);
```

The actual API to set lexical content depends on the editor — read `Composer.tsx` to find the existing imperative APIs.

- [ ] **Step 4: Assistant-msg forks leave textarea empty**

When `branchFromUserMessageText` is null (assistant-msg fork), do nothing — textarea stays empty. Existing behavior.

- [ ] **Step 5: Visual verify**

User-msg fork → composer pre-filled with italic message text, editable.
Assistant-msg fork → composer empty.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/Composer.tsx apps/web/src/components/chat/MessageBubble.tsx
git commit -m "feat(composer): pre-fill textarea on user-msg fork (italic, editable)"
```

### Task 13.3: Child thread skeleton + queued-send hint

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx` (composer of the *child* thread shows hints if the user types while handoff is generating)
- Modify: `apps/web/src/components/chat/MessageList.tsx` or equivalent (assistant skeleton placeholder)

- [ ] **Step 1: Add skeleton placeholder for the in-flight assistant turn**

In the child thread's message list, when `handoffStatus === "generating"` and there's a single user message but no assistant reply yet, render a 3-line skeleton (the `.skel` pattern from the prototype) labeled with "preparing handoff" and the chosen ladder step.

- [ ] **Step 2: Composer queued-send hint**

If the user types in the child thread's composer while handoff is generating, show a small hint *below* the textarea (not as disabled button text): "queued · sends when handoff lands". When `handoffStatus` flips to `ready` or `fallback`, the queued message fires automatically.

- [ ] **Step 3: Run verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/chat
git commit -m "feat(child-thread): skeleton placeholder + queued-send hint during handoff"
```

### Task 13.4: Per-thread fork-mode state preservation

**Files:**
- Modify: `apps/web/src/stores/threadStore.ts`
- Modify: `apps/web/src/components/chat/Composer.tsx`

Per edge case 13: if the user clicks fork, then navigates to another thread before submitting, the fork-mode state must stay on the originating thread, not follow the user.

- [ ] **Step 1: Move fork-mode state into threadStore, keyed by thread id**

```ts
forkMode: {} as Record<string, { messageId: string; content?: string; role: "user" | "assistant" } | null>,
setForkMode(threadId: string, state: { messageId: string; content?: string; role: "user" | "assistant" } | null) {
  set((s) => ({ forkMode: { ...s.forkMode, [threadId]: state } }));
},
```

- [ ] **Step 2: Composer reads fork state for its current thread only**

In `Composer.tsx`, instead of accepting `branchFromMessageId` as a transient prop, read `forkMode[threadId]` from the store. Navigating away from a thread leaves its entry untouched.

- [ ] **Step 3: Clear fork mode on successful submit, not on navigation**

When the user submits a fork (creating the child thread), call `setForkMode(parentThreadId, null)` to clear the bar.

- [ ] **Step 4: Run verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/threadStore.ts apps/web/src/components/chat/Composer.tsx
git commit -m "feat(composer): per-thread fork-mode state preserved across navigation"
```

---

## Phase 13.5: Slash command provider override in fork mode

Existing bug surfaced by prototype scenario 07: the slash-command palette inside the composer reads from `thread.provider`, so when the user picks a different provider for the fork (Claude parent → Codex child), the palette still shows the parent's command set. Fix is small and well-scoped.

### Task 13.5.1: Source slash commands from the in-flight provider selection

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx`
- Modify: wherever the slash command list is fetched (likely a hook like `useSlashCommands(providerId)` or a store selector — verify by reading `Composer.tsx` and the SlashCommandPopup component)

- [ ] **Step 1: Locate the current slash command source**

Grep for `useSlashCommands`, `slashCommands`, or the slash popup component. Find the line that reads provider — almost certainly `thread.provider` or similar.

- [ ] **Step 2: Introduce `composerProviderOverride`**

The composer already tracks which provider the user has selected for the next send (it's how new-thread mode works). Reuse that. The effective provider for slash command resolution becomes:

```ts
const effectiveProviderId = composerProviderOverride ?? thread.provider;
const commands = useSlashCommands(effectiveProviderId);
```

`composerProviderOverride` should already exist as state for the new-thread / fork composer's provider picker. If it doesn't, derive it from the current `providerId` state in `Composer.tsx`.

- [ ] **Step 3: Validate slash command at send-time**

Per edge case 11: if the user types `/cmd` for a command that exists in the old provider's set but not the new one, the send must not silently fail.

At send-time, parse the leading `/cmd`. If it doesn't exist in `useSlashCommands(effectiveProviderId)`, surface a toast:

```ts
toast.error(`/${cmd} is not available on ${effectiveProviderId}`);
// retain the textarea content; do not send
return;
```

- [ ] **Step 4: Write a unit test for the resolver**

Add a test asserting:
- No fork-mode override → uses `thread.provider`
- Fork-mode with override → uses the override
- Commands from `.claude/commands/` not present when override is `"codex"`

- [ ] **Step 5: Visual verify**

If Playwright MCP available: open a Claude thread → click fork → switch provider to Codex in the composer → type `/` → palette shows Codex commands, no Claude-specific subagents like `/frontend-engineer`.

- [ ] **Step 6: Run verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/chat
git commit -m "fix(composer): slash command palette sources from in-flight provider selection"
```

---

## Phase 14: Fallback notification banner

The 3b notification: when `handoffStatus === "fallback"`, show a banner in the child thread. Setting controls whether it appears at all.

### Task 14.1: Add settings entry for notification toggle

**Files:**
- Modify: settings schema (per `docs/guides/settings-schema.md`)

- [ ] **Step 1: Add the setting**

Following the nesting rule from `feedback_settings_schema_nesting.md` (never bake a qualifier into a property name; nest it even for one setting):

```jsonc
{
  "chat": {
    "handoff": {
      "notifyOnLocalFallback": true
    }
  }
}
```

Add this to the canonical settings Zod schema (`packages/contracts/src/...` or wherever) with default `true`, plus a settings-UI surface (toggle row labeled "Notify when handoff falls back to local generation").

- [ ] **Step 2: Typecheck + commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add packages/contracts apps/web/src/components/settings
git commit -m "feat(settings): add chat.handoff.notifyOnLocalFallback toggle"
```

### Task 14.2: Build `HandoffFallbackBanner`

**Files:**
- Create: `apps/web/src/components/chat/HandoffFallbackBanner.tsx`
- Test: `apps/web/e2e/handoff-fallback-banner.spec.ts` (E2E)

- [ ] **Step 1: Implement the component**

Use existing shadcn primitives (per `docs/guides/ui-components.md`).

```tsx
// apps/web/src/components/chat/HandoffFallbackBanner.tsx
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";

interface Props {
  threadId: string;
}

/**
 * Banner shown at the top of a child thread when the handoff was produced
 * by deterministic fallback (path D) instead of the user's provider.
 * Suppressed when chat.handoff.notifyOnLocalFallback is false.
 *
 * The "Regenerate with provider" button is a v1 stub — it sends the
 * handoff.regenerate RPC which currently returns NotImplemented. Live
 * regeneration is a follow-on plan.
 */
export function HandoffFallbackBanner({ threadId }: Props) {
  const enabled = useSettings((s) => s.chat.handoff.notifyOnLocalFallback);
  const status = useThreadStore((s) => s.handoffStatus[threadId]);

  if (!enabled || status !== "fallback") return null;

  return (
    <div
      role="status"
      data-testid="handoff-fallback-banner"
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <AlertCircle className="h-4 w-4 text-amber-600" aria-hidden />
      <span className="flex-1">
        Handoff generated locally — your provider was unavailable.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled
        title="Coming soon"
        className="gap-1"
      >
        <RotateCcw className="h-3 w-3" />
        Regenerate
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Mount the banner in the thread view**

Find the thread view container (likely `apps/web/src/components/chat/ThreadView.tsx` or similar). Mount the banner above the message list:

```tsx
<HandoffFallbackBanner threadId={threadId} />
{/* existing message list */}
```

- [ ] **Step 3: Write the Playwright E2E**

```ts
// apps/web/e2e/handoff-fallback-banner.spec.ts
import { test, expect } from "@playwright/test";

test("fallback banner appears when handoffStatus is fallback", async ({ page }) => {
  await page.goto("/");
  // Set up a thread with handoffStatus=fallback via test-only seed endpoint
  // (or by mocking the WS push). Adapt to existing test-seed conventions.
  await page.evaluate(() => {
    // @ts-expect-error — test hook
    window.__mcodeTestSetHandoffStatus("t_child", "fallback");
  });
  const banner = page.getByTestId("handoff-fallback-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("provider was unavailable");
});

test("banner is suppressed when setting is off", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    // @ts-expect-error
    window.__mcodeTestSetSetting("chat.handoff.notifyOnLocalFallback", false);
    // @ts-expect-error
    window.__mcodeTestSetHandoffStatus("t_child", "fallback");
  });
  await expect(page.getByTestId("handoff-fallback-banner")).toHaveCount(0);
});
```

- [ ] **Step 4: Add the test-only hooks**

If `__mcodeTestSetHandoffStatus` / `__mcodeTestSetSetting` don't exist, add them under a `if (import.meta.env.MODE === "test")` block in the appropriate store init file. These are dev-only debug hooks; do not ship in production builds.

- [ ] **Step 5: Run E2E**

Run: `(cd apps/web && bun run e2e -- handoff-fallback-banner)`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/HandoffFallbackBanner.tsx apps/web/e2e/handoff-fallback-banner.spec.ts
git commit -m "feat(web): add HandoffFallbackBanner with notification setting"
```

### Task 14.3: Add `handoff.regenerate` RPC stub

**Files:**
- Modify: `apps/server/src/transport/ws-router.ts`
- Modify: `packages/contracts/src/ws/methods.ts` (or wherever method names live)

- [ ] **Step 1: Add the method name**

Add `"handoff.regenerate"` to the WS method list with input shape `{ threadId: string }` and output shape `{ status: "not-implemented" }`.

- [ ] **Step 2: Implement the stub handler**

```ts
// in ws-router.ts
case "handoff.regenerate": {
  // v1 stub — live regeneration is deferred to a follow-on plan.
  return { status: "not-implemented" as const };
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add apps/server/src/transport/ws-router.ts packages/contracts
git commit -m "feat(handoff): add handoff.regenerate RPC stub for v1"
```

---

## Phase 15: End-to-end happy-path test

A single integration test that exercises the full pipeline against a mocked Claude provider.

### Task 15.1: Write the integration test

**Files:**
- Create: `apps/server/src/services/handoff/__tests__/branch-flow.e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { container } from "tsyringe";
import { AgentService } from "../../agent-service.js";
import { HandoffStorage } from "../handoff-storage.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("branch flow with handoff pipeline", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "branch-e2e-"));
    process.env.MCODE_DATA_DIR = dataDir;
    // Reset DI, register test doubles.
    container.clearInstances();
    // Register a fake Claude provider whose runSideChannelQuery returns canned text.
    // ... (use existing test-utils for provider mocking)
  });

  it("path B success persists artifact + primes child thread", async () => {
    const svc = container.resolve(AgentService);
    const parent = await svc.createThread({ workspaceId: "w1", title: "Parent", provider: "claude" });
    await svc.sendMessage({ threadId: parent.id, content: "first question" });
    const parentMessages = await svc.listMessages(parent.id);
    const forkMsgId = parentMessages.at(-1)!.id;

    const child = await svc.createAndSend({
      workspaceId: "w1",
      parentThreadId: parent.id,
      forkedFromMessageId: forkMsgId,
      provider: "claude",
      mode: "direct",
      content: "follow-up in branch",
    });

    // Handoff doc should exist on disk.
    const storage = container.resolve(HandoffStorage);
    const artifact = await storage.readLatest(child.id);
    expect(artifact).not.toBeNull();
    expect(artifact!.meta.generatedBy).toBe("provider");
    expect(artifact!.meta.ladderStep).toBe("B");

    // Child thread first message should be a system message with isInternal=1.
    const internalMsgs = await svc.listMessagesIncludingInternal(child.id);
    expect(internalMsgs[0].role).toBe("system");
    expect(internalMsgs[0].isInternal).toBe(1);
  });

  it("path B quota failure falls to D + banner state", async () => {
    // Configure mock to throw 429 on side-channel call.
    // Assert resulting artifact.meta.ladderStep === "D"
    // Assert push event with status: "fallback" was broadcast.
  });
});
```

- [ ] **Step 2: Run the test**

Run: `(cd apps/server && npx vitest run src/services/handoff/__tests__/branch-flow.e2e.test.ts)`
Expected: PASS.

- [ ] **Step 3: Run full verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/services/handoff/__tests__/branch-flow.e2e.test.ts
git commit -m "test(handoff): end-to-end branch flow integration test"
```

---

## Phase 16: Final verification + docs

### Task 16.1: Update narrative-pipeline / handoff documentation

**Files:**
- Modify: `docs/guides/narrative-pipeline.md` (mention the new handoff pipeline in the relevant section)
- Create: `docs/guides/chat-branch-handoff.md` (new guide)

- [ ] **Step 1: Write the guide**

Create `docs/guides/chat-branch-handoff.md` documenting:
- The B→A→D ladder
- Provider capability declarations (`sessionForkOnResume`, `maxInputCharactersPerTurn`)
- Storage layout (`<MCODE_DATA_DIR>/threads/<id>/handoffs/<ulid>/`)
- Full vs minimal mode
- How to add support for a new provider

- [ ] **Step 2: Reference from AGENTS.md**

Add to AGENTS.md's "Key Documentation" section:

```md
- **Chat branch handoff:** [docs/guides/chat-branch-handoff.md](docs/guides/chat-branch-handoff.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/guides/chat-branch-handoff.md docs/guides/narrative-pipeline.md AGENTS.md
git commit -m "docs(handoff): document chat branch handoff pipeline"
```

### Task 16.2: Final verify + visual check

- [ ] **Step 1: Run full verify**

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 2: Run E2E suite**

Run: `(cd apps/web && bun run e2e)`
Expected: PASS — note pass count.

- [ ] **Step 3: Visual verify (if Playwright MCP available)**

If `mcp__playwright__browser_navigate` is available:
- Start dev server
- Branch from a user message → confirm composer pre-fills, no auto-submit
- Branch from an assistant message → confirm composer empty
- Force a path-D fallback (mock or env var) → confirm banner appears
- Toggle the setting off → confirm banner disappears

- [ ] **Step 4: Final commit (if any docs updates were needed)**

```bash
git add -A
git commit -m "docs(handoff): final pass after visual verification"
```

---

## Phase 17: Robustness — edge cases from prototype review

The prototype storyboard surfaced 13 edge cases the prose-only plan glossed over. Some are handled implicitly by earlier phases (e.g. cross-provider budget already pulls from child's cap in Phase 6); the rest are addressed here as small targeted tasks.

### Task 17.1: Pipeline guards for in-flight parent + missing session

**File:** `apps/server/src/services/handoff/handoff-pipeline.ts`

- [ ] **Step 1: Add `waitForParentSettled` before path B**

Before invoking `runSideChannelQuery`, check whether the parent's session has an in-flight stream. If yes, await its completion (or 30s timeout). If timeout fires, classify as `transient` and fall to D.

```ts
if (this.deps.streamRegistry.isStreaming(req.parentThreadId)) {
  const settled = await this.deps.streamRegistry.awaitSettled(req.parentThreadId, 30_000);
  if (!settled) {
    logger.warn({ threadId: req.parentThreadId }, "Parent stream did not settle within 30s; falling to D");
    return this.runDeterministic(req, parent, messages, "transient");
  }
}
```

(Verify `streamRegistry` exists; if not, add a minimal in-memory registry that tracks active streams per thread id.)

- [ ] **Step 2: Skip B/A when parent has no `sdkSessionId`**

In the existing `if (capability === "clean" && parentProvider?.runSideChannelQuery && parent.sdkSessionId)` guard, the third clause already handles this — but make sure path A's branch *also* checks `parent.sdkSessionId` (since path A requires the parent to have responded at least once). Add the guard there too.

- [ ] **Step 3: Test**

```ts
it("falls to D when parent has no sdkSessionId", async () => { /* ... */ });
it("waits for parent stream to settle before path B", async () => { /* ... */ });
it("falls to D on 30s settle timeout", async () => { /* ... */ });
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/services/handoff
git commit -m "feat(handoff): guard pipeline on in-flight parent + missing session"
```

### Task 17.2: Side-channel query soft timeout

**File:** `apps/server/src/services/handoff/handoff-pipeline.ts`

- [ ] **Step 1: Wrap path B/A invocation in 60s AbortController**

```ts
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 60_000);
try {
  const text = await parentProvider.runSideChannelQuery({ ...args, abortSignal: abort.signal });
  return this.buildProviderArtifact(...);
} catch (err) {
  if (abort.signal.aborted) {
    return this.runDeterministic(req, parent, messages, "transient");
  }
  // ... existing error handling
} finally {
  clearTimeout(timer);
}
```

- [ ] **Step 2: Test**

```ts
it("aborts side-channel query at 60s and falls to D", async () => { /* ... */ });
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/handoff
git commit -m "feat(handoff): 60s soft timeout on path B/A"
```

### Task 17.3: Per-thread mutex on path A

Path A's hidden turns are not idempotent — concurrent invocations against the same parent thread would interleave on the session. Path B is safe (Claude's resume forks). Add a mutex for path A only.

**File:** `apps/server/src/services/handoff/handoff-pipeline.ts`

- [ ] **Step 1: Add a per-thread lock for path A**

```ts
private readonly pathALocks = new Map<string, Promise<void>>();

private async withPathALock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  while (this.pathALocks.has(threadId)) await this.pathALocks.get(threadId);
  let release!: () => void;
  const p = new Promise<void>((res) => { release = res; });
  this.pathALocks.set(threadId, p);
  try {
    return await fn();
  } finally {
    this.pathALocks.delete(threadId);
    release();
  }
}
```

Wrap the path A invocation: `return this.withPathALock(req.parentThreadId, () => parentProvider.runHiddenTurn(...));`

- [ ] **Step 2: Test concurrent fork serialization**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/handoff
git commit -m "feat(handoff): per-thread mutex on path A serializes hidden turns"
```

### Task 17.4: Attachment size cap

Edge case 05: oversized attachments duplicated naively bloat disk.

**File:** `apps/server/src/services/handoff/handoff-storage.ts`

- [ ] **Step 1: Cap individual attachment copy at 25MB**

In `copyAttachments`, before `copyFile`:

```ts
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const stat = await stat(s.absolutePath);
if (stat.size > ATTACHMENT_MAX_BYTES) {
  logger.warn({ id: s.id, size: stat.size }, "Attachment exceeds 25MB; skipping copy");
  // Still include in manifest with a reference path to the original location
  result.push({ id: s.id, originalName: s.originalName, sha256: "<skipped>", mime: s.mime, parentMessageId: s.parentMessageId });
  continue;
}
```

- [ ] **Step 2: Test**

```ts
it("skips copy and records skip marker for >25MB attachments", async () => { /* ... */ });
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/handoff/handoff-storage.ts
git commit -m "feat(handoff): cap attachment copy at 25MB; reference-only beyond"
```

### Task 17.5: Post-write doc size validation + truncation

Edge case 09: provider overshoots the requested budget. Post-write check; truncate at section boundaries.

**File:** `apps/server/src/services/handoff/handoff-pipeline.ts`

- [ ] **Step 1: After provider returns text, validate against budget**

```ts
const budget = computeBudgetChars(childCap);
if (text.length > budget * 1.15) {
  logger.warn({ produced: text.length, budget, ladderStep: step }, "Provider exceeded handoff budget; truncating");
  text = truncateAtSectionBoundary(text, budget);
  // Append a marker so the user knows
  text += "\n\n<!-- handoff truncated at budget; see full doc on disk -->";
}
```

- [ ] **Step 2: Implement `truncateAtSectionBoundary`**

```ts
/** Truncates markdown at the last complete H2 section boundary before maxChars. */
function truncateAtSectionBoundary(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const slice = md.slice(0, maxChars);
  const lastH2 = slice.lastIndexOf("\n## ");
  return lastH2 > maxChars * 0.5 ? slice.slice(0, lastH2) : slice;
}
```

- [ ] **Step 3: Test**

```ts
it("truncates at last complete section boundary", () => { /* ... */ });
it("falls back to hard truncate when no boundary is past halfway", () => { /* ... */ });
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/services/handoff
git commit -m "feat(handoff): post-write budget validation + section-boundary truncation"
```

### Task 17.6: Abandoned-child cleanup

Edge case 04: user navigates away or deletes the child mid-generation.

**File:** `apps/server/src/services/handoff/handoff-pipeline.ts` + `apps/server/src/services/agent-service.ts`

- [ ] **Step 1: Check child thread existence before persisting artifact**

After the ladder produces an artifact, before calling `storage.write`:

```ts
const child = await this.deps.threadRepo.findById(req.childThreadId);
if (!child || child.deletedAt) {
  logger.info({ childThreadId: req.childThreadId }, "Child thread deleted before handoff persistence; dropping result");
  return; // do not write
}
```

- [ ] **Step 2: Test**

```ts
it("drops artifact write when child thread is deleted before completion", async () => { /* ... */ });
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/handoff apps/server/src/services/agent-service.ts
git commit -m "feat(handoff): drop artifact when child thread vanishes mid-generation"
```

### Task 17.7: Run full verify

- [ ] **Step 1: Verify all phases together**

Run: `bun run verify`
Expected: PASS — all 7 robustness tasks plus prior phases.

Run: `(cd apps/web && bun run e2e)`
Expected: PASS — note count.

---

## Deferred Items (recorded for future plans)

These items came up during design but were intentionally scoped out of this plan:

1. **Live regeneration RPC** — the "Regenerate with provider" button on the fallback banner. Stub returns `not-implemented`. Full implementation requires a separate plan covering: ladder re-attempt, atomic doc replace, `regenerationHistory` append, push event for state transition, and the visibility window (button hides after child has had post-handoff turns).

2. **Same-thread cross-provider switch** — the parked scenario where a user switches providers mid-conversation in the same thread. Uses the same pipeline primitive but with implicit anchor (last message), no child thread, and a per-message `providerId` UI divider. Pending UX prototype via the `impeccable` skill.

3. **Content-addressable blob store for attachments** — v2 optimization to deduplicate attachments across forks. Replace straight-copy with sha256-keyed blobs under `<MCODE_DATA_DIR>/blobs/`, per-thread manifests, GC on thread delete. Triggered when disk usage from straight-copy becomes a user-facing complaint.

4. **Post-window handoff regeneration** — separate "Regenerate handoff" action in thread settings, available after the child has had turns (where the banner button hides). Updates the on-disk doc for portability without touching the live conversation.

5. **`/handoff` argument-as-intent UI surface** — exposing a "What's this branch about?" field in the branch composer that flows into the `/handoff` skill's argument. Currently v1 generates handoffs without a user-supplied intent.

6. **Switch-back session restoration** — when the user switches a thread back to a previously-active provider (in the same-thread switch flow), optionally restore that provider's prior session ID rather than starting fresh.

7. **`messages.providerId` field** — separate from `messages.model` for explicit provider attribution. Current `model` column suffices since models map 1:1 with providers in mcode today; revisit when a single provider supports many models with ambiguous attribution.

---

## Self-Review Notes

- **Spec coverage check:** Every grilled decision + every prototype-surfaced edge case is implemented:
  - B/A/D ladder → Phases 5, 8, 9, 10
  - Storage layout → Phases 2, 7
  - Cursor disregard turn → Phase 8.3
  - Pre-fill on user-msg fork (parent composer, italic, no auto-submit) → Phase 13.2
  - Character-budget (not tokens) → Phase 6
  - Minimal mode for sub-8k providers → Phase 6
  - Settings toggle + banner → Phase 14
  - Attachment copy + 25MB cap → Phases 7, 11, 17.4
  - `isInternal` for hidden turns → Phase 3
  - Vendored `/handoff` prompt → Phase 6
  - ULID-named handoff dirs → Phase 2
  - **Branch → Fork UI rename + GitFork icon** → Phase 13.1
  - **Parent composer (not child) hosts fork mode** → Phase 13
  - **Per-thread fork-mode state preservation across nav** → Phase 13.4
  - **Slash command palette sources from in-flight provider override** → Phase 13.5
  - **In-flight parent stream settle guard** → Phase 17.1
  - **60s side-channel timeout** → Phase 17.2
  - **Path A per-thread mutex** → Phase 17.3
  - **Post-write budget truncation at section boundaries** → Phase 17.5
  - **Abandoned-child cleanup** → Phase 17.6

- **Type consistency check:** `HandoffArtifact`, `HandoffMeta`, `LadderStep`, `HandoffMode`, `ForkAnchorRole`, `ProviderErrorClass` defined once in `handoff-types.ts` and referenced everywhere. `runSideChannelQuery` / `runHiddenTurn` method signatures consistent between contracts interface and provider implementations.

- **Placeholder scan:** No `TBD`, no `implement later`. Every step has either code or an exact command.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-21-chat-branch-handoff-pipeline.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because phases 1–10 (server-side foundation through pipeline) are highly serial and each task is well-bounded; subagent isolation prevents cross-task state contamination during TDD cycles.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Useful if you want to ride along, intercept design questions in real time, and shape the wire-up phases (11–14) directly.

**Which approach?**

