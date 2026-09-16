# Codex Responses API Direct: Research Notes

**Status:** Research only; no implementation changes.
**Ticket:** GitHub issue #1714 (parent #1710; blocks the transport decision in #1719).
**Question:** Could Mcode drive the Codex Responses API directly (the own-the-loop option), reusing existing auth?
**Sources read:** `NousResearch/hermes-agent` at `.opensrc/repos/github.com/NousResearch/hermes-agent/main/` and `openai/codex` at `.opensrc/repos/github.com/openai/codex/main/`, plus the Mcode provider contracts in this worktree.

---

## 1. Auth verdict: yes, `codex login` tokens drive `backend-api/codex` directly

**The tokens `codex login` stores in `~/.codex/auth.json` can drive `https://chatgpt.com/backend-api/codex` directly. No separate OAuth client or client_id is needed.**

Evidence, in three layers:

1. **Same OAuth client.** Codex CLI's public client_id is `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-rs/login/src/auth/manager.rs:1732`). Hermes uses the identical constant (`hermes_cli/auth_constants.py:88`) for its own independent `openai-codex` login. The ChatGPT Codex backend does not distinguish which harness holds the token; it accepts any valid access token minted under this client.
2. **Hermes already imports the CLI's tokens.** `_import_codex_cli_tokens()` reads `CODEX_HOME/auth.json`, pulls `tokens.access_token` + `tokens.refresh_token`, skips them only if the access token is already expired, and persists them into Hermes' own store (`hermes_cli/auth_codex.py:~418-431`). `_recover_codex_tokens_from_cli()` re-imports them when Hermes' own refresh fails with a relogin-class error (`auth_codex.py:185-197`). During `hermes auth` setup the CLI file is offered as an import source (`auth_codex.py:~712-725`).
3. **The wire requirements are satisfiable from the file alone.** Requests need `Authorization: Bearer <access_token>` plus `ChatGPT-Account-ID: <chatgpt_account_id>`, and the account id is a claim inside the access-token JWT itself (`https://api.openai.com/auth` -> `chatgpt_account_id`; decoded in `agent/codex_headers.py:30-66` and `hermes_cli/codex_models.py:~96-120`). Nothing else in auth.json is required to call `/responses`.

### `~/.codex/auth.json` shape

`AuthDotJson` (`codex-rs/login/src/auth/storage.rs:41-70`):

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<raw JWT>",
    "access_token": "<JWT>",
    "refresh_token": "<single-use rotating token>",
    "account_id": "<chatgpt account id>"
  },
  "last_refresh": "<RFC3339>"
}
```

`auth_mode` is `chatgpt` for OAuth logins and `apikey` for API-key logins (`codex-rs/protocol/src/auth.rs:9-38`; serialized lowercase, with `chatgptAuthTokens`, `personalAccessToken`, `bedrockApiKey`, `bedrockAccessKeys` variants). Only ChatGPT-mode tokens are valid against `backend-api/codex`; an `OPENAI_API_KEY` targets `api.openai.com` instead. `tokens.id_token` serializes as the raw JWT string (`token_data.rs:200-212`). The file lives at `$CODEX_HOME/auth.json`, defaulting to `~/.codex` (`storage.rs:154-155`).

One portability caveat: `cli_auth_credentials_store` in `config.toml` selects storage: `file` (default), `keyring`, `auto`, or `ephemeral` (`codex-rs/config/src/types.rs:111-125`). A user who configured keyring/ephemeral storage will not have a readable `auth.json`; Mcode should treat the file as best-effort and surface a fallback.

### The catch: refresh tokens are single-use and rotate

- Refresh is `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, `refresh_token=<current>` (Codex: `manager.rs:208`, `1608-1616`; Hermes: `auth_codex.py:338-371`). The response may carry a new `refresh_token`; the old one is consumed.
- Reuse of a consumed refresh token is detected and revokes the whole token family: Hermes treats `invalid_grant`/`invalid_token`/`refresh_token_reused` as terminal (`auth.py:1770-1780`), and Codex maps `refresh_token_reused`/`expired`/`invalidated` to distinct failure reasons (`manager.rs:1660-1691`).
- This is exactly why Hermes does NOT share `~/.codex/auth.json` long-term. Its own words: tokens live in `~/.hermes/auth.json`, "NOT ~/.codex/ ... so one app's refresh-token rotation cannot invalidate the other's session" (`auth_codex.py:1-5`). It stores under `providers["openai-codex"].tokens` in its own file.

