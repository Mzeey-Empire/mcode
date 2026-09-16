# Own-the-Loop Scope: the Tool Surface We Would Rebuild

**Status:** Research only; no implementation changes.
**Ticket:** GitHub issue #1715 (parent #1710; blocks the transport decision in #1719).
**Question:** If Mcode owned the tool loop (Responses API path), what exactly would we have to build, port, or drop?
**Sources read:** `openai/codex` (codex-rs) at `.opensrc/repos/github.com/openai/codex/main/`, `NousResearch/hermes-agent` at `.opensrc/repos/github.com/NousResearch/hermes-agent/main/`, and the Mcode Codex adapter in this worktree. Sibling findings assumed: #1714 (transport/auth/replay; `docs/research/codex-responses-api-direct.md` on `research/codex-responses`), #1713 (`codex exec --json` parity), #1712 (`codex mcp-server` surface).

---

## 1. What Mcode's Codex adapter actually relies on today

Everything below is what the own-the-loop build replaces. App-server RPCs Mcode calls (`packages/providers/src/private/codex/codex-app-server.ts`):

- `thread/start`, `thread/resume`, `thread/read`, `thread/items/list` (lines 1198-1208, 1568), `turn/start` (1180), `turn/interrupt` (1125, 1365, 1427), `thread/goal/set|get|clear` (1244-1273), `config/read` (1352), `model/list` (1301), `skills/list` (1320), `plugin/list|read` (1335-1343), `account/rateLimits/read` (877).
- Server-initiated requests routed through `routeCodexServerRequest` (codex-app-server.ts:316-376): the five approval methods in `CODEX_APPROVAL_METHODS` (`codex-permission-mapper.ts:16-23`): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`, `execCommandApproval`. Auto-approve when `approvalPolicy === "never"` (333-351); safe-deny otherwise. **`item/tool/requestUserInput` and `item/tool/call` (dynamic tools) are not handled today**; they fall through to the deny-shaped fallback, so Mcode sessions effectively do not use plan-mode elicitation or client-registered dynamic tools.

Item types Mcode narrates (`codex-event-mapper.ts`):

- Tool rows: `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `function_call` (`TOOL_LIKE_ITEM_TYPES`, lines 89-93; builders at 1369-1376). `webSearch` is in the set but suppressed at both start and completion (690, 1913, 54).
- Silent on completion: `webSearch`, `plan`, `imageView`, `imageGeneration`, `contextCompaction`, `enteredReviewMode`, `exitedReviewMode` (`SILENT_ITEM_TYPES`, 53-57). Plan updates arrive separately via `turn/plan/updated` and are re-emitted as synthetic `update_plan` tool rows (`planUpdateSeq`, ~line 140).
- Text/reasoning: `reasoning`, `agentMessage`, `message`; `userMessage` for echo; `subAgentActivity` + `collabAgentToolCall` + receiver-thread notifications for child-agent nesting (39 references; the largest single block of mapper complexity).

Provider configuration Mcode passes (`codex-provider.ts`):

- `permissionMode` mapping: `full` -> `sandbox: "danger-full-access"` + `approvalPolicy: "never"`; `supervised` -> `sandbox: "workspace-write"` + `approvalPolicy: "on-request"` (lines 396-397, 1064).
- `approvalReviewMode: "automatic"` -> `approvalsReviewer: "auto_review"` on `turn/start` (line 1101): Codex's guardian/auto-review subagent screens approval requests. This is the "middle ground" the ticket refers to; today we rent it.
- Injected MCP servers via config overrides (1346-1353): `mcode_internal_thread_control` (`thread_*` tools: thread_target_list/create_batch/search/get/send/stop/wait plus workspace_search/worktree_list, served by `apps/server/src/features/thread-control/authority/thread-control-mcp-runtime.ts:16`; prompt contract in `packages/thread-orchestration/src/mcode-instructions.ts:55-57`) and `mcode-browser` for browser automation grants.
- Capabilities advertised: `goals`, `clean-fork`, `approval-review` (123-133); turn-scoped events include `compacting`/`compactSummary` (138).
- Turn inputs: `localImage` parts for image attachments (`codex-input-mapper.ts:143-145`), `skill` parts for native Codex skills, `mention` parts that become agent URIs driving native collab sub-agents.

