# Dynamic Context Window Discovery and User Override

**Goal:** Surface per-model context window sizes in the model selector, fetch them live from the Anthropic Models API for Claude, and let users override the value in settings when the SDK binary reports stale data.

**Prerequisite:** PR #356 (static `MODEL_CONTEXT_WINDOWS` in `@mcode/shared/model-context`).

---

## Problem

The Claude Agent SDK binary (v2.1.104) reports 200K as the context window for all Claude models, including Sonnet 4.6, Opus 4.6, and Opus 4.7, which Anthropic's docs confirm support 1M. PR #356 added correct static values, but the SDK runtime value overrides them after the first turn. Users have no way to see or correct the context window from within mcode.

## Approach

Follow the same dynamic model listing pattern that Copilot already uses:

1. `ClaudeProvider.listModels()` calls the Anthropic REST API (`GET /v1/models`) for live per-account model metadata, including the real context window.
2. The model selector shows a context window badge next to each model.
3. Users can set a `model.defaults.contextWindow` override in settings when the SDK or API value is wrong for their account.
4. The preference chain is updated so the user override wins over all other sources.

---

## Design

### 1. Server: `ClaudeProvider.listModels()`

**File:** `apps/server/src/providers/claude/claude-provider.ts`

Add a `listModels()` method that:

- Calls `GET https://api.anthropic.com/v1/models` with the `ANTHROPIC_API_KEY` environment variable and the required `anthropic-version` header.
- Filters the response to `claude-*` models.
- Maps each model to `ProviderModelInfo`:
  - `id`: model ID from the API
  - `name`: display name derived from the model ID
  - `contextWindow`: `model.max_input_tokens` from the API response (e.g., 1,000,000 for Sonnet 4.6)
- Caches the result in-memory with a 5-minute TTL. Model lists rarely change and this matches the Copilot provider's fetch-on-hover pattern.

**File:** `apps/web/src/lib/model-registry.ts`

Set `supportsModelListing: true` on the Claude provider entry in `MODEL_PROVIDERS`. This triggers the existing `fetchProviderModels` path in the model selector on hover, identical to Copilot.

No transport changes needed. The existing RPC route at `ws-router.ts:567-574` already dispatches `provider.listModels` to the resolved provider.

### 2. Web: Model selector context window badge

**File:** `apps/web/src/components/chat/ModelSelector.tsx`

**2a. Pass `contextWindow` through from dynamic listings.**

`fetchProviderModels` (line 82-88) currently maps the response to `{ id, label, providerId, group, multiplier }` and drops `contextWindow`. Add `contextWindow: m.contextWindow` to the mapped object so it flows through `ModelDefinition.contextWindow`.

**2b. Render the badge in `renderModelRow`.**

After the model label, render a compact context window badge when `contextWindow` is present:

```
[Opus 4.7]                [1M]
[Sonnet 4.6]              [1M]
[Haiku 4.5]             [200K]
```

Formatting: `contextWindow >= 1_000_000` displays as "1M", otherwise `${contextWindow / 1000}K`. Styled with `text-[10px] text-muted-foreground/60 tabular-nums`, matching the existing Copilot `multiplier` badge.

The `multiplier` badge is Copilot-specific. Claude models do not show `multiplier`. The two badges never overlap for the same model.

For static-only providers (no `listModels()`), the badge still works because `ModelDefinition.contextWindow` is already populated from the static registry (PR #356).

### 3. Settings: context window override

**File:** `packages/contracts/src/models/settings.ts`

Add `contextWindow` to the `model.defaults` schema:

```typescript
defaults: z.object({
  provider: z.string().default("claude"),
  id: z.string().default("claude-sonnet-4-6"),
  reasoning: z.string().default("high"),
  fallbackId: z.string().optional(),
  contextWindow: z.number().optional(),  // new
}),
```

This is a single user-controlled value under `model.defaults`. When set, it overrides whatever the API or SDK reports for the user's default model. It addresses the case where the SDK binary reports 200K but the user knows their account supports 1M.

**Settings UI:** expose the field as a numeric input in the model defaults section of the settings page, pre-filled with the API-fetched or static value when no override is set.

**Docs:** update `docs/guides/settings-schema.md` and `docs/settings/reference.md` with the new field.

### 4. Preference chain

**Current chain** (`threadStore.ts:1429`):

```
SDK runtime → static registry → prev stored
```

**New chain:**

```
user settings override → API-fetched (ModelDefinition.contextWindow) → static registry → SDK runtime → prev stored
```

**Implementation in `threadStore.ts`:**

When computing the context window for display:

1. Check `useSettingsStore.getState().settings.model.defaults.contextWindow`. If the thread's active model matches the user's default model and the override is set, use it.
2. Otherwise, fall back to `getContextWindow(modelId)`, which returns the `ModelDefinition.contextWindow` (populated from the API-fetched list or the static registry).
3. Then the SDK runtime value (`sdkContextWindow`).
4. Then the previously stored value.

**`handoff-builder.ts`:** continues to use `getModelContextWindow()` from `@mcode/shared/model-context` (the static map). The handoff budget calculation does not need user-override precision since the static values are correct per Anthropic's documentation.

**Behavioral note:** when the user sets `contextWindow: 1_000_000` in settings and the SDK binary reports 200K, the gauge shows 1M. The SDK still handles API-level compaction internally at whatever its actual limit is. The gauge reflects the user's declared truth.

---

## What is NOT in scope

- Per-model context window overrides (only the default model gets an override; switching models uses API-fetched or static values).
- Auto-compaction on model switch (the SDK handles this autonomously).
- Modifying the Claude Agent SDK binary or its reported values.
- Context window for non-Claude providers (Copilot already handles this dynamically; Codex is SDK-sourced).

---

## Testing

- **Unit:** `ClaudeProvider.listModels()` returns correct `ProviderModelInfo[]` with `contextWindow` populated (mock the API call).
- **Unit:** `fetchProviderModels` in `ModelSelector` correctly passes `contextWindow` through to `ModelDefinition`.
- **Unit:** Settings schema validates `model.defaults.contextWindow` as optional number.
- **Unit:** Preference chain in `threadStore` applies the correct priority order.
- **E2E:** Model selector shows context window badge for Claude models.
- **E2E:** Setting `model.defaults.contextWindow` overrides the displayed gauge value.