### Options this leaves Mcode

1. **Read-only reuse of the access token** (never refresh): simplest, but the access token expires on the JWT `exp` (checked with a 120 s skew, `auth_constants.py:95`) and dies whenever the CLI next refreshes.
2. **Import the token pair into Mcode's own store and refresh it independently**, the Hermes pattern. Works, but both apps then hold live refresh tokens off one family; whichever refreshes invalidates the other. Hermes papers over this by re-importing the CLI's freshly rotated pair when its own refresh is rejected (`_recover_codex_tokens_from_cli`). Mcode would need the same recovery loop, keyed on `invalid_grant`/`refresh_token_reused`.
3. **Run a separate OAuth session under the same client_id**, the fully independent path, and what Hermes recommends in its login UX ("a separate login is recommended"). Two free flows exist:
   - **Device code:** `POST https://auth.openai.com/api/accounts/deviceauth/usercode` `{client_id}` -> user opens `https://auth.openai.com/codex/device` and enters `user_code` -> poll `POST /api/accounts/deviceauth/token` `{device_auth_id, user_code}` (403/404 = pending) -> returns `authorization_code` + `code_verifier` -> `POST /oauth/token` `grant_type=authorization_code`, `redirect_uri={issuer}/deviceauth/callback`, `code_verifier` (`auth_codex.py:~744-840`; mirrored in `codex-rs/login/src/device_code_auth.rs`).
   - **Localhost browser flow (what `codex login` runs):** loopback listener on `127.0.0.1:1455` (fallback `1457`), `GET https://auth.openai.com/oauth/authorize` with `response_type=code`, the shared client_id, `redirect_uri=http://localhost:<port>/auth/callback`, `scope="openid profile email offline_access api.connectors.read api.connectors.invoke"`, PKCE S256, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<id>` (`codex-rs/login/src/server.rs:59-62,176,576-611`).

**Verdict for "tie to the CLI auth":** free for reading the access token; not free for holding the refresh token. The robust pattern is import-once + re-import-on-rotation (option 2) or Mcode's own device-code session (option 3). Sharing `~/.codex/auth.json` read/write with the CLI is the one design to avoid.

### Required request identity

OpenAI requires third-party harnesses to identify themselves. Hermes sends `originator: hermes-agent` and `User-Agent: HermesAgent/<version>` on the official endpoint, and deliberately keeps `originator: codex_cli_rs` only for custom proxies (`agent/codex_headers.py:30-66`). The Codex CLI sends its own `originator` and `User-Agent` plus `ChatGPT-Account-ID` (`codex-rs/model-provider/src/auth.rs:~106`). Mcode should mint its own `originator` value rather than impersonate `codex_cli_rs`.

---

## 2. Request shape (both reference clients agree)

`POST {base}/responses` where `base = https://chatgpt.com/backend-api/codex` (`auth_constants.py:70`; `codex-rs/model-provider-info/src/lib.rs:43`). `Accept: text/event-stream`, `Authorization: Bearer`, `ChatGPT-Account-ID`. Codex CLI adds routing/telemetry headers: `session-id`, `thread-id`, `x-client-request-id` (= thread id), `x-openai-subagent` (`codex-rs/codex-api/src/endpoint/responses.rs:60-95`; `requests/headers.rs:5-14`). Hermes adds `session_id` and `x-client-request-id` (`agent/transports/codex.py:271-280`).

Body fields (union of `ResponsesApiRequest`, `codex-rs/codex-api/src/common.rs:~250-285`, and Hermes `build_kwargs`, `agent/transports/codex.py:210-300`):

