# Codex `mcp-server` as a sessioned transport  -  Research Notes

**Status:** Research only  -  no implementation changes.
**Ticket:** Mzeey-Empire/mcode#1712  -  "codex mcp-server: surface, thread continuity, events, approvals".
**Primary source:** `openai/codex` at commit `03467026` (last commit touching `codex-rs/mcp-server` before removal). Local `.opensrc` cache tracks `main` (fetched 2026-09-16), which is post-removal; pre-removal files were read via `raw.githubusercontent.com` at that commit.

---

## 0. Headline: `codex mcp-server` is removed from current `main`

- The subcommand was **deprecated** with a stderr warning on 2026-08-20 (`Warn when launching the deprecated MCP server`, PR openai/codex#39657) and **deleted** on 2026-09-05 (`Remove the deprecated codex mcp-server command`, PR openai/codex#42993, commit `531f3836`), which removed the `codex-mcp-server` crate, its tests, and the interface doc `codex-rs/docs/codex_mcp_interface.md`.
- At `03467026`, `codex mcp-server` still ran but printed `warning: 'codex mcp-server' is deprecated and will be removed in a future release.` before starting (`codex-rs/cli/src/main.rs`, `Subcommand::McpServer` arm ~lines 1187-1199; subcommand def ~lines 161, 316-320).
- The successor surface is `codex app-server` (`Subcommand::AppServer`, "[experimental] Run the app server or related tooling"): an MCP-flavored JSON-RPC 2.0 protocol over stdio with typed v2 RPCs (`thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `account/*`, `config/*`, `model/list`), `codex/event/*` stream notifications, and server-to-client approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). See `codex-rs/app-server-protocol/src/protocol/common.rs` (notification/RPC method constants ~lines 1751-1976) and `codex-rs/app-server/README.md` on `main`. The deleted `codex-rs/docs/codex_mcp_interface.md` already documented this v2 surface under the "Codex MCP Server Interface" name.
- Mcode's Codex adapter already speaks app-server: `packages/providers/src/private/codex/codex-app-server.ts` spawns `codex app-server`, runs `initialize -> initialized -> thread/resume | thread/start`, and consumes server notifications.
- Released binaries may still ship `codex mcp-server`: removal only landed on `main` 2026-09-05. Anything built against it pins an older codex release and inherits deprecation risk.

---

## 1. Tool surface (`tools/list`)

The server is a line-delimited JSON-RPC 2.0 MCP server over stdio (`codex-rs/mcp-server/src/lib.rs`: stdin reader -> `MessageProcessor` -> stdout writer). `initialize` returns `serverInfo { name: "codex-mcp-server", title: "Codex", user_agent }` and capabilities `tools` + `toolListChanged` (`message_processor.rs` `handle_initialize`, ~lines 231-302). Exactly two tools are registered (`handle_list_tools`, ~lines 337-349):

### `codex`  -  start a session

Defined in `codex_tool_config.rs` (`CodexToolCallParam`, `create_tool_for_codex_tool_call_param`; the JSON schema is pinned by test `verify_codex_tool_json_schema`). Input (kebab-case, `deny_unknown_fields`):

| Field | Type | Notes |
|---|---|---|
| `prompt` | string, **required** | initial user prompt |
| `model` | string | e.g. `gpt-5.2`, `gpt-5.2-codex` |
| `cwd` | string | resolved against server process cwd if relative |
| `approval-policy` | enum | `on-request` \| `never` only (no `untrusted`/`on-failure`) |
| `sandbox` | enum | `read-only` \| `workspace-write` \| `danger-full-access` |
| `config` | object | arbitrary `config.toml` key overrides merged via `ConfigBuilder::cli_overrides` |
| `base-instructions` | string | replaces default system instructions |
| `developer-instructions` | string | injected as developer message |
| `compact-prompt` | string | compaction prompt override |

Output schema (both tools): `{ "threadId": string, "content": string }`. Returned as `structuredContent` **and** mirrored as a text content block, because "some MCP clients ignore `content` when `structuredContent` is present" (`codex_tool_runner.rs` `create_call_tool_result_with_thread_id`, ~lines 33-47).

### `codex-reply`  -  continue a session

`CodexToolCallReplyParam` (`codex_tool_config.rs`): `threadId` (string, camelCase; deprecated `conversationId` still accepted as fallback), `prompt` (required). `threadId` parses as a UUID (`ThreadId::from_string`, `codex-rs/protocol/src/thread_id.rs`  -  UUIDv7).

No other tools. `resources/*`, `prompts/*`, `completion/complete`, `logging/setLevel`, `tasks/*` are stubbed or return `METHOD_NOT_FOUND` (`message_processor.rs` `process_request`).

---

## 2. What streams back mid-run

This is the strong part of the surface. Every Codex core `Event` produced during the turn is forwarded verbatim as a **`codex/event` notification** (`outgoing_message.rs` `send_event_as_notification`, ~lines 111-133):

```json
{"method": "codex/event", "params": {"_meta": {"requestId": "...", "threadId": "..."}, "id": "...", "msg": {"type": "..."}}}
```

- `_meta.requestId` correlates to the originating `tools/call`; `_meta.threadId` to the thread (`OutgoingNotificationMeta`, `outgoing_message.rs` ~lines 215-223; wire shape verified by `test_send_event_as_notification_with_meta*` tests).
- The runner loop calls `send_event_as_notification` for **every** event before dispatching on it (`codex_tool_runner.rs` `run_codex_tool_session_inner`, ~lines 155-166). The giant catch-all arm explicitly notes all listed `EventMsg` variants "have already been dispatched as notifications". So the caller sees the full narration-grade stream: `AgentMessage`/`AgentMessageContentDelta`, `AgentReasoning*`/`ReasoningContentDelta`, `ExecCommandBegin`/`ExecCommandOutputDelta`/`ExecCommandEnd`, `PatchApplyBegin`/`PatchApplyEnd`, `McpToolCallBegin`/`McpToolCallEnd`, `WebSearchBegin/End`, `ItemStarted`/`ItemCompleted`, `TurnStarted`, `PlanUpdate`, `TurnDiff`, `TokenCount`, `Collab*`/sub-agent events, etc.
- A `SessionConfigured` event is sent as a notification immediately after thread creation (before the first turn event), carrying `rollout_path`, `model`, `approval_policy`, `cwd` (`codex_tool_runner.rs` ~lines 82-95).
- The `tools/call` **response** itself is deferred until `TurnComplete` (result = `last_agent_message`) or `EventMsg::Error`/`Err(next_event)` (`is_error: true`). So the result is final-message-only; everything mid-flight rides the notification channel.
- Extension-subsystem warnings are also routed to the owning request as `Warning` `codex/event` notifications via `ActiveTurnRegistry` (`extension_event_sink.rs`, `active_turn_registry.rs`).

Cancellation: client `notifications/cancelled` -> lookup `requestId -> threadId` in `ActiveTurnRegistry` -> `Op::Interrupt` on the thread (`message_processor.rs` `handle_cancelled_notification`, ~lines 535-572).

---

## 3. Approval / permission semantics

- `codex` accepts `approval-policy` (`on-request`|`never`) and `sandbox` (`read-only`|`workspace-write`|`danger-full-access`) per call, plus freeform `config` overrides  -  so the caller fully controls the policy envelope (`codex_tool_config.rs` `into_config`).
- Mid-run pause-for-decision works via **server-to-client `elicitation/create` JSON-RPC requests**:
  - `EventMsg::ExecApprovalRequest` -> `handle_exec_approval_request` (`exec_approval.rs`): params carry `message` ("Allow Codex to run `<cmd>` in `<cwd>`?"), an empty `requestedSchema`, `threadId`, `codex_elicitation: "exec-approval"`, `codex_mcp_tool_call_id`, `codex_event_id`, `codex_call_id`, `codex_command`, `codex_cwd`, `codex_parsed_cmd`. The client response `{decision: ReviewDecision}` is submitted as `Op::ExecApproval`.
  - `EventMsg::ApplyPatchApprovalRequest` -> `handle_patch_approval_request` (`patch_approval.rs`): same shape with `codex_elicitation: "patch-approval"`, `codex_reason`, `codex_grant_root`, `codex_changes`. Response -> `Op::PatchApproval`.
- Caveats (from source):
  - `ExecApprovalResponse`/`PatchApprovalResponse` are `{decision}` only  -  a TODO notes this does **not** conform to the spec'd `ElicitResult` (`action`/`content`) shape (`exec_approval.rs` comment ~lines 36-40). Clients must handle the non-standard shape.
  - A client **error** response to `elicitation/create` is only logged (`process_error`, `message_processor.rs` ~line 227)  -  the pending oneshot is never resolved, so the approval (and turn) hangs indefinitely. Only a well-formed result resolves it.
  - Undeserializable responses deny conservatively.
  - `EventMsg::ElicitationRequest` from core is dropped with a TODO (`codex_tool_runner.rs`).
  - A client that never advertises/answers elicitation leaves the turn parked; `approval-policy: never` avoids the path entirely.

---

## 4. Thread semantics  -  the dealbreaker for cross-process continuity

- `threadId` is a UUIDv7 generated per `codex` call and is **durable on disk**: `MessageProcessor` wires `thread_store_from_config` + `state_db` into `ThreadManager` (`message_processor.rs` ~lines 99-115), so rollout/history persists under `CODEX_HOME` like any Codex session.
- But `codex-reply` resolves threads via `thread_manager.get_thread(thread_id)` (`message_processor.rs` ~line 477), which is an **in-memory map lookup only**  -  `ThreadManagerState::get_thread` reads `self.threads` and returns `ThreadNotFound` for anything not live in the process (`codex-rs/core/src/thread_manager.rs` ~lines 1491-1497). The resume APIs (`resume_thread_from_rollout`, `resume_thread_with_history`, ~lines 1046-1152) exist but are never called by the mcp-server.
- Net effect: `threadId` survives process death as a stored thread, but a **fresh `codex mcp-server` cannot continue it**  -  `codex-reply` returns an `is_error` result `"Session not found for thread_id: ..."`. Thread continuity is per-process.
- Within a process the surface is real: `codex-reply` uses `thread.start_or_steer_turn(...)` (`codex_tool_runner.rs` ~line 128), so a reply can **steer a turn already in flight** (`TurnInputSubmission::Steered`), not just queue after it.
- MCP-started threads are tagged `SessionSource::Mcp` (`message_processor.rs` ~line 104).
- Edge case worth noting: two concurrent `codex-reply` calls on one thread each enter their own `thread.next_event()` loop; events would split between the two consumers (no per-request event demux beyond the registry).

---

## 5. Token-usage reporting

- `EventMsg::TokenCount` streams as a `codex/event` notification like everything else. Payload: `TokenCountEvent { info: Option<TokenUsageInfo>, rate_limits: Option<RateLimitSnapshot> }` (`codex-rs/protocol/src/protocol.rs` ~lines 2318-2338 at `03467026`; same shape on `main` ~lines 2335+).
- **Not** included in the `tools/call` result  -  callers wanting usage must accumulate `token_count` notifications and take the last one per turn. This matches how the TUI consumes it but is a gap versus a "usage in final result" expectation.

---

## 6. Process lifecycle & concurrency

- One `codex mcp-server` process = one stdio JSON-RPC endpoint hosting **many threads** via a shared `ThreadManager`. Every `tools/call` spawns an independent Tokio task (`message_processor.rs` ~lines 414-425, 493-508); there is **no explicit concurrency cap**  -  the only bound is the 128-message inbound channel and system resources.
- Config is loaded once at startup from `CODEX_HOME` + CLI `-c` overrides; each `codex` call then applies its own per-call overrides on top (`lib.rs` `run_main`, `codex_tool_config.rs` `into_config`).
- Shutdown: stdin EOF drops the incoming channel -> processor drains -> stdout task exits (`lib.rs` ~lines 155-170). No graceful per-thread shutdown RPC.
- `workload identity` auth is rejected at startup (`lib.rs` `reject_workload_identity`).

---

## 7. Hermes usage (NousResearch/hermes-agent)

- **Preset:** `hermes_cli/mcp_config.py` line 183: `_MCP_PRESETS = {"codex": {"command": "codex", "args": ["mcp-server"]}}`. `hermes mcp add <name> --preset codex` writes `mcp_servers.<name> = {command: "codex", args: ["mcp-server"]}` (`_apply_mcp_preset`, ~lines 363-385; `cmd_mcp_add`, ~lines 590-640). Documented in `website/docs/user-guide/features/mcp.md` ("Built-in presets" table ~line 446).
- **Tool naming:** Hermes registers MCP tools as `mcp__<server>__<tool>` with non-`[A-Za-z0-9_]` chars (hyphens included) mapped to `_` (`tools/mcp_tool_schema.py` `sanitize_mcp_name_component`/`mcp_prefixed_tool_name`, ~lines 137-175). So codex's tools appear to the model as **`mcp__codex__codex`** and **`mcp__codex__codex_reply`**. (The mcp.md docs still show the older single-underscore `mcp_<server>_<tool>` examples  -  stale relative to the code.)
- **Callers:** nothing in the repo hardcodes `mcp__codex__*` or `codex-reply`  -  the model selects the tools during normal reasoning (per docs). The preset is a user-facing way to give Hermes a delegate-to-Codex tool, not a wired subsystem.
- Notably, Hermes' *own* Codex provider path does **not** use `mcp-server`: `agent/codex_runtime.py` drives "one `codex app-server` subprocess turn" via `agent/transports/codex_app_server.py` / `codex_app_server_session.py` / `codex_event_projector.py`  -  i.e. Hermes already treats app-server as the real integration surface, same as Mcode.

---

## 8. Verdict

`codex mcp-server` *was* nearly sufficient as a sessioned transport for Mcode: a two-tool surface (`codex`/`codex-reply`) with a UUID `threadId`, the **entire core `EventMsg` stream** mirrored as `codex/event` notifications (narration-grade, better than exec `--json`), mid-run approvals via server-to-client `elicitation/create`, mid-turn steering via `codex-reply`, per-call sandbox/approval config, token counts via notifications, and one process hosting many concurrent threads.

But it is a dead end:

1. **Removed upstream** (deprecated 2026-08-20, deleted 2026-09-05 from `main`; PR #42993). Only usable on pinned older releases.
2. **No cross-process resume**  -  `codex-reply` hits an in-memory map; restart the server and every threadId is "Session not found" despite the rollout being on disk.
3. **Approval fragility**  -  non-spec elicitation shape; a JSON-RPC error response hangs the turn forever.
4. **No token usage in results**  -  notification-only.

The successor is `codex app-server` (experimental): a typed JSON-RPC surface with `thread/start|resume|fork|read|list`, `turn/start|steer|interrupt`, `codex/event/*` + `item/*` notifications, and `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` server-to-client requests  -  everything the MCP surface had, plus durable resume and richer approvals. Mcode's Codex adapter already uses it (`packages/providers/src/private/codex/codex-app-server.ts`), as does Hermes' provider path. **Recommendation: do not invest in `codex mcp-server`; keep/extend the app-server adapter.**

---

## Sources

| Claim | Source |
|---|---|
| Removal PR, date, scope | openai/codex PR #42993 (commit `531f3836`, merged 2026-09-05) |
| Deprecation warning | openai/codex PR #39657 (commit `5e3a6fe4`, 2026-08-20); `codex-rs/cli/src/main.rs` `McpServer` arm @ `03467026` |
| Tool schemas, `codex`/`codex-reply` params + outputSchema | `codex-rs/mcp-server/src/codex_tool_config.rs` @ `03467026` (incl. `verify_codex_tool_json_schema` test) |
| `tools/call` dispatch, deferred response, cancel->Interrupt | `codex-rs/mcp-server/src/message_processor.rs`, `codex-rs/mcp-server/src/codex_tool_runner.rs` @ `03467026` |
| `codex/event` notification wire shape, `_meta.requestId/threadId` | `codex-rs/mcp-server/src/outgoing_message.rs` @ `03467026` (+ tests) |
| Elicitation-based approvals, correlation params, deny-on-parse-failure | `codex-rs/mcp-server/src/exec_approval.rs`, `patch_approval.rs` @ `03467026` |
| In-memory-only `get_thread`, unused resume APIs | `codex-rs/core/src/thread_manager.rs` @ `03467026` (~lines 1491-1497, 1046-1152) |
| `ThreadId` = UUIDv7 | `codex-rs/protocol/src/thread_id.rs` @ `03467026` |
| `TokenCountEvent` shape | `codex-rs/protocol/src/protocol.rs` @ `03467026` (~line 2318) |
| One process / many threads / spawn-per-call / EOF shutdown | `codex-rs/mcp-server/src/lib.rs`, `message_processor.rs` @ `03467026` |
| Deleted interface doc describing v2/app-server surface | `codex-rs/docs/codex_mcp_interface.md` @ `03467026` |
| app-server v2 RPC + notification + approval method names | `codex-rs/app-server-protocol/src/protocol/common.rs` on `main` (.opensrc cache) |
| Hermes preset | `NousResearch/hermes-agent` `hermes_cli/mcp_config.py:183` |
| Hermes `mcp__server__tool` naming + sanitization | `NousResearch/hermes-agent` `tools/mcp_tool_schema.py` (~lines 137-175) |
| Hermes preset docs | `NousResearch/hermes-agent` `website/docs/user-guide/features/mcp.md` (~line 446) |
| Hermes codex provider transport = app-server | `NousResearch/hermes-agent` `agent/codex_runtime.py`, `agent/transports/codex_app_server*.py` |
| Mcode already on app-server | `packages/providers/src/private/codex/codex-app-server.ts` |
