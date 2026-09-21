# Benchmark: where the ~30s TTFT and token spend go on the app-server path

Wayfinder ticket: [#1711](https://github.com/Mzeey-Empire/mcode/issues/1711). Map: [#1710](https://github.com/Mzeey-Empire/mcode/issues/1710).

Measured 2026-09-21, codex-cli 0.153.0, Windows, Node harness driving `codex app-server` over NDJSON with the same RPC sequence Mcode uses (`initialize` -> `initialized` -> `thread/start` -> `turn/start`). Harness and raw results: `bench-codex.mjs`, `bench-codex-reps.mjs`, `bench-codex-results.json`, `bench-codex-reps.json` in this directory. `cwd` was the repo root, so Codex auto-loaded AGENTS.md/CLAUDE.md like a real session. Prompts were trivial (`Reply with exactly: OK`) except two ~400-word generation turns to grow context. n=1-2 per config; treat single samples as directional, not precise.

## Results

### Handshake (spawn -> ready)

| Run | spawn->`initialize` result | `thread/start` |
|---|---|---|
| Cold process | 188ms | 863ms |
| Warm process (second spawn) | 252ms | 375ms |

**Handshake is not the bottleneck.** ~0.4-1.3s total, far under the 10s+ worst case the warmup code guards against (`codex-app-server.ts` cold-start comment). No auth refresh was needed in this window; that path may still spike occasionally.

### Per-turn, effort variants on fresh threads (identical trivial prompt)

| Variant | TTFT | Total | Input tok | Cached | Reasoning tok |
|---|---|---|---|---|---|
| high, default tier (first run) | 16007ms | 17931ms | 31721 | 0 | 0 |
| high, default (reps) | 4662ms, 4078ms | ~6s | ~31.7k | 0 | 0 |
| low | 4241ms, 3817ms, 3613ms | ~5-7s | ~31.7k | 0 | 0 |
| medium | 13890ms*, 3378ms, 3519ms | ~5-15s | ~31.7k | 0-26k | 0 |
| minimal | 3677ms | 4364ms | n/a | n/a | n/a |
| none | 3339ms | 6319ms | 31729 | 0 | 0 |
| high + `serviceTier: "priority"` | 4617ms, 3630ms, 4353ms | ~5-8s | ~31.7k | 0-26k | 0 |

\* single outlier from the first run.

### Context growth on one warm thread (effort high)

| Turn | TTFT | Total | Input tok | Cached | Output |
|---|---|---|---|---|---|
| A1 short | 16007ms | 17.9s | 31721 | 0 | 5 |
| A2 ~400 words | 1155ms | 102s | 37293 | 32512 | 774 |
| A3 ~400 words | 1619ms | 45.6s | 38431 | 37632 | 740 |
| A4 short | 1105ms | 3.1s | 39184 | 37632 | 5 |

## Attribution

1. **The ~32k static prefix dominates per-turn input.** A trivial prompt on a fresh thread already costs ~31.7k input tokens: Codex's harness system prompt + tool defs + env context + auto-loaded AGENTS.md/CLAUDE.md. Every turn re-sends it; prompt caching (`cachedInputTokens`) absorbs the prefill cost once warm, and **the cache is shared across threads** (fresh threads in the rep run showed `cached=26368`).
2. **TTFT floor: ~3.4-4.7s on a fresh thread, ~1.1-1.6s on a warm thread.** Effort (`none` -> `high`) moved TTFT by <1s on trivial prompts; reasoning effort is **not** the TTFT driver for content-free prompts. The observed variance (16s vs 4s for identical requests) is cold-cache/backend-congestion, not effort.
3. **Generation, not prefill, is the long pole on real output.** A2 produced 774 output tokens in ~102s (~7.6 tok/s effective), A3 740 in ~45.6s. On substantive prompts the model's thinking+writing time dwarfs protocol overhead, consistent with a user-observed ~30s on real turns being mostly model time at `effort: high` plus periodic cold-cache spikes.
4. **Context grows ~5-7k tokens per substantive turn** and is re-sent every turn (server-side thread). Long threads inflate both prefill latency and token spend monotonically.
5. **`serviceTier: "priority"` did not clearly separate** in the rep run (3.6-4.6s vs 3.4-4.7s default); sample too small to rule out a benefit during congestion, but first-run outliers hint the default tier occasionally queues.

## What this means for the transport decision (#1719)

- The protocol layer is ~1s; **transport swap alone cannot fix a 30s experience rooted in model thinking time and context size.**
- The real token lever is the static prefix: ~32k/turn with Codex's own instructions. On the own-the-loop (Responses API) path Mcode controls `instructions` entirely; a minimal prompt could cut per-turn input by an order of magnitude.
- "Durable threads" via server-side thread context is what makes per-turn input grow; client-side replay (Responses path) trades that for context we trim ourselves.
- Reasoning effort is orthogonal to transport: it only bites on substantive prompts, which this benchmark deliberately did not exercise. A real-workload follow-up (typical coding turn, not `OK`) would quantify the effort premium properly.

## Caveats

- n=1-2 per config; first-run outliers (16s, 13.9s) vs tight rep runs (3.4-4.7s) show meaningful variance, likely cold prompt cache plus shared-tier congestion.
- Trivial prompts measure the floor, not real coding turns; reasoning token counts stayed ~0, so the effort premium on real work is unmeasured here.
- No `developerInstructions` were sent on `thread/start` (Mcode sends up to ~4k chars); real sessions sit slightly above these numbers.