## 2. The tool surface Codex executes (codex-rs inventory)

Tool registration lives in `codex-rs/core/src/tools/spec_plan.rs`; wire shapes in `codex-rs/tools/src/tool_spec.rs:19-58` (`function`, `namespace`, `tool_search`, `web_search`, `custom`/freeform).

**What Mcode sessions exercise:**

| Tool | Wire shape | Execution | Size in codex-rs |
|---|---|---|---|
| `exec_command` + `write_stdin` (unified_exec, the default `shell_type`) | function | PTY shell exec in the turn environment; `yield_time_ms` returns a session id, `write_stdin` continues it; `max_output_tokens` budget; `sandbox_permissions`/`justification`/`prefix_rule` approval params embedded in the schema (`shell_spec.rs:23-114, 117-131, 232-268`) | handler 571 + 145 LoC; runtime `tools/runtimes/unified_exec.rs` 964 + `exec.rs` 1274; sandboxed via exec-server |
| `apply_patch` | `custom` freeform tool with bundled Lark grammar (`apply_patch_spec.rs:9-28`) | `apply-patch` crate: parser + streaming parser + file_update + invocation ≈ 5.1k LoC | M-L to port faithfully |
| `update_plan` | function (`plan_spec.rs:7-53`) | Records plan items; emits `turn/plan/updated`; handler is 112 LoC | trivial |
| `view_image` | function | Reads a local image into the context as an `input_image` part (512 LoC incl. detail/budget options) | S |
| `web_search` | hosted `{"type":"web_search"}` (`hosted_spec.rs:14-49`) | **Server-side**; model emits `web_search_call` items | free: declare and narrate |
| MCP tools | `mcp__server__tool` / namespaced functions | Full MCP client: `codex-mcp` connection manager + `rmcp` client; `core/src/mcp_tool_call.rs` (~876+ LoC) incl. elicitation, plus `list_mcp_resources`/`read_mcp_resource`/`list_mcp_resource_templates` tools | L in Rust; M in TS via `@modelcontextprotocol/sdk` (already a dep of `apps/server`) |
| `request_user_input` (+ async variant) | function → `item/tool/requestUserInput` serverRequest | Elicitation card (app-server-protocol `common.rs:1764`); ~470 LoC | S-M |
| `request_permissions` | function → `item/permissions/requestApproval` | Model-initiated escalation; 213 LoC | S |
| Collab/sub-agents | `spawn_agent`, `send_input`, `wait`, `resume_agent`, `close_agent` (v1) + v2 namespace (`list_agents`, `interrupt_agent`, `send_message`, `followup_task`) | Child threads with own turns; handlers ~1.1k LoC + 878 LoC spec | L |
| Goal tools | `create_goal`/`get_goal`/`update_goal` (extension tools, `extension_tools.rs:72-90`) | `ext/goal` ≈ 3.3k LoC: state + **steering** (auto-continues turns until objective met) + token-budget accounting | L |
| Compaction | not a model tool; auto task | `compact.rs` (~830 LoC) runs a summarization turn then rebuilds context; `compact_remote_v2.rs` (1268 LoC) is the remote variant. Related model tools: `new_context`, `get_context_remaining` | M own-loop minimal (summarize + truncate replay) |
| Misc handlers | `sleep`, `curr_time`, `send_message_to_user_async`, `wait_for_environment`, `tool_search` (deferred tool loading), `request_plugin_install`, `list_available_plugins_to_install`, dynamic (client-registered) tools, code_mode | each S individually | mostly drop/defer |

**Not on the tool wire but part of the loop:**

- `instructions` (system prompt): per-model files `core/gpt_5_codex_prompt.md` etc.; `<environment_context>` injected into the first user message (`protocol.rs:120-121`); `AGENTS.md` reading; skill catalog prompt.
- Approvals: `AskForApproval` = `untrusted` / `on-request` / `granular` / `never` (`protocol.rs:986-1014`); `SandboxPolicy` = `danger-full-access` / `read-only` / `workspace-write`(+writable_roots, network) / `external-sandbox` (`protocol.rs:1072-1117`).
- `execpolicy` (~2k LoC): rule DSL classifying commands into allow/prompt/forbidden; the auto-approval engine.
- OS sandbox: macOS seatbelt (`sandboxing/src/seatbelt.rs` 1088 LoC + bundled `.sbpl` profiles), Linux landlock+bwrap (`linux-sandbox/` crate), Windows restricted-token/ACL sandbox (`core/src/windows_sandbox.rs` 436 LoC + `exec-server` fs/process sandbox). The full exec-server sandbox daemon is the deep end of this surface.
- `approvalsReviewer: auto_review`: a guardian subagent that gathers context and decides approval requests (app-server-protocol `v2/shared.rs:236-260`).

