# `codex exec --json` vs the narration contract  -  Research Notes

**Status:** Research only  -  no implementation changes.
**Ticket:** Mzeey-Empire/mcode#1713  -  "codex exec --json: event parity gap vs the narration contract".
**Primary sources:** `openai/codex` `main` snapshot cached under `.opensrc` (fetched 2026-09-16; `main` HEAD at fetch time was `6500c1f844d8`), release tags `rust-v0.42.0` through `rust-v0.154.0` read via `raw.githubusercontent.com`, installed `codex-cli 0.153.0`, and the official docs at `developers.openai.com/codex/noninteractive`.
**Local contract side:** `docs/guides/codex-app-server-trace.md`, `packages/providers/src/__tests__/codex/fixtures/codex-protocol-golden.ndjson` (codex-cli 0.130.0 capture), `TURN_SCOPED_EVENT_TYPES` at `packages/providers/src/private/codex/codex-provider.ts:136`, `AgentEventType` at `packages/contracts/src/events/agent-event.ts:19`, mapper dispatch at `packages/providers/src/private/codex/codex-event-mapper.ts:1780`.
**Evidence tags:** `[verified]` = read in source or observed locally. `[doc]` = stated in OpenAI docs. `[inferred]` = reasoned from adjacent evidence. `[unknown]` = could not verify.

---

## 0. Headline verdict

`codex exec --json` is a **strict, lossy projection** of the same app-server notification stream Mcode already consumes. Since `rust-v0.117.0`, `codex exec` runs an **in-process app-server client** and translates `ServerNotification`s into the JSONL `ThreadEvent` schema (`codex-rs/exec/src/lib.rs:976`, `event_processor_with_jsonl_output.rs:414`). Driving exec would not add a different protocol, it would delete most of the one we have.

What survives: turn lifecycle, tool-call start/end rows, plan updates, sub-agent collab call rows (spawn/wait/close), final message text, end-of-turn token totals, and errors. What is lost: every delta channel (assistant text, reasoning text, command output, file-change output), all mid-turn usage/quota signal, compaction, goals, hooks, MCP startup status, approval prompts, mid-turn steering, and all child-thread (sub-agent) narration. In the golden fixture, the two channels exec discards (`item/commandExecution/outputDelta`, `item/agentMessage/delta`) account for ~14,676 of ~15,644 notification lines, roughly 94% of observed wire traffic `[verified]`.