| Field | Value both clients send |
|---|---|
| `model` | Base slug (Hermes strips its synthetic `-900k` context-variant suffix before the wire) |
| `instructions` | System prompt, top-level field, not an input item |
| `input` | `ResponseItem[]`: `message` (role + `input_text`/`output_text` parts + optional `phase`/`id`), `function_call` (`call_id`, `name`, `arguments` string), `function_call_output` (`call_id`, `output`), `reasoning` (with `encrypted_content` replay), `custom_tool_call`, `local_shell_call`, server-side `*_call` items |
| `tools` | Sent every request; shapes below |
| `tool_choice` | `"auto"` |
| `parallel_tool_calls` | `true` |
| `reasoning` | `{"effort": <effort>, "summary": "auto"}` |
| `store` | **`false`, unconditionally, on every request** (`client.rs:913`; `transports/codex.py:219`) |
| `stream` | `true` |
| `include` | `["reasoning.encrypted_content"]` so `reasoning` items can be replayed across turns (`client.rs:886`; `transports/codex.py:85`) |
| `prompt_cache_key` | Content/scope-addressed cache key; Hermes bounds it to 64 chars (`transports/codex.py:229-236`) |
| `prompt_cache_retention` | Optional retention hint (Hermes) |
| `service_tier` | Optional (`"priority"` etc.) |
| `text` | Verbosity / output-schema controls (Codex CLI; `client.rs:~890-916`) |
| `client_metadata` | Turn/session metadata map (Codex CLI) |
| `context_management` | Native server-side compaction directive (Hermes `codex_responses_native` option) |
| `stream_options` | Reasoning-summary concurrency toggles |