## 3. Hermes' own tool loop: the minimal-viable reference

Hermes runs `api_mode == "codex_responses"` and implements **zero codex-native tools**. Per turn (`agent/transports/codex.py:153-301`, `agent/codex_runtime.py`, `agent/codex_responses_adapter.py`):

- It converts *its own generic toolset* (terminal, `file`/`patch`, browser, delegate, etc.) into `{"type":"function", ..., "strict":false}` tools (`_responses_tools`, `codex_responses_adapter.py:311-321`). No `update_plan`, no `view_image`, no codex `exec_command`.
- File edits go through a `patch` function tool that accepts the V4A `*** Begin Patch` dialect as a plain JSON string arg, advertised only to OpenAI-family models (`tools/file_tools.py:1128-1207`, parser `tools/patch_parser.py` 418 LoC). This dodges the freeform-custom-tool + Lark grammar entirely.
- Hosted tools pass through by type alone (`web_search` etc., `_RESPONSES_BUILTIN_TOOL_TYPES`, lines 79-87); server-side `*_call` items are just output items (89-96).
- The loop itself is provider-agnostic: `run_tool_round` validates/caps/dedupes `function_call` items, executes them in order, persists the tool-call block *before* side effects for crash-safe resume, appends `function_call_output`, re-POSTs (`agent/turn_tool_round.py:1-55`).
- Approvals are Hermes' own layer, not Codex's: dangerous-command detection + permanent allowlist + human/gateway/LLM-smart verdicts (`tools/approval*.py`). Provider approval mechanisms are bypassed entirely.

**Read:** the minimal viable own-loop is *transport + your own toolset*. Codex tool-name fidelity (`exec_command`, `apply_patch`) is optional surface polish, not a requirement; what the model needs is a competent shell + patch + plan surface and a prompt that names them.

## 4. Scoped checklist

Sizes: S is days, M is one to two weeks, L is multi-week or subsystem-scale. "v1" means behind the own-the-loop flag.

### Must-have for flagged v1