**Not deprecated.** `codex exec` is alive on `main` (`Subcommand::Exec`, `codex-rs/cli/src/main.rs:158`), freshly rewritten onto app-server internals at `rust-v0.117.0`, and OpenAI added a separate `codex exec-server` (a PTY subprocess-control daemon, unrelated to agent sessions) alongside it. The removed surface is `codex mcp-server` (deleted 2026-09-05, PR openai/codex#42993); exec shows no deprecation markers in source, changelog, or docs `[verified]`.

---

## 1. The `exec --json` event schema (current)

`codex-rs/exec/src/exec_events.rs:11` defines `ThreadEvent`, `#[serde(tag = "type")]`, eight variants, stable since `rust-v0.44.0` `[verified]`:

| `type` | Payload | Notes |
|---|---|---|
| `thread.started` | `{thread_id}` | First event; emitted once per process, including on `resume`/`fork` (the resumed/new thread id). |
| `turn.started` | `{}` | Empty payload; no prompt echo, no turn id. |
| `item.started` | `{item}` | Tool-likes only. `agent_message` and `reasoning` items are **suppressed** at start (`map_started_item`, `event_processor_with_jsonl_output.rs:336`). |
| `item.updated` | `{item}` | In practice only `todo_list` updates (from `turn/plan/updated`). No output-delta path exists. |
| `item.completed` | `{item}` | Terminal item state, including `agent_message` full text and `reasoning` summary. |
| `turn.completed` | `{usage}` | `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. |
| `turn.failed` | `{error: {message}}` | Terminal failure. |
| `error` | `{message}` | Stream-level error. Will-retry errors also emit this; nothing distinguishes retry from fatal in-band. |

`ThreadItemDetails` (`exec_events.rs:107`), nine item types `[verified]`:

| item `type` | Payload | Source status |
|---|---|---|
| `agent_message` | `{text}` | Completed only; the whole message in one blob. |
| `reasoning` | `{text}` | Completed only; `summary` joined with `\n`; empty summaries suppressed; raw `reasoningContent`/`content` not carried. |
| `command_execution` | `{command, aggregated_output, exit_code, status}` | `started` has no output; `aggregated_output` arrives only at `completed`. Statuses: `in_progress`, `completed`, `failed`, `declined`. |
| `file_change` | `{changes: [{path, kind}], status}` | Completed-only per schema comment ("emitted only as a completed event once the patch succeeds or fails"). |
| `mcp_tool_call` | `{server, tool, arguments, result, error, status}` | started/completed. |
| `collab_tool_call` | `{tool, sender_thread_id, receiver_thread_ids, prompt, agents_states, status}` | Added at `rust-v0.117.0`. Tools: `spawn_agent`, `send_input`, `wait`, `close_agent`. `send_message`, `followup_task`, `interrupt_agent`, `list_agents` and `interrupted` status are dropped (`map_item_with_id`, `event_processor_with_jsonl_output.rs:142`). |
| `web_search` | `{id, query, action}` | started/completed. |
| `todo_list` | `{items: [{text, completed}]}` | Synthesized from `turn/plan/updated`, not a native item. |
| `error` | `{message}` | Warnings, config warnings, deprecation notices, and model reroutes are all flattened into `item.completed` `error` items. |

Item ids are synthetic (`item_N` from a counter, `raw_to_exec_item_id` map), not the provider-native ids app-server sends `[verified]`.

### Schema version history `[verified]`

- `rust-v0.42.0`: first `exec_events.rs`; envelope was `session.created`, `item.started`, `item.updated`, `item.completed`, `error` (no turn lifecycle).
- `rust-v0.44.0` through `main` (`6500c1f844d8`): the current eight-event envelope, unchanged.
- `rust-v0.117.0`: exec rewritten onto `ServerNotification` input (pre-0.117 it consumed `protocol::EventMsg` directly); `collab_tool_call` item added.
- `token_count`: **never part of this schema.** It existed only in the legacy pre-0.42 `--experimental-json` format, which passthrough-serialized raw `EventMsg` objects (`{"msg":{"type":"token_count",...}}`, see `event_processor_with_json_output.rs` at `rust-v0.30.0`). Since 0.44 the only token signal is `turn.completed.usage`; `thread/tokenUsage/updated` notifications are swallowed into a `last_total_token_usage` accumulator (`event_processor_with_jsonl_output.rs`, `ThreadTokenUsageUpdated` arm).

---

## 2. Parity table: what Mcode consumes vs what exec emits

Exec applies two filters. First, `should_process_notification` (`lib.rs:1578`) drops everything not scoped to the **primary thread and current turn** (child-thread items, realtime, rate limits, MCP status, goals, compaction, hooks all fail this gate). Second, the processor's catch-all (`_ => CodexStatus::Running`, `event_processor_with_jsonl_output.rs:591`) silently discards every delta and unlisted notification.

| Mcode `AgentEvent` (turn-scoped set, `codex-provider.ts:136`) | Native source | exec --json | Verdict |
|---|---|---|---|
| `turnStarted` | `turn/started` | `turn.started` (empty payload) | Degraded: exists, no prompt/turn id. |
| `textDelta` (assistant stream) | `item/agentMessage/delta` | none | **Missing.** Message arrives whole at `item.completed`. |
| `textDelta` (reasoning/plan) | `item/reasoning/textDelta`, `summaryTextDelta`, `item/plan/delta` | none | **Missing.** Reasoning arrives whole at `item.completed` (summary only). |
| `toolProgress` | `item/commandExecution/outputDelta` | none | **Missing.** No mid-command output at all. |
| `toolInputDelta` | (input deltas) | none | Missing. |
| `toolUse` | `item/started` for commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, webSearch | `item.started` for command_execution, file_change, mcp_tool_call, collab_tool_call, web_search, todo_list | Exists for shared types. **Missing:** `dynamicToolCall` (exec rejects dynamic tool calls outright, `lib.rs:2023`), `subAgentActivity`, `hookPrompt`, `functionCallOutput`, `imageView`, `imageGeneration`, `userMessage` echo. |
| `toolResult` | `item/completed` | `item.completed` | Exists; carries aggregated output, exit code, MCP result/error. |
| `assistantMessageBoundary` | `item/completed` (agentMessage) | `item.completed` (agent_message) | Exists semantically: completed item is the boundary. |
| `message` | promoted from completed assistant text | `item.completed` agent_message `.text` | Exists. |
| `turnComplete` | `turn/completed` | `turn.completed` / `turn.failed` | Exists. **Interrupted turns emit no terminal event** (`TurnStatus::Interrupted` -> `InitiateShutdown`, nothing pushed; process exits 1). |
| `contextEstimate` | `thread/tokenUsage/updated` (streamed) | `turn.completed.usage` only | Degraded: totals at end, no mid-turn estimate. |
| `error` | `error` notification | `error` event + `error` items | Exists; retries indistinguishable from fatal (`will_retry` dropped). |
| `ended` | session end | process exit | Degraded: exit code 0/1 is the only signal. |
| `compacting` / `compactSummary` | `thread/compacted`, `contextCompaction` item | none | Missing. |
| `modelFallback` | `model/rerouted` | `item.completed` `error` item ("model rerouted: ...") | Degraded: flattened to an error item. |
| `generatedAttachment` | imageView / imageGeneration items | none | Missing. |
| `quotaUpdate` (non-turn-scoped) | `account/rateLimits/updated` | none | Missing. |
| `rateLimited`, `providerUnavailable`, `apiRetry` (non-turn-scoped) | error/usage notifications | none distinct | Missing/degraded. |
| `hookStarted`/`hookProgress`/`hookCompleted` | `hook/started`, `hook/completed` | explicitly ignored | Missing (exec drops them too). |
| `goalUpdated`/`goalCleared` | `thread/goal/*` | filtered out | Missing. |
| `mcpServerStartupStatus` | `mcpServer/startupStatus/updated` | filtered out | Missing. |
| `system` (notices) | `warning`, `configWarning`, `deprecationNotice` | `item.completed` `error` items | Degraded: all warnings become indistinguishable error items. |
| Sub-agent child narration | child-thread `item/*`, `turn/*` on receiver thread ids | none | **Missing entirely**: `should_process_notification` requires `thread_id == primary && turn_id == current`. Only the parent's `collab_tool_call` rows remain. |
| Turn diff evidence | `turn/diff/updated` (Mcode currently ignores it anyway) | filtered out | Missing (parity-neutral today). |
| Approvals | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` server requests | auto-rejected | **Missing and impossible**: exec answers every approval request with reject (`handle_server_request`, `lib.rs:1977`) and forces `approval_policy = Never` (`lib.rs:568`). `--approve-for-me` routes to internal auto-review instead. |

---

## 3. `exec resume`, fork, and the multi-turn story `[verified]`

- Surface: `codex exec resume [SESSION_ID] [--last] [--all] [-i images] [PROMPT]` plus `codex exec fork SESSION_ID [PROMPT]` and `codex exec review` (`exec/src/cli.rs`).
- Resolution (`resolve_resume_thread_id`, `lib.rs:1758`): UUID parses straight through to `thread/resume`. `--last` runs `thread/list` sorted by `updated_at`, **filtered to current cwd** unless `--all`; state-db miss falls back to scanning rollout files. A bare session name resolves via exact-title lookup, cwd-filtered unless `--all`.
- On resume, `thread.started` still fires first with the **resumed** thread id; then the new prompt runs as one turn in the same process.
- Sharp edge: if the session cannot be resolved (or no id/`--last` given), exec **silently starts a new thread** instead of failing (`lib.rs:983-1009`).
- `--ephemeral` sessions cannot be resumed (no rollout persisted); `--worktree` is rejected with `resume`/`review`.
- There is no `turn/steer` equivalent: each continued prompt is a fresh process that re-initializes, resumes the thread, runs one turn, exits. Mid-turn follow-up input is impossible.

## 4. stdin `[verified]`

- Prompt resolution (`StdinPromptBehavior`, `lib.rs:187`; `read_prompt_from_stdin`, `lib.rs:2219`): positional prompt wins; `-` forces reading the prompt from stdin; piped stdin with no prompt is the prompt; piped stdin **with** a prompt is appended as a `<stdin>` context block (also `[doc]`).
- stdin is read **once at startup**. It is not a control channel: no mid-turn messages, approvals, or interrupts flow through it.

## 5. Sandbox, approval, and output flags `[verified]` (`cli.rs`, `shared_options.rs`, `codex exec --help` on 0.153.0)

- `-s/--sandbox read-only|workspace-write|danger-full-access` (docs: default read-only `[doc]`); `--dangerously-bypass-approvals-and-sandbox` (`--yolo`); `--approve-for-me` (auto-review, alias `not-so-yolo`, conflicts with `-s`/`--yolo`); `-C/--cd`, `--add-dir`, `--worktree` (main only; not in 0.153.0 help), `--skip-git-repo-check`, `-m/--model`, `-p/--profile`, `-i/--image`, `-c key=value`, `--enable/--disable`, `--strict-config`, `--ignore-user-config`, `--ignore-rules`, `--thread-source`, `--color`, `--ephemeral`.
- Approvals: headless forces `approval_policy = Never`; interactive approval is structurally absent (section 2).
- `--output-schema FILE`: constrains the **final** response to a JSON Schema; the final `agent_message` item then contains JSON `[doc]` `[verified]` (passed as `output_schema` on the turn, `lib.rs:180`).
- `-o/--output-last-message FILE`: writes the final agent message to a file at shutdown **and** still prints it `[doc]`; sourced from `final_message` (last completed `agent_message`, falling back to a `plan` item's text).
- `--ephemeral`: sets `ephemeral: true` on `thread/start`; no rollout files; also disables the `turn.completed` item backfill (below) `[verified]`.
- `--full-auto`: still documented as a deprecated compat flag `[doc]`, but absent from the clap surface on main and in 0.153.0's `--help`  -  likely removed in favor of `--approve-for-me` `[inferred]`.
- Interruption: Ctrl-C sends `turn/interrupt` (`lib.rs:1113-1231`); an interrupted turn produces no terminal event and exit code 1. Failed turns produce `turn.failed` and exit 1 (`error_seen`, `lib.rs:1245-1310`).
- `turn.completed` backfill: because app-server emits `turn/completed` with empty `items` on this version, exec issues a final `thread/read` to recover the last message and reconcile unfinished items before shutdown (`maybe_backfill_turn_completed_items`, `lib.rs:1642`). This is the same "trust live ordering, not `turn.items`" invariant recorded in `docs/guides/codex-app-server-trace.md`.

## 6. Mid-turn narration outlook

A Mcode timeline driven by `exec --json` would show: `turn.started`, then tool rows appearing at spawn and updating only at completion, `todo_list` items for plan updates, a `reasoning` blob popping in fully formed, the assistant message landing whole at `item.completed`, then `turn.completed` with usage totals. It reads as a **batched step log**, not a live stream: no typing effect, no live stdout tail, no in-progress thinking, no quota footer, no compaction signal, no sub-agent internals, no approval interaction, and silent process death on interrupt.

The gap is a choice in the exec processor, not a protocol limitation: the in-process app-server already delivers every notification; exec discards them. If Mcode ever needed exec parity behavior, the upstream patch would be small (handle `AgentMessageDelta`/`CommandExecutionOutputDelta`/child-thread items in `collect_thread_events`), but the simpler path is the one we already have: `codex app-server` gives the full stream plus approvals and `turn/steer`.

---

## 7. Unverifiable / caveats

- `.opensrc` does not record the snapshot SHA; pinned to `main@6500c1f844d8` by fetch-time correlation (snapshot fetched 14:47Z, HEAD commit timestamp 14:49Z). The schema files checked match released `rust-v0.153.4`, so tag-level claims are safe even if main moved by a few commits.
- Whether an app-server client that never starts the child thread would even *receive* child notifications is moot for exec (they are filtered regardless), but exec's flat stream gives no `parentToolCallId`-style linkage field, so nesting could not be reconstructed even if they arrived.
- `thread/status/changed` and `thread/started` notifications seen in Mcode traces are pre-filter drops in exec; confirmed by the `_ => false` arm, not by a live exec capture. No `codex exec` run was executed for this note; schema claims are all from source.
- `--full-auto` removal on main is inferred from its absence in clap definitions; docs still mention it.