Notably absent: `max_output_tokens` is **not** sent to the Codex backend by either client (Codex's request struct has no such field; Hermes only sets it on non-Codex routes, `transports/codex.py:281-282`). There is also no `conversation`/`thread` body parameter on this backend; conversation identity is carried by headers, not body.

Tool definitions on the wire (`codex-rs/tools/src/tool_spec.rs:19-58`):

- `{"type":"function","name","description","parameters","strict"}` for JSON-schema tools (Hermes converts its chat-completions schemas with `strict: false`, `codex_responses_adapter.py:311-321`).
- `{"type":"custom","name","description","format":{"type":"grammar","syntax":"lark","definition"}}` for freeform tools; `apply_patch` ships this way with a bundled Lark grammar (`codex-rs/core/src/tools/handlers/apply_patch_spec.rs:9-28`).
- `{"type":"web_search",...}` and other provider-executed tools run server-side and report back as `*_call` output items (`web_search_call`, `file_search_call`, `code_interpreter_call`, `local_shell_call`, `mcp_call`; `codex_responses_adapter.py:~74-96`).
- `{"type":"namespace",...}` and `{"type":"tool_search"}` exist in the Codex CLI's vocabulary.

---

## 3. Thread state: what is actually durable server-side

**Short answer: nothing durable survives on the server across processes on the HTTP path.** Both clients send `store: false` and replay the full `input` array every request. Continuity is a client-side concern built from three pieces:

1. **Full-history replay** of message/function_call/function_call_output items.
2. **Encrypted reasoning replay**: request `include: ["reasoning.encrypted_content"]`, keep the returned `reasoning` items, and echo them back next turn. Blobs are sealed to the issuing endpoint and model; replaying foreign ones is a 400 (`invalid_encrypted_content`), which is why Hermes stamps each blob with an issuer kind (`codex_responses_adapter.py:24-50`) and the Codex backend additionally rejects `id`s not starting with `msg` (`codex_responses_adapter.py:~339-355`).
3. **`prompt_cache_key`** for cache warmth, not correctness.

**`previous_response_id` exists only on the WebSocket transport.** The Codex CLI v2 path opens `wss://chatgpt.com/backend-api/codex/responses` and sends `response.create` messages carrying `previous_response_id` plus only the *incremental* input items since the last response (`codex-rs/core/src/client.rs:1880-1940`; `ResponseCreateWsRequest`, `common.rs:306-340`). "Access programs are authorized per response, including continuations, without replaying input" (`client.rs:~318-321`). A `generate=false` prewarm call establishes the connection and the first response id (`client.rs:16-22`). The WS connection itself caps at 60 minutes (`responses_websocket.rs:158-163`) and carries `x-codex-turn-state` for sticky routing plus `codex.rate_limits` events. The HTTP request struct has no `previous_response_id` field at all; whether the ChatGPT backend honors it over plain POST is unverified in either codebase.

So "durable server-side threads" decomposes as:

- **Within a turn/session over WS:** yes, server-side chaining via `previous_response_id` on a live connection, with incremental input only.
- **Across restarts:** no. Thread durability would be Mcode's own replay of stored items, same as today. The `session-id`/`thread-id`/`x-client-request-id` headers are routing and telemetry, not state references.

---

## 4. Streaming surface: SSE event inventory vs `AgentEvent`

Transport: raw SSE from `responses.create(stream=True)` / `POST /responses`. Both clients bypass the SDK's `responses.stream()` helper because it crashes when the terminal `response.output` is null (`agent/codex_runtime.py:522-525`).

### Events the Codex CLI consumes (`codex-rs/codex-api/src/sse/responses.rs:351-560`)

| SSE `type` | Payload of interest | CLI use |
|---|---|---|
| `response.created` | `response.id` | Track response id |
| `response.in_progress` | - | ignored (liveness) |
| `response.output_item.added` | `item` (message incl. `phase`, `function_call`, `reasoning`, `*_call`) | Optimistic item announce; Hermes records ordering and pending function calls |
| `response.output_item.done` | complete `item` | **Authoritative** item payload; tool calls, messages, reasoning settle here |
| `response.output_text.delta` | `delta` | Final-answer text streaming |
| `response.output_text.done` | `text` | ignored (item.done covers it) |
| `response.reasoning_summary_text.delta` | `delta`, `summary_index` | Reasoning summary streaming (thought narration) |
| `response.reasoning_summary_text.done` | `item_id`, `text`, `summary_index` | Reasoning summary finalization |
| `response.reasoning_summary_part.added` / `.done` | `summary_index` | Summary part boundaries |
| `response.reasoning_text.delta` | `delta`, `content_index` | Raw reasoning text streaming |
| `response.function_call_arguments.delta` / `.done` | `delta` / `arguments`, `item_id` | Streaming tool args (CLI ignores; Hermes accumulates for backends that omit `output_item.done`) |
| `response.custom_tool_call_input.delta` / `.done` | `delta`, `item_id`, `call_id` | Freeform (e.g. apply_patch) tool input streaming |
| `response.content_part.added` / `.done` | - | ignored |
| `response.metadata` / `codex.response.metadata` | turn-state token, model verification, moderation metadata | Sticky routing + policy metadata |
| `codex.rate_limits` | `plan_type`, `rate_limits.{primary,secondary}.{used_percent,window_minutes,reset_at}`, `credits`, `metered_limit_name` | Quota snapshots (WS transport; `rate_limits.rs:124-167`) |
| `response.completed` | `response.{id,status,usage,end_turn}` | Terminal frame; usage + finish |
| `response.incomplete` | `response.incomplete_details.reason` | Terminal; treated as error/length |
| `response.failed` | `response.error.{code,message}` | Error taxonomy: `context_window_exceeded`, quota/usage-not-included, `invalid_prompt`/`bio_policy`, `misalignment_policy_violation`, `rate_limit_exceeded`/`slow_down` (with Retry-After), server-overloaded, retryable |
| `error` | `code`, `message`, `param` | Stream-level error frame (Hermes raises it) |
| `response.refusal.delta` | `delta` | Refusal text (Hermes treats as answer text) |
| `responsesapi.websocket_timing` | - | WS timing telemetry, ignored |

HTTP responses additionally carry rate-limit headers parsed into snapshots: `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, the `x-codex-secondary-*` triple, `x-codex-limit-name`, and dynamic `x-<limit-id>-*` families (`rate_limits.rs:53-100`). `x-codex-turn-state` (sticky routing), `openai-model`, `x-request-id`, `x-models-etag`, `x-reasoning-included` also arrive on headers (`sse/responses.rs:30-90`).

### Message `phase` is the narration classifier

Message items carry `phase`: `commentary` = mid-turn narration (Hermes routes its deltas to a commentary callback, `codex_runtime.py:619-660`), `analysis` = internal reasoning (routed to reasoning deltas), unset/final = the answer. This is the direct equivalent of what Mcode's Codex adapter does with `item/reasoning/*` vs `item/agentMessage/*` today (`packages/providers/src/private/codex/codex-event-mapper.ts:47-82`).

### Mapping onto `AgentEvent` (contract at `packages/contracts/src/events/agent-event.ts:19-50`; turn-scoped set at `codex-provider.ts:131-137`)

| Responses surface | AgentEvent |
|---|---|
| `response.created` | `turnStarted` (response id as turn correlation) |
| `output_item.added` `message` phase=commentary + its `output_text.delta` | `textDelta` `isFinalResponse:false` (thought/narration segments) |
| `reasoning_summary_text.delta` / `reasoning_text.delta` | `textDelta` `isFinalResponse:false` |
| `output_text.delta` on final-answer message | `textDelta` `isFinalResponse:true` (Mcode can promote at completion like today) |
| `output_item.done` `message` | `message` / `assistantMessageBoundary` |
| `output_item.added`/`done` `function_call` + `function_call_arguments.delta` | `toolUse` + `toolInputDelta` |
| Mcode-executed tool completing | `toolResult` (ours, since we own the loop) |
| Server-side `*_call` items (web_search etc.) | `toolUse`/`toolResult` pair synthesized from added -> done |
| `reasoning_summary_part.*` | boundary hints for thought segments |
| `response.completed` `usage` | `contextEstimate` + `turnComplete` (`tokensIn`/`tokensOut`, `cacheReadTokens` from `usage`/`usage_metadata`) |
| `x-codex-*` rate-limit headers / `codex.rate_limits` | `quotaUpdate` (categories = primary/secondary windows + credits) |
| `response.failed` rate-limit codes + Retry-After | `rateLimited` / `apiRetry` |
| `response.failed` context-window code | `error` or trigger compaction |
| `response.incomplete` `reason` | `error`/`turnComplete` with stop reason |
| `error` frame | `error` |
| Native `context_management` compaction | `compacting`/`compactSummary` |

Coverage is good: everything Mcode narrates today has a wire equivalent, plus two upgrades the app-server does not expose as cleanly: per-item `phase` for narration classification and streaming `function_call_arguments`/`custom_tool_call_input` deltas.

---

## 5. Models, rate limits, plan constraints

- **Catalog:** `GET {base}/models` with Bearer + `ChatGPT-Account-Id`. **The account header is required**: without it the endpoint returns HTTP 200 with `{"models":[]}` (`codex_models.py:~96-150`). Entries carry `slug`, `priority`, `visibility` (hidden filtered), and `supported_in_api`, which describes the public API only; `gpt-5.3-codex-spark` is `supported_in_api:false` yet valid on this backend for Pro subscribers (`codex_models.py:12-42`). Hermes' curated fallback: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`. The Codex CLI also caches the catalog at `~/.codex/models_cache.json`, which Mcode can read (`codex_models.py:174-190`).
- **Plan gating:** the JWT carries `chatgpt_plan_type`; observed enum: `free`, `go`, `plus`, `pro`, `prolite`, `team`, `business`, `enterprise`, `edu` and self-serve variants (`codex-rs/protocol/src/account.rs:12-44`). Model availability (Spark, Astra-class) is account-entitled; the live catalog is the only safe source for gated models (Hermes drops undiscovered Astra slugs from cached catalogs, `codex_models.py:88-93`).
- **Rate limits:** two windows, primary (~5h) and secondary (weekly), reported as `used_percent`/`window_minutes`/`reset_at` via response headers (HTTP) or `codex.rate_limits` events (WS). Quota state can be probed off-stream at `GET {base}/wham/usage` for `/backend-api` hosts (`/api/codex/usage` otherwise), and banked resets live at `/wham/rate-limit-reset-credits` + `/consume` (`agent/account_usage.py:286-292`; `auth_codex.py:~538-600`). HTTP 429 on the token endpoint and on `/responses` is quota, not auth failure.
- **Reasoning effort vocabulary:** `("none","low","medium","high","xhigh")` for legacy Codex models; Astra-class adds `"max"`; `"minimal"`/`"ultra"` are rejected (`agent/reasoning_effort.py:33-36,95-103`).

---

## 6. What Hermes' tool loop sends per turn

Hermes owns the loop client-side; per model call (`agent/transports/codex.py:153-301` + `agent/codex_runtime.py`):

1. Convert the full chat history to `input` items: system prompt hoisted to `instructions`; user/assistant text as `message` items with `phase` preserved; tool results as `function_call_output {call_id, output}`; prior reasoning replayed as `reasoning` items with `encrypted_content` when issuer and model match (dropped otherwise, `codex_responses_adapter.py:24-50`).
2. Convert every function tool schema to `{"type":"function", ..., "strict":false}`; `tool_choice:"auto"`, `parallel_tool_calls:true`.
3. POST `/responses` with `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]`, `reasoning:{effort, summary:"auto"}`, `prompt_cache_key` scoped to the session/cache lineage.
4. Consume SSE: stream `output_text.delta` to the UI, commentary-phase text to narration, accumulate `function_call_arguments`, settle items on `output_item.done`, read usage/id/status off `response.completed`.
5. For each `function_call` item, execute the tool locally (Hermes' own terminal/file tools, not Codex's), append a `function_call_output` item, and loop until a text-only response. `store:false` means every iteration replays the whole grown input; `prompt_cache_key` keeps the prefix warm.
6. Compaction is either Hermes' own context compressor or the backend's native `context_management` directive (`codex_responses_native` config; `agent_init.py:1408-1426`).

Two backend quirks worth inheriting: the ChatGPT backend 400s on literal Harmony control tokens in input (Hermes rewrites `<|start|>`-style tokens to fullwidth bars, `codex_responses_adapter.py:56-62`), and `input[].id`/function names over 64 chars are a non-retryable 400 (`codex_responses_adapter.py:64-67`).

---

## 7. Per-request token-control levers (what "own the loop" buys)

Available on this backend: `reasoning.effort` (per-model vocabulary), `reasoning.summary:"auto"` (drives the summary stream that powers thought segments), `include` membership, `prompt_cache_key` + `prompt_cache_retention`, `service_tier`, `text` verbosity/output schema, `tool_choice`/`parallel_tool_calls`, the tool list itself, `instructions` construction, `context_management` for native compaction, and full control over which input items get replayed (i.e. Mcode's own compaction policy).

Not available: `max_output_tokens` (neither client sends it; the request schema used against this backend omits it), `store:true` server-side retention (both clients force `false`; whether the backend even accepts `true` is unverified), `conversation`/`thread` body params (not part of this endpoint's contract).

---

## 8. Unverifiable from source

- Whether `POST /responses` honors `previous_response_id` over HTTP (Codex CLI only uses it on WS; nothing forbids it, nothing proves it).
- Whether `store:true` is accepted on the ChatGPT backend and what it retains.
- Whether a bespoke `originator`/`User-Agent` pair for Mcode is acceptable to OpenAI's Cloudflare gate; Hermes' comment says identification is "required" but enforcement details are server-side.
- Exact plan-to-model entitlement matrix; only observable via the account-scoped `/models` catalog.
- WS endpoint stability/versioning for third-party use; the 60-minute cap and `codex.rate_limits` event names are observed in source but undocumented.

---

## 9. Primary sources

### Hermes (`.opensrc/repos/github.com/NousResearch/hermes-agent/main/`)

- `hermes_cli/auth.py:179`: `PROVIDER_REGISTRY` `openai-codex` entry (`oauth_external`, `inference_base_url=DEFAULT_CODEX_BASE_URL`); `1776-1780` OAuth flow registration with terminal refresh codes.
- `hermes_cli/auth_constants.py:70,88-95,135`: base URL, OAuth client_id, token URL, refresh skew, rate-limit code.
- `hermes_cli/auth_codex.py:1-5`: separate-store rationale; `185-197` CLI-token recovery; `338-371` refresh POST; `418-431` `~/.codex/auth.json` import; `538-600` quota probe + `/wham/usage` shape; `700-874` login UX + full device-code flow.
- `agent/codex_headers.py:15-75`: official-endpoint detection, `originator`/`User-Agent`/`ChatGPT-Account-ID` derivation.
- `agent/transports/codex.py:105-377`: `ResponsesApiTransport.build_kwargs`/`preflight_kwargs`; request field inventory; Codex-only headers.
- `agent/codex_runtime.py:522-790`: raw SSE consumption, event dispatch tables, commentary/analysis phase routing, terminal-frame semantics.
- `agent/codex_responses_adapter.py:24-321,426-489,983-1060`: issuer sealing, tool conversion, `function_call_output` replay, item normalization.
- `hermes_cli/codex_models.py:12-207`: model catalog endpoint, required account header, curated fallback, `-900k` variants.
- `agent/account_usage.py:286-292`: usage/reset-credits URL split (`/wham/` vs `/api/codex/`).
- `agent/reasoning_effort.py:33-103`: per-model effort vocabularies.

### Codex (`.opensrc/repos/github.com/openai/codex/main/`)

- `codex-rs/login/src/auth/manager.rs:208,1608-1691,1732`: token endpoint, refresh request, reuse-detection error codes, shared client_id.
- `codex-rs/login/src/auth/storage.rs:41-70,154-155`: `AuthDotJson` schema and file location.
- `codex-rs/login/src/token_data.rs:11-38,200-212`: `TokenData`, `id_token` as raw JWT, `chatgpt_account_id`/`chatgpt_plan_type` claims.
- `codex-rs/login/src/server.rs:59-62,176,576-611`: localhost:1455/1457 authorize flow.
- `codex-rs/login/src/device_code_auth.rs`: device-code flow.
- `codex-rs/config/src/types.rs:111-125`: `cli_auth_credentials_store` modes.
- `codex-rs/protocol/src/auth.rs:9-38`; `codex-rs/protocol/src/account.rs:12-44`: `AuthMode`, `PlanType`.
- `codex-rs/model-provider-info/src/lib.rs:43`: `CHATGPT_CODEX_BASE_URL`.
- `codex-rs/codex-api/src/common.rs:250-340`: `ResponsesApiRequest`/`ResponseCreateWsRequest` fields.
- `codex-rs/codex-api/src/endpoint/responses.rs:30-159`: POST `/responses`, SSE accept, session/thread/subagent headers.
- `codex-rs/codex-api/src/sse/responses.rs:30-90,351-560`: header-derived events (`x-codex-turn-state`, rate limits, `openai-model`) and the full `response.*` dispatch incl. error taxonomy.
- `codex-rs/codex-api/src/endpoint/responses_websocket.rs:158-163,740-790`: WS `previous_response_id` incremental sends, 60-min cap, `codex.rate_limits`.
- `codex-rs/codex-api/src/rate_limits.rs:22-180`: header and event quota schemas.
- `codex-rs/core/src/client.rs:16-22,880-916,1880-1940`: `store:false`, `include`, WS prewarm + incremental requests.
- `codex-rs/tools/src/tool_spec.rs:19-58`; `codex-rs/core/src/tools/handlers/apply_patch_spec.rs:9-28`: tool wire shapes incl. Lark-grammar `apply_patch`.

### Mcode (this worktree)

- `packages/contracts/src/events/agent-event.ts:19-50`: `AgentEventType` inventory.
- `packages/providers/src/private/codex/codex-provider.ts:131-137`: `TURN_SCOPED_EVENT_TYPES`.
- `packages/providers/src/private/codex/codex-event-mapper.ts:47-82`: current reasoning/agentMessage -> `textDelta` classification.

---

**Bottom line:** `codex login`'s `~/.codex/auth.json` tokens can drive `backend-api/codex` today with the shared public client_id; the only hard constraint is refresh-token rotation, which pushes the design toward import-and-recover (Hermes' pattern) or Mcode's own device-code session. Server-side thread state is per-connection over the WebSocket transport (`previous_response_id` + incremental input); on HTTP, continuity is client replay + `encrypted_content` reasoning, which is exactly the replay model Mcode already owns. The SSE surface covers every `AgentEvent` Mcode emits and adds cleaner narration classification via message `phase` plus streaming tool-argument deltas.