| Capability | Call | Size | Notes |
|---|---|---|---|
| Tool loop core: dispatch `function_call`/`custom_tool_call` items, execute, append `function_call_output`, re-POST until text-only; `parallel_tool_calls` | v1 | **M** | The actual "own the loop". Replaces the app-server's role entirely. Persist-before-execute (Hermes invariant) maps onto Mcode's existing event/thread persistence. |
| Shell exec tool | v1 | **S** | Spawn in thread cwd, capture stdout/stderr, timeout, exit code, bounded output buffer (Mcode already has `BoundedToolOutputBuffer`). PTY + `write_stdin` continuation deferred. |
| File-edit tool (apply_patch surface) | v1 | **S** | Hermes' cheaper path: a `patch` function tool taking V4A `*** Begin Patch` text as a JSON arg; a V4A parser is ~400 LoC (Hermes') vs ~5k for codex's freeform+grammar version. Alternative (port the `custom`+Lark grammar exactly) is M and buys marginal fidelity. Start with the function-tool form. |
| `update_plan` | v1 | **S** | Trivial schema; Mcode already renders plan rows from `turn/plan/updated`. |
| `view_image` / image attachments | v1 | **S** | Local path -> `input_image` part in next request input. Attachments already flow as `localImage` today; same mechanism. |
| `web_search` | v1 | **S** | Declare `{"type":"web_search"}`; narrate `web_search_call` output items. Hosted, server-side. |
| Approval plumbing (re-owned) | v1 | **M** | Reuse Mcode's existing `permission_request`/`resolvePermission` contract (`codex-permission-mapper.ts` shows the shape). New work: decide *when* to ask. A command classifier (read-only/safe list runs; writes outside workspace, `require_escalated`, destructive patterns produce a card) plus file-edit approval for out-of-workspace paths. This replaces `routeCodexServerRequest` + `AskForApproval` + `execpolicy`. Keep the `sandbox_permissions`/`justification` params in the exec schema so the model still self-describes escalation. |
| Minimal sandbox semantics | v1 | **S** | Policy-level, not OS-level: file tools validate paths against workspace + writable roots; exec defaults to workspace cwd; anything beyond that requires approval. Honest equivalent of "workspace-write by policy". |
| System prompt + environment context | v1 | **S** | Port `gpt_*_codex_prompt.md` + `<environment_context>` + AGENTS.md/skills injection. Mcode already composes `developer_instructions` today (codex-app-server.ts:265-296). |
| Item replay + persistence | v1 | **M** | Store request items per thread (messages, calls, outputs, `reasoning` with `encrypted_content`); replay as `input`. Shared with #1714's transport verdict; required for the loop to resume. |
| Compaction | v1 | **M** | Minimal: track token usage from `response.completed`; on threshold or `context_window_exceeded`, run a summarize call and truncate replay. Possible S shortcut: the backend's native `context_management` directive (unverified, see section 5). Emits our own `compacting`/`compactSummary` events, which already exist in the contract. |
| Interrupt | v1 | **S** | Abort in-flight SSE + terminate running exec children; emit interrupted turn state. Replaces `turn/interrupt`. |
| Usage + rate limits | v1 | **S** | `usage` off `response.completed`; `x-codex-*` headers / `/wham/usage` (per #1714). |
| Narration emission | v1 | **S** | Emit `toolUse`/`toolResult`/`textDelta`/plan events directly from our executor; most of `codex-event-mapper.ts` (2284 LoC, mostly collab-child tracking) deletes. |
| Internal thread-control + browser tools | v1 | **S** | `mcode_internal_thread_control` and `mcode-browser` become plain function tools Mcode executes itself; the MCP round-trip disappears. Simpler than today. |
| Error/retry taxonomy | v1 | **M** | `response.failed` codes: rate_limit (+Retry-After), context_window_exceeded (triggers compaction), overloaded, invalid_prompt. Maps to `rateLimited`/`apiRetry`/`error`. |
| Model/effort/serviceTier per turn | v1 | **S** | Body fields, per #1714. |
| User MCP servers | v1 borderline | **M** | `mcpToolCall` is a narrated surface today, so user-configured MCP servers are in-scope. TS side is `@modelcontextprotocol/sdk` (already a dep of `apps/server` for the thread-control server), so this is glue: spawn/connect, list tools, expose as functions, dispatch calls. Can slip to v1.1 if the flag is meant to prove the loop first. |

### Later

| Capability | Call | Size | Notes |
|---|---|---|---|
| PTY sessions + `write_stdin` | later | **M** | Interactive REPLs and long-running processes. v1 exec is one-shot. |
| OS-level sandbox | later | **L** | macOS: seatbelt `.sbpl` profile is directly portable (S-M). Linux: landlock/bwrap via helper binary (M). Windows: restricted-token/ACL story is the expensive one (L); until then Windows is approval-gated only, same trust level as `danger-full-access` today. |
| `execpolicy`-style rule file | later | **M** | v1's classifier is a hardcoded safe-list; a user-editable policy DSL is a follow-up. |
| Auto-review approval middle ground | later | **M** | The upside the ticket names: a second cheap model call screens approval requests (our equivalent of `approvalsReviewer: "auto_review"`). v1 ships user-cards only. |
| `request_user_input` elicitation | later | **S** | Mcode does not support it today (safe-denied); a question-card event + tool is cheap when wanted. |
| `request_permissions` tool | later | **S** | Mostly redundant once exec/patch carry escalation params. |
| Sub-agents / child threads | later | **L** | `spawn_agent`/`send_input`/`wait`/`resume`/`close` family + `subAgentActivity`/`collabAgentToolCall` narration. Mcode already models nested rows; the cost is orchestrating nested loops, not display. Drops `@mention`-agent spawning until done. |
| Goals (`create_goal`/`update_goal` + steering) | later | **M-L** | The steering loop (auto-continued turns until the objective is met, with budget accounting) is the substance; Mcode's `goals` capability + `thread/goal/*` mirror already hold display state, so a minimal Mcode-side goal (S) is possible without auto-continuation. |
| `new_context` / `get_context_remaining` | later | **S** | Model-triggered compaction; rides on the v1 compaction machinery. |
| Clean-fork | later | **S** | Fork = truncate stored item list and resume. Cheap once replay exists. |
| `send_message_to_user_async`, `sleep`, `curr_time` | later | **S** | Trivial; add when a session needs them. |
| MCP elicitation + resource tools | later | **S-M** | After the base MCP client lands. |
| WS transport (`previous_response_id`, incremental input) | later | **M** | Per #1714: HTTP replay works; WS is an optimization. |
| Review mode (`/review`, entered/exitedReviewMode) | later | **M** | Silent items today; needs a review prompt + diff packaging. |

### Droppable

| Capability | Why |
|---|---|
| `imagegen` / `imageGeneration` item | Extension tool, silent in Mcode today; not a coding-loop concern. |
| Plugins (`plugin/list`, `plugin/read`, `request_plugin_install`, `list_available_plugins_to_install`) | Codex marketplace plumbing. |
| `tool_search` / deferred tool loading | Only pays off with a huge tool registry; Mcode's set is small. |
| Dynamic (client-registered) tools as a protocol concept | Own-loop *is* the client; every tool is already ours. |
| `code_mode` | Experimental codex-rs surface. |
| `wait_for_environment`, multi-environment/`environment_id` | One Mcode worktree = one environment. |
| MCP `mcp__` name-compat shim | Only needed for transcript replay compat with codex-cli sessions; Mcode starts fresh. |
| codex hooks, memories, realtime/voice, collab-mode templates, guardian-* extensions | Extension-ecosystem surface, not the loop. |
| exec-server daemon, shell snapshot, zsh_fork, network proxy | codex-rs deployment machinery; a local child_process needs none of it. |

## 5. Unverifiable from source

- Whether the backend honors `context_management` (native server-side compaction) for third-party callers. Hermes exposes it as an option; if it works, v1 compaction drops M -> S.
- Whether `web_search` is enabled on all plan types Mcode users bring; degrade gracefully if the tool is rejected.
- Whether V4A `patch` as a function arg matches the freeform `apply_patch` tool on edit quality for current codex models. Hermes chose the function-tool form, but codex-rs still ships the grammar, which suggests OpenAI considers the freeform form higher-fidelity.
- Whether a non-`codex_cli_rs` `originator` affects tool availability or model behavior server-side (carried from #1714).

## 6. Bottom line

**The rebuild is a medium-sized project, not a rewrite.** The flagged v1 is ~9 small items + ~6 medium items + zero large ones: the loop itself (M), one-shot exec (S), a V4A patch function tool (S), update_plan/view_image/web_search (S each), approval plumbing re-owned on Mcode's existing permission contract (M), policy-level workspace confinement instead of an OS sandbox (S), prompt port (S), replay/persistence (M, shared with #1714), minimal compaction (M), narration emitted directly (S), internal tools demoted from MCP to plain functions (S), error taxonomy (M), and the MCP client (M, borderline). Everything expensive, OS sandbox parity, native sub-agents, goal steering, PTY sessions, execpolicy compat, is deferrable without breaking the loop.

The real trade is not size but fidelity: dropping codex's native tool names/prompt means the model runs on Mcode's tool surface (Hermes proves this works), and Mcode owns the approval middle ground outright, which is the point of the ticket.

---

## Primary sources

### Mcode (this worktree)

- `packages/providers/src/private/codex/codex-app-server.ts`: RPC inventory (1198-1277, 1301-1352, 1568), `routeCodexServerRequest` (316-376), auto-approve (333-351), instruction composition (265-296).
- `packages/providers/src/private/codex/codex-event-mapper.ts`: `SILENT_ITEM_TYPES` (53-57), `TOOL_LIKE_ITEM_TYPES` (89-93), tool-row builders (1369-1376), collab/child tracking (667-731, 1885-1925).
- `packages/providers/src/private/codex/codex-permission-mapper.ts`: `CODEX_APPROVAL_METHODS` (16-23), decision mapping (41-95), `synthesizeCodexPermissionRequest` (98-140).
- `packages/providers/src/private/codex/codex-provider.ts`: capabilities (123-138), permission mapping (396-397, 1064), `approvalsReviewer` (1101), goal mirror + RPCs (835-1027), MCP config overrides (1346-1353), internal-MCP verification (1493-1510).
- `packages/providers/src/private/codex/codex-types.ts`: `TurnInputPart`/`TurnStartParams` (159-186), `CompletedItem` item list (380-435).
- `packages/providers/src/private/codex/codex-input-mapper.ts`: `localImage` attachments (143-145), internal-MCP detection (47-52).
- `apps/server/src/features/thread-control/authority/thread-control-mcp-runtime.ts:16`; `packages/thread-orchestration/src/mcode-instructions.ts:55-57` (`thread_*` tool contract).

### Codex (`.opensrc/repos/github.com/openai/codex/main/codex-rs/`)

- `tools/src/tool_spec.rs:19-58`: tool wire shapes (`function`/`namespace`/`tool_search`/`web_search`/`custom`).
- `core/src/tools/spec_plan.rs`: handler registry (`ExecCommandHandler`, `ApplyPatchHandler`, `PlanHandler`, `ViewImageHandler`, `RequestUserInputHandler`, `RequestPermissionsHandler`, multi-agents v1/v2, dynamic/extension tools).
- `core/src/tools/handlers/shell_spec.rs:23-114,117-131,232-290`: `exec_command`/`write_stdin` schemas incl. `sandbox_permissions`/`justification`/`prefix_rule`.
- `core/src/tools/handlers/apply_patch_spec.rs:9-28`; `apply-patch/src/{parser,streaming_parser,file_update,invocation}.rs`: freeform tool + ~5.1k LoC implementation.
- `core/src/tools/handlers/plan_spec.rs:7-53`, `plan.rs`: `update_plan`.
- `core/src/tools/handlers/view_image.rs`; `core/src/tools/hosted_spec.rs:14-49` (`web_search`).
- `core/src/mcp_tool_call.rs`, `core/src/tools/handlers/mcp.rs`, `codex-mcp/src/connection_manager*`, `rmcp-client/`: MCP client surface.
- `core/src/tools/handlers/multi_agents/{spawn,send_input,wait,resume_agent,close_agent}.rs`, `multi_agents_spec.rs`, `multi_agents_v2/`: sub-agent tools.
- `ext/goal/src/{tool,runtime,steering,accounting,extension}.rs`: goal tools + steering; `core/src/tools/handlers/extension_tools.rs:72-90` (builtin control tools incl. notes/history namespaces).
- `core/src/compact.rs:114-160`, `compact_remote_v2.rs`: compaction; `core/src/tools/handlers/{new_context_window,get_context_remaining}.rs`.
- `protocol/src/protocol.rs:986-1014` (`AskForApproval`), 1072-1117 (`SandboxPolicy`), 120-121 (environment_context tags).
- `app-server-protocol/src/protocol/common.rs:1764` (`item/tool/requestUserInput`); `v2/shared.rs:236-260` (`approvalsReviewer`/`auto_review`).
- `execpolicy/src/` (~2k LoC), `core/src/tools/network_approval.rs`: command classification + network approval.
- `sandboxing/src/{seatbelt,landlock,windows,policy_transforms,manager}.rs` + `seatbelt_*.sbpl`, `linux-sandbox/src/`, `exec-server/src/`: OS sandbox enforcement.
- `core/gpt_*_prompt.md`: per-model instructions.

### Hermes (`.opensrc/repos/github.com/NousResearch/hermes-agent/main/`)

- `agent/codex_responses_adapter.py:79-96` (builtin + server-side call types), 311-321 (tool schema conversion), 426-489 (call/output pairing).
- `agent/transports/codex.py:153-301`: request build.
- `agent/codex_runtime.py`: SSE loop, app-server projection shims (200-262).
- `agent/turn_tool_round.py:1-55`: tool round + persist-before-execute invariant.
- `tools/file_tools.py:1128-1207`, `tools/patch_parser.py`: `patch` tool with V4A dialect as a function arg.
- `tools/approval*.py`: provider-agnostic approval gate (detection, allowlist, gateway/human/LLM verdicts).
- `agent/transports/codex_app_server_session.py:578-626`: Hermes' own app-server approval routing (comparison point, not the Responses path).
