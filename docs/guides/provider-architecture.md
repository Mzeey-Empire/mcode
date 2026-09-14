# Provider Architecture Convention

All agent providers must use a **persistent process per session**, not per-turn spawning.

When all clients disconnect, a regular Mcode server waits for its shutdown grace
period. Active agent turns defer shutdown. Open terminals and idle provider
sessions do not. Graceful shutdown closes those remaining resources. Supervised
agent runtimes stay alive until their supervisor stops them.

Shutdown closes terminal process scopes concurrently through the PTY host. The
host has 25 seconds for graceful cleanup. The server watchdog allows 35 seconds
for the full shutdown. The desktop waits 40 seconds before forced cleanup of its
owned server. Startup, heartbeat, and normal operation deadlines do not change.

## Shared lifecycle: SessionRuntime + ProtocolAdapter

The uniform session lifecycle lives privately in `packages/providers`.
Each Provider holds its own `SessionRuntime<TState>` and implements
`ProtocolAdapter<TState>` (composition, not inheritance). The runtime owns the
session pool, the lazy 60s idle-eviction timer with a `lastUsedAt + isBusy`
guard, Windows `JobObject` attachment, the `EnvService` env snapshot, and the
graceful-interrupt-then-`taskkill /T /F` hard close — acting on the child PIDs
the adapter's `spawn` surfaces. The adapter supplies only `spawn`, `isBusy`,
`interrupt`, `close`, and `isStale`.

When adding a Provider, implement the `ProtocolAdapter` seam on the Provider
class and construct a `SessionRuntime` in its constructor; the pool, eviction,
JobObject, and hard-kill come for free. Do not hand-roll a session map or an
eviction timer. If the SDK hides the subprocess PID, return an empty `pids`
array from `spawn` and the runtime's JobObject/taskkill become best-effort
no-ops for that Provider (document it).

Both the Claude and Codex providers were originally built with per-turn process spawning
(via their respective SDKs). Both suffered the same reliability issues: stdin pipe timing
failures on Windows, abort signal races, and opaque error messages from stderr status lines
masking the real failure. Both were rewritten to use persistent processes.

When adding a new provider:

- Spawn one long-lived child process per session
- Communicate via stdin/stdout (JSON-RPC, NDJSON, or equivalent streaming protocol)
- Use graceful interruption (RPC call like `turn/interrupt`) before hard process kill
- On Windows, use `taskkill /T /F /PID <pid>` via execFile (not exec) for process tree
  cleanup - Node's `child.kill()` does not kill grandchildren on Windows
- Never pass `AbortSignal` directly to `spawn()` - manage cancellation via protocol-level
  interruption, not OS signals
- Guarantee `ended` event emission in every exit path (clean completion, error, crash, timeout)
- Filter stderr: classify lines as benign (debug log) or fatal (session teardown), never
  surface raw stderr as user-facing error messages

## Event boundary

### Activity labels

Providers use the existing canonical events for the live activity label. No provider-specific UI branch is required.
Set `toolInput.description` on `ToolUse` to supply a short action label. Keep credentials and raw command arguments out of this description.
Without a description, the UI uses a file action or the tool category. `ToolResult` ends that action.
Non-final `TextDelta` events can supply a Markdown summary heading, such as `**Inspecting layout**`.
The label uses the latest active root tool first, then a complete heading from the current open thought segment, then `Thinking...`.
Completed tools, child tools, and closed thought segments do not supply the label. Plain narration does not become an inferred activity.
Codex already forwards non-final summary deltas. Claude and Cursor use the same tool and narration events; adapters can add descriptions without a wire-schema change.

A provider emits a `ProviderRuntimeEvent`. Its `event` is provider-neutral data
that may reach the renderer. Its optional extension contains provider-native
evidence that must not reach the renderer.

The server accepts runtime events in this order:

```text
Provider runtime event → provider ingress → provider adapter → turn event pipeline → AgentEvent
```

Ingress validates the provider identity, queues the event, and preserves its
receipt when it came from a canonical commit. An adapter may forward a generic
event, consume private provider work, or reject malformed native evidence with
a diagnostic. Only a forwarded `AgentEvent` enters narration, lifecycle, and
renderer publication.

