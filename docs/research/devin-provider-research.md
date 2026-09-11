# Devin as an Mcode Provider — Research Notes

**Status:** Research only — no implementation changes.
**Devin CLI observed:** `devin 3000.6.19 (e2b252e2)` at `C:\Users\chukwudi.nwobodo\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`.

---

## 1. Mcode Provider Adapter Contract

Mcode providers are external AI agent CLIs adapted through the `IAgentProvider` seam in `packages/contracts/src/providers/interfaces.ts` (lines 124–211). Each provider must:

* Declare a stable `ProviderId`, a `descriptor` (`Provider` with runtime capabilities), and `supportsCompletion`.
* Implement `sendTurn(req: TurnRequest)` to start/continue one user turn, `stopSession(sessionId)` to cancel, `shutdown()` to tear down all sessions, and `listModels()` to return `ProviderModelInfo[]`.
* Emit `ProviderRuntimeEvent` objects (an `AgentEvent` plus optional provider-native extension) through an `event` listener. Only `AgentEvent` values cross the wire to clients; native evidence stays in the extension (`packages/contracts/src/events/provider-runtime-event.ts`, lines 62–85).
* Produce a fixed set of canonical `AgentEvent` types: `turnStarted`, `textDelta`, `toolUse`, `toolResult`, `message`, `turnComplete`, `ended`, `error`, `system`, `quotaUpdate`, and others (`packages/contracts/src/events/agent-event.ts`, lines 19–47 and 53–375).

Lifecycle is managed by `SessionRuntime<TState>` in `packages/providers/src/private/session-runtime.ts` (lines 54–165). The provider implements `ProtocolAdapter<TState>` (lines 23–30) with `spawn`, `isBusy`, `interrupt`, `close`, and `isStale`; the runtime owns pooling, idle eviction (60 s sweep, 10 min TTL), Windows `JobObject` attachment, and graceful-interrupt-then-hard-kill. This is the pattern used by the Cursor adapter (`packages/providers/src/private/cursor/cursor-provider.ts`, lines 141–162, 838–877) and the Codex adapter.

---

## 2. Devin CLI Invocation Modes and Extensibility

Devin CLI has three primary invocation shapes:

1. **Interactive REPL:** `devin` or `devin -- <prompt>` — a terminal UI session with saved conversation history (`docs/essential-commands.mdx`, lines 9–16). Not suitable for Mcode because it is interactive and does not expose a streamable machine protocol.
2. **Single-turn print mode:** `devin -p "prompt"` (or `devin --print`) — runs one prompt, prints the response to stdout, and exits (`docs/essential-commands.mdx`, lines 13–16; `docs/reference/commands.mdx`, lines 28–35). Useful for scripts but not for persistent multi-turn sessions; also fails in untrusted directories unless `--respect-workspace-trust false` is passed.
3. **ACP server mode:** `devin acp` — launches Devin as an [Agent Client Protocol](https://agentclientprotocol.com/) server that speaks JSON-RPC 2.0 over stdin/stdout (`docs/reference/commands.mdx`, lines 295–315; `docs/acp/jetbrains.mdx`, lines 150–153). This is the only mode that matches Mcode’s persistent-process-per-session architecture.

Relevant Devin CLI capabilities from the local docs:

* Global flags: `--model`, `--permission-mode`, `--sandbox`, `--continue`, `--resume`, `--config` (`docs/reference/commands.mdx`, lines 19–31). `DEVIN_MODEL` and `DEVIN_PERMISSION_MODE` env vars are also honored.
* Permission modes: `normal`, `accept-edits`, `smart`, `bypass`/`dangerous`/`yolo`, and `autonomous` (requires `--sandbox`) (`docs/essential-commands.mdx`, lines 40–131).
* Slash commands: `/plan`, `/ask`, `/mode`, `/model`, `/continue`, `/workspace`, `/add-dir`, `/loop`, `/hooks`, `/mcp`, etc. (`docs/essential-commands.mdx`, lines 162–239).
* Subagents: foreground and background; `run_subagent`/`read_subagent` tools; built-in profiles `subagent_explore` and `subagent_general`; custom subagents under `.devin/agents/` (`docs/subagents.mdx`, lines 9–33, 111–122, 214–321).
* MCP servers: configured in `.devin/mcp_config.local.json` or via `devin mcp add`; tools appear as `mcp__<server>__<tool>` (`docs/extensibility/mcp/overview.mdx`, lines 7–120).
* Skills, rules, plugins, and hooks are read from `.devin/`, `.agents/`, `AGENTS.md`, and other conventional paths (`docs/extensibility/index.mdx`, lines 46–65, 73–95).
* Auth: `devin auth login` stores credentials; `WINDSURF_API_KEY` is used when set; ACP can also accept credentials at runtime through the `authenticate` request (`docs/reference/commands.mdx`, lines 303–304; `docs/enterprise/devin-auth.mdx`, lines 29–35; `docs/enterprise/windsurf-auth.mdx`, lines 41–51).
* Sandbox: enforced OS-level isolation with `--sandbox` on macOS/Linux; **not supported on Windows**, where passing `--sandbox` causes a hard fail (`docs/sandbox.mdx`, lines 18–23, 109–116).

The ACP protocol defines a JSON-RPC flow: `initialize` → optional `auth/login` → `session/new` or `session/load` or `session/resume` → `session/prompt` → `session/cancel`/`session/close`. The agent streams `session/update` notifications for `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, and `usage_update`, and calls `session/request_permission` when it needs user approval (`https://agentclientprotocol.com/protocol/v2/overview`; `https://agentclientprotocol.com/protocol/v1/prompt-turn`; `https://agentclientprotocol.com/protocol/v1/session-setup`).

---

## 3. Mapping Devin Capabilities to the Mcode Adapter Contract

| Devin capability | Mcode seam / concept | Fit | Notes |
|---|---|---|---|
| `devin acp` JSON-RPC over stdio | `ProtocolAdapter.spawn` + `SessionRuntime` | **Good** | Persistent child process per Mcode session, exactly the pattern Cursor uses (`packages/providers/src/private/cursor/runtime/cursor-acp-process-spawner.ts`, lines 61–80). |
| `initialize` / `auth/login` | Provider spawn handshake | **Good** | ACP runtime already negotiates capabilities and selects an auth method (`packages/providers/src/private/protocols/acp/acp-session-runtime.ts`, lines 156–177). |
| `session/new` | `TurnRequest` with no `resumeFrom` | **Good** | `cwd` is the thread worktree; `mcpServers` can be passed if Mcode wants to inject MCP servers. |
| `session/resume` / `session/load` | `TurnRequest.resumeFrom` | **Likely** | ACP spec defines these, and Devin CLI supports `--continue`/`--resume` in interactive mode; ACP support must be verified against Devin’s `initialize` capabilities. |
| `session/prompt` | `IAgentProvider.sendTurn` | **Good** | One user message per prompt; response is a stop reason plus optional usage. |
| `session/cancel` notification | `IAgentProvider.stopSession` / `interrupt` | **Good** | Maps to a graceful cancel before `SessionRuntime` hard-kills the child. |
| `session/close` | `ProtocolAdapter.close` / `shutdown` | **Conditional** | Only usable if Devin advertises `sessionCapabilities.close`. |
| `session/update` `agent_message_chunk` | `AgentEventType.TextDelta` / `Message` | **Good** | Cursor adapter already maps ACP text chunks (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`, lines 166–185). |
| `session/update` `tool_call` / `tool_call_update` | `AgentEventType.ToolUse` / `ToolResult` | **Needs adapter** | Devin tool `kind` names may differ from Cursor (e.g. `run_subagent` instead of `subagent`); a Devin-specific mapper is required. |
| `session/update` `plan` | `AgentEventType.ToolUse`/`ToolResult` with `toolName: "TodoWrite"` | **Likely** | Cursor maps ACP `plan` entries to paired `TodoWrite` events (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`, lines 614–630). |
| `session/update` `usage_update` | `AgentEventType.QuotaUpdate` / `TurnComplete` | **Needs mapping** | Devin reports ACU/credit usage; Mcode expects `costUsd` and token counts. |
| `session/request_permission` | `permission_request` event + `resolvePermission` | **Good** | Mcode already has a permission-request flow (`packages/contracts/src/providers/interfaces.ts`, lines 190–208). |
| ACP `fs/readTextFile` / `fs/writeTextFile` | `ProviderHostPorts` file access | **Unknown** | Cursor implements these client methods; Devin may use its own file tools or may ask the client. Must be tested. |
| `--model` / `DEVIN_MODEL` | `TurnRequest.model` | **Unclear** | Model is set at process startup. It is unknown whether Devin ACP accepts a per-prompt model override. |
| `--permission-mode` | `TurnRequest.permissionMode` | **Needs decision** | Mcode uses `supervised`/`full`; Devin uses `normal`/`accept-edits`/`smart`/`bypass`/`autonomous`. Mapping is not 1:1. |
| `--sandbox` | `permissionMode=full` safety | **Problem on Windows** | Sandbox is unsupported on Windows. On macOS/Linux it enables `autonomous`; on Windows it will hard-fail. |
| `devin models list --format json` | `IAgentProvider.listModels` | **Implementable** | Returns available model families. Requires a logged-in user; output schema must be parsed. |
| `devin -p/--print` | `ICompletionCapable.complete` | **Possible** | Could serve one-shot completions, but non-interactive mode has workspace-trust/auth edge cases. |
| Subagents (`run_subagent`) | `toolName: "Agent"` / sub-agent rows | **Likely** | Similar to Cursor’s `subagent`/`delegate` mapping (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`, lines 42–53). |
| Worktree `cwd` | `TurnRequest.cwd` | **Good** | Set `cwd` to the thread’s worktree path. Devin can also add additional roots via `additionalDirectories` if `sessionCapabilities.additionalDirectories` is advertised. |
| `devin auth login` / `WINDSURF_API_KEY` | Provider auth config | **Needs UX decision** | No API key is passed per request today; Mcode currently relies on the CLI being authenticated externally. |

---

## 4. Concrete Files and Types That Would Change

### `packages/contracts` (schema/wire types)

* `src/providers/interfaces.ts` (line 21): add `"devin"` to the `ProviderId` union; add `devin: Record<string, never>` (or a knobs object) to `ProviderOptionsByProvider` (lines 58–68).
* `src/providers/catalog.ts` (lines 25–32): add a Devin entry to `PROVIDER_CATALOG` (`id: "devin"`, `name: "Devin"`, `cliBinary: "devin"`, `beta: true`, `comingSoon: false`).
* `src/providers/availability.ts` (line 26): add `"devin"` to the `ProviderAvailabilitySchema.id` enum.
* `src/events/agent-event.ts` (line 243): add `"devin"` to the `ProviderUnavailable` `providerId` enum.
* `src/models/settings.ts` (lines 63, 277–301): add `devin` to `ProviderIdSchema`; add `enabled.devin`, `cli.devin`, and a `provider.devin` tuning object.

### `packages/providers` (adapter implementation)

* `src/factories.ts` and `src/index.ts` (lines 1–6): add and export `createDevinProvider`.
* `src/factory-types.ts` (lines 17–63): add `devin?: DevinProviderPorts` to `ProviderFactoryInput`; extend `ProviderBoundary["id"]` and define `DevinProviderPorts`.
* `src/private/devin/` (new directory): Devin-specific adapter files mirroring Cursor’s structure:
  * `devin-provider.ts` — implements `IAgentProvider` and `ProtocolAdapter`, holds a `SessionRuntime`, wires the ACP runtime.
  * `devin-acp-spawn-args.ts` — builds `devin acp --model <model> --permission-mode <mode>` argv.
  * `devin-acp-event-mapper.ts` — converts Devin ACP `session/update` notifications to `AgentEvent` values.
  * `devin-session-state.ts` — per-session mutable state.
  * `devin-models.ts` — `devin models list --format json` parser + static fallback.
* `src/private/protocols/acp/acp-session-runtime.ts` (lines 75–153, 156–177, 262–313): the generic ACP runtime can likely be reused; only the event mapper and spawn args are Devin-specific.

### `apps/server` (registration)

* `src/features/providers/composition/register-providers.ts` (lines 43–66): register `DevinProvider` as an `IAgentProvider` token, following the Cursor/Codex pattern.
* `src/features/providers/composition/provider-registry.ts` (lines 15–25): no change needed — it collects all `IAgentProvider` tokens by `ProviderId`.

### `apps/web` (client catalog)

* `src/lib/model-registry.ts` (lines 78–143): add a `devin` entry to `MODEL_PROVIDERS` with a static fallback model list (or an empty list if relying entirely on `listModels`).

---

## 5. Canonical Events a Devin Adapter Would Need to Produce

At minimum, a Devin ACP adapter would emit these `AgentEvent` types:

* `turnStarted` at the beginning of `sendTurn`.
* `textDelta` for each ACP `agent_message_chunk` with text content.
* `toolUse` / `toolResult` pairs for each ACP `tool_call` / `tool_call_update`.
* `message` once the final assistant text is assembled (Cursor emits this at turn completion; `packages/providers/src/private/cursor/runtime/cursor-turn-executor.ts`, lines 443–455).
* `turnComplete` when `session/prompt` returns, carrying the `stopReason` and any usage data.
* `ended` in every exit path (success, cancellation, error, crash).
* `error` on spawn, handshake, or prompt failure.
* `quotaUpdate` or `system` if Devin sends `usage_update` notifications.
* `providerUnavailable` if the `devin` binary is missing or disabled.

Subagent and plan events can follow the Cursor pattern (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`, lines 302–421, 614–630).

---

## 6. Open Decisions and Unknowns

These questions must be resolved before implementation can begin:

1. **Per-turn model selection.** `devin acp` accepts `--model` at startup. Can the model be changed per `session/prompt`, or does Mcode need to spawn a new process when the user switches models? If a new process is required, how does that interact with `SessionRuntime` pooling?
2. **Permission/interaction mode mapping.** Mcode has `supervised`/`full` and `build`/`plan`; Devin has `normal`/`accept-edits`/`smart`/`bypass`/`autonomous` and `/plan`. Which Devin permission mode should `supervised` and `full` map to? Should `/plan` be sent as a leading slash command in the first prompt?
3. **Authentication UX.** Devin requires `devin auth login` or `WINDSURF_API_KEY`. Should Mcode expect the user to have authenticated the CLI externally, or should it surface a login flow? If the token expires, how is re-auth surfaced?
4. **Session resume/load support in Devin ACP.** The ACP spec supports `session/resume` and `session/load` if advertised, and Devin CLI supports `--continue`/`--resume` interactively. Does Devin ACP advertise `sessionCapabilities.resume`/`loadSession`? Without verification, same-turn recovery and fork handoffs are unknown.
5. **Worktree isolation and workspace trust.** Devin CLI uses the process `cwd` as its workspace. Does running in a git worktree directory give Mcode the expected isolation? Does ACP require `--respect-workspace-trust false` for non-interactive sessions in new worktrees?
6. **Windows sandbox behavior.** `--sandbox` is unsupported on Windows and fail-closed. How should Mcode map `permissionMode=full` on Windows? Bypass mode without a sandbox gives the agent broad access; is that acceptable?
7. **Tool-call event shape.** Does Devin ACP use the same `tool_call`/`tool_call_update` schema as Cursor, or does it use different `kind` values (e.g. `run_subagent`, `read`, `edit`, `write`)? A mapper cannot be written without sample traffic.
8. **File-system client methods.** Devin ACP may call `fs/readTextFile` and `fs/writeTextFile` on the client. Does Devin actually use these, or does it read/write files through its own tools? If it uses client fs, Mcode must implement path scoping against the worktree.
9. **Usage/cost reporting.** Devin bills in ACUs/credits. Can the adapter derive a `costUsd` number for `TurnComplete`? Does the `usage_update` ACP notification contain token counts, or only ACU/credit values?
10. **MCP and thread-control integration.** Mcode passes browser/thread-control MCP servers to Cursor ACP. Should Devin receive the same? Does Devin ACP honor `mcpServers` in `session/new` and support HTTP MCP?
11. **One-shot completion.** Should Devin be `ICompletionCapable` and use `devin -p` for utility completions, or should utility tasks keep using the existing default/utility provider? `devin -p` has workspace-trust/auth quirks.
12. **Subagent lifecycle parity.** Devin subagents run in parallel and can be foreground or background. Mcode expects sub-agent tool calls and child thread rows. How do Devin subagent IDs and results map to Mcode’s `parentToolCallId` and `ToolResult`?
13. **Provider catalog metadata.** Should Devin be `beta: true` and `comingSoon: false`? Should it support `build`, `plan`, `permissions`, `session-eviction`, `clean-fork`? `clean-fork` depends on verified session resume behavior.

---

## 7. Primary Sources

### Mcode architecture and provider contract

* `CONTEXT.md`, lines 8–65 — provider, protocol adapter, session runtime, and worktree definitions.
* `ARCHITECTURE.md`, lines 95–100, 600–623 — provider event path, `ProviderId`, `IAgentProvider`, registry pattern.
* `docs/guides/provider-architecture.md`, lines 16–49, 51–90 — `SessionRuntime` + `ProtocolAdapter` lifecycle, event boundary.
* `packages/contracts/src/providers/interfaces.ts`, lines 21, 58–68, 124–211 — `ProviderId`, `TurnRequest`, `IAgentProvider`.
* `packages/contracts/src/events/agent-event.ts`, lines 19–47, 53–375 — `AgentEventType` and `AgentEvent` schema.
* `packages/contracts/src/events/provider-runtime-event.ts`, lines 62–85 — `ProviderRuntimeEvent` wrapper.
* `packages/providers/src/private/session-runtime.ts`, lines 8–30, 54–165 — `ProtocolAdapter`, `SpawnArgs`, `SessionRuntime`.
* `packages/providers/src/private/cursor/cursor-provider.ts`, lines 141–162, 346–365, 730–777, 838–877 — example ACP provider implementing `IAgentProvider`, `sendTurn`, `stopSession`, `spawn`.
* `packages/providers/src/private/cursor/runtime/cursor-acp-process-spawner.ts`, lines 61–120 — spawning an ACP child with `cwd`, `env`, and argv.
* `packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`, lines 42–160, 302–421, 614–630 — mapping ACP `session/update` types to Mcode events.
* `packages/providers/src/private/protocols/acp/acp-session-runtime.ts`, lines 75–153, 156–177, 262–313 — generic ACP runtime methods and resume/load logic.
* `packages/providers/src/factories.ts`, lines 1–32 — provider factory pattern.
* `apps/server/src/features/providers/composition/register-providers.ts`, lines 43–66 — DI registration of provider instances.
* `packages/contracts/src/providers/catalog.ts`, lines 25–32 — `PROVIDER_CATALOG`.
* `apps/web/src/lib/model-registry.ts`, lines 78–143 — frontend provider/model registry.

### Devin CLI docs and protocol

* `docs/index.mdx`, lines 28–45 — install methods (Windows installer, Homebrew, curl).
* `docs/essential-commands.mdx`, lines 9–16, 40–131, 162–239 — REPL, print mode, permission modes, slash commands.
* `docs/reference/commands.mdx`, lines 19–52, 295–315 — global flags and `devin acp` subcommand.
* `docs/models.mdx`, lines 36–67 — model selection.
* `docs/subagents.mdx`, lines 9–33, 111–122, 214–321 — subagent behavior and custom profiles.
* `docs/extensibility/index.mdx`, lines 46–95 — `.devin/` config layout and imported rules.
* `docs/extensibility/mcp/overview.mdx`, lines 7–120 — MCP server configuration.
* `docs/enterprise/devin-auth.mdx`, lines 29–35 — `devin auth login` and Devin Enterprise.
* `docs/enterprise/windsurf-auth.mdx`, lines 41–51 — legacy Windsurf auth.
* `docs/sandbox.mdx`, lines 18–23, 109–116 — `--sandbox` limitations on Windows.
* `https://agentclientprotocol.com/protocol/v2/overview` — ACP JSON-RPC flow and method list.
* `https://agentclientprotocol.com/protocol/v1/prompt-turn` — `session/prompt`, `session/update`, tool-call, and stop-reason semantics.
* `https://agentclientprotocol.com/protocol/v1/session-setup` — `session/new`, `session/load`, `session/resume`, `session/close`.
* Observed `devin --help` and `devin acp --help` output (Devin 3000.6.19).

---

**Bottom line:** Devin can likely be integrated as an ACP-based provider by reusing the generic `AcpSessionRuntime` and the Cursor-ACP adapter pattern, but significant product and protocol decisions (model selection, permission mapping, auth UX, session resume, Windows sandbox, and tool-call schema) must be resolved with real ACP traffic before writing the mapper.