Codex collaboration evidence uses a Codex adapter. Claude, Cursor, and Copilot
send generic runtime events and do not invoke that adapter. A new provider adds
an adapter only when it has private native evidence that requires server-side
projection.

Canonical commits hand their committed runtime envelopes directly to ingress.
The resulting receipt means durable acceptance or queueing. It never means that
the event was published to the renderer.

`AgentService` owns provider selection and narrow parent-turn durability. It
does not import a concrete provider, a provider adapter, or a canonical
implementation.

## Codex notices

Codex warnings, security notices, configuration notices, and deprecation
notices appear above the Composer. Configuration notices retain the file path
and one-based line and column range. Reconnect restores the current session;
a new provider session clears the previous notices.

Model reroutes show one current notice in the affected thread and a toast only
when that thread is active. Repeated delivery updates the existing notice. The
upstream `highRiskCyberActivity` reason is a safety reroute, so it does not imply
model unavailability. Authentication recovery produces a notice after Codex
reports recovery.

The Codex adapter validates native notice payloads before projection. Unknown
or malformed notifications produce bounded diagnostics and logs without
copying raw payloads. Its dispatch receipt distinguishes mapped events,
internal state updates, diagnostics, and intentionally ignored methods with a
stable reason. Known child-thread notices retain child attribution. A notice
from an unlinked native thread is logged rather than shown in the chat.

## Devin (ACP)

Devin runs over the local `devin acp` binary behind the shared
`AcpSessionRuntime` (`packages/providers/src/private/devin/`). It is a beta
provider, enabled through `provider.enabled.devin`; `provider.cli.devin`
covers off-PATH installs.

- **Headless auth only.** Mcode never opens a browser and stores no Devin
  secret. Each spawned process authenticates via ACP `authenticate`
  (`methodId: "windsurf-api-key"`, `_meta.headless`, `_meta.api_key`) from
  `WINDSURF_API_KEY` / `DEVIN_API_KEY` / `windsurf_api_key` env vars or Devin's
  own `credentials.toml`. A failed authenticate kills that spawn and fails the
  turn; the next turn retries.
- **Model and mode are session config, not spawn flags.** Both go through
  `session/set_config_option` (`configId: "model"` / `"mode"`) so neither
  change respawns the process. Devin's flattened mode axis
  (normal / accept-edits / smart / bypass / plan) renders inside the shared
  Access Mode control and persists as `threads.devin_mode`; the coarse
  `permissionMode` fallback maps `supervised` -> `normal` and `full` ->
  `bypass`. Mcode's Plan interaction mode sends `plan` and restores the
  thread's native mode on return to Build. The adapter tracks the `mode`
  select each session advertises, skips unadvertised values, and surfaces
  them through `provider.listModes` so the picker drops account-gated modes.
- **File access is scoped.** The mandatory `fs/read_text_file` and
  `fs/write_text_file` client callbacks allow the session cwd plus Devin's
  canonical `~/.devin/plans/` directory (where `write_plan` lands); everything
  else outside cwd is refused.
- **No OS sandbox on Windows.** Devin sandboxes only inside WSL 2, so on
  Windows `full` means unsandboxed Bypass. Outside WSL there is no
  sandboxed-autonomy tier; `autonomous` is not offered.
- **Resume without forking.** `session/load` resumes across eviction and
  restart (`threads.sdk_session_id` is the cursor); there is no
  `session/resume`/`session/close`, and teardown is `session/cancel` plus
  process kill. Handoff uses the history-replay side channel (path B-prime),
  not a session fork.
- **Permissions pass through verbatim.** `session/request_permission` options
  (allow once / allow for session / always allow in project / switch to
  bypass / reject) render as real option buttons; `allow_always_global` is
  hidden because it writes outside the worktree. `switch_bypass` updates the
  thread's `devin_mode` so the composer reflects the mode Devin actually
  entered.
- **Conditional cost data.** `contextEstimate` comes from `usage_update` and
  token counts from the `session/prompt` response. If Devin ever sends a
  `usage_update.cost` payload, its USD amount lands on `turnComplete.costUsd`;
  otherwise `costUsd` stays `null`.
