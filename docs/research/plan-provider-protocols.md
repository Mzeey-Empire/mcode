# Plan provider protocols

S07-00, issue #1834. Captured on Windows on 2026-10-08, on `feat/issue-1834`.
This is a point-in-time investigation. It changes no adapter, product contract,
factory capability, UI, dependency, or package export.

## Decision table

`native` means a received provider message or SDK result supports the claim.
`fence-only` means the tested fallback worked and this investigation does not
authorize native capture. `unknown` is an unresolved capability, not evidence
that a provider lacks it. There are no proved minimum versions in this pass.
An unknown native path must remain fence capture with no native file mutation.
Where the fence itself is unknown, this is a consumer policy, not a tested promise.

| Provider | Plan-mode selection | Native plan output | Native questions | Session-bound plan file | Four-backtick fence | Tested version and minimum |
|---|---|---|---|---|---|---|
| Claude | native: SDK `permissionMode: plan`, followed by `ExitPlanMode` [C2] | fence-only: the observed `ExitPlanMode` input has no `plan`; `hasPlan=false` [C2], fallback [CF] | native: `AskUserQuestion` reaches `canUseTool`; the denying reply is captured [C1] | unknown: no session-bound file was reported or created in these turns [C2]; no rewrite authorized | fence-only: all four checks true [CF] | CLI **2.1.293**, SDK **0.3.291** [C2]; minimum unknown, no historical-version validation |
| Codex | unknown: initialization did not reply within 60 seconds in the final diagnostic run [X] | unknown: no turn was admitted [X] | unknown: no turn was admitted [X] | unknown: cannot confirm the expected absence without an admitted turn [X] | unknown: no prompt reached the model [X] | CLI **0.161.0** [X]; minimum unknown because initialization was blocked |
| Cursor | unknown: stopped before a plan turn because no safe plan-write interception or storage override was established [CU] | unknown: containment blocker [CU] | unknown: containment blocker [CU] | unknown: containment blocker [CU]; no rewrite authorized | unknown: no model prompt sent [CU] | CLI **2026.04.29-c83a488** measured by the discovered launcher; ACP unknown; minimum unknown [CU] |
| Copilot | native: `mode.set({mode: plan})` resolves and `session.mode_changed` reports `newMode: plan` [P3] | native **read API**: `session.rpc.plan.read()` returns `exists=true`, string content, and a path [P3]. A distinct plan event remains unknown | native: SDK `onUserInputRequest` supplies question/choices; the freeform reply and continued turn are captured [PQ] | native identity proved: the API path exists inside the run, and its directory name equals `session.sessionId` [P3] | fence-only: all four checks true [PF] | CLI **1.0.83**, SDK **0.2.2**, reported protocol **3** [P3]; minimum unknown, no older-version compatibility gate proved |
| Devin | native: ACP `session/set_config_option`, `configId: mode`, `value: plan`; reply reports current value `plan` [D] | fence-only: plan text appeared as message chunks; no dedicated native plan output established [D], fallback [DF] | unknown: the requested clarification produced message chunks, not an observed native question request [DQ] | unknown: no event tied a plan file to this session [D]; no mutation authorized | fence-only: all four checks true [DF] | CLI **3000.11.3**, negotiated ACP **1** [D]; minimum unknown, no historical-version validation |
| OpenCode | unknown: no safe plan/session storage override preserving normal authentication was established during preflight [OC] | unknown: containment blocker [OC] | unknown: containment blocker [OC] | unknown: containment blocker [OC]; no deletion authorized | unknown: no model prompt sent [OC] | CLI **1.18.28** measured by the installed executable; server protocol unknown; minimum unknown [OC] |

No row establishes filesystem read-only enforcement. Selecting a mode and
observing planning behavior does not prove that every write path is blocked.

## Codex details

The final captured request is `initialize`, with an experimental API capability.
There is no reply. The fixture keeps it pending and ends with `timeout`; it does
not manufacture a turn, a plan item, or a cancellation response.

| Required question | Decision and evidence |
|---|---|
| Exact accepted `turn/start.collaborationMode`, `developer_instructions`, and `additionalContext` | unknown, initialization blocker [X]. Fields in `codex.ts` are candidates, not received evidence |
| Completed `plan` item and `item/plan/delta` | unknown, no turn admitted [X] |
| Native question request and ordinary answer | unknown, no turn admitted [X] |
| Free-text answer | unknown, no turn admitted [X] |
| Decline response | unknown, no turn admitted [X] |
| Cancel response | unknown, no turn admitted [X] |
| `turn/interrupt` while a question waits | unknown, no turn admitted [X] |
| Process exit while a question waits | unknown, no question observed [X]. The captured process exit is probe cleanup, not that scenario |
| No plan file expected | unknown, no turn admitted [X] |
| Minimum version for each capability | unknown, no successful native experiment or version bisect |

The first attempt through the npm wrapper also did not initialize. Its final
filesystem audit tried to read a locked SQLite maintenance file and failed;
that incomplete attempt is not a committed fixture. The runner now hashes
Markdown files and records size/mtime for other state files. The second attempt
used the exact native executable and waited 180 seconds. The final attempt
added explicit `--stdio`, retained run-local SQLite/log directories, and waited
60 seconds. No initialization response or decisive stderr diagnostic arrived.
All three processes were owned by the probe; no existing Codex process was killed.
The cause remains unknown. These failures do not prove the CLI lacks plan mode.

## Claude details

The probe uses normal sign-in, the installed CLI, SDK `permissionMode: "plan"`,
`settingSources: []`, `persistSession: false`, and a per-run
`settings.plansDirectory`. Shell tools are not offered. A `PreToolUse` hook denies
a Write outside the fixture or provider run. `ExitPlanMode` is denied after capture.

In [C2], the native tool appeared in both the hook and permission callback with
an empty input. `probe/exit-plan` records `hasPlan=false` and `nonemptyPlan=false`.
No plan file appeared. This is evidence against relying on the brief's proposed
`ExitPlanMode.plan` payload at the tested build, not a proof that every Claude
planning workflow lacks a plan file. The fallback fence succeeded [CF].

[C1] used the initial short greeting-plan prompt and unexpectedly asked a native
question. That is a real captured question/denial exchange. The committed
`questions` scenario explicitly asks for a native question; the final `plan`
prompt supplies the filename, signature, greeting, and instruction not to ask
questions. These prompts differ intentionally. No assistant prose is committed.

The SDK boundary is recorded as `claude-sdk-unversioned`, qualified by the exact
CLI and SDK builds. No independent wire-version handshake was captured.

## Copilot details

The SDK's session `configDir` placed state at
`{providerHome}/session-state/{sessionId}/`. The normal launcher is
`@github/copilot/npm-loader.js`. In [P3], `status.get` through `client.getStatus()`
returned CLI `1.0.83` and protocol `3`. SDK `0.2.2` already exposes mode selection,
native questions, and the plan read API. This does not establish a minimum SDK.

The plan read is captured as an SDK request/reply pair associated with the same
session object used to send the turn. Its returned path and the actual file use
the same sanitized path alias. `probe/file` records `exists=true`, `insideRun=true`,
and `sessionDirectoryMatches=true`. This is an API-to-file identity observation,
not a newest-file heuristic. It does not test overwriting or deleting the plan.

No `onPermissionRequest` callback accompanied the successful plan write at CLI
1.0.83 in [P2] or [P3]. Do not assume that the proposed plan-mode permission
exception is the path this build uses. A distinct plan event was not established.
The SDK read API is the proved capture path.

An earlier probe accidentally resolved the retained legacy `index.js` entrypoint.
Its own version output was **1.0.56**, not 1.0.83. The [P1] fixture labels this
exactly. That build requested `kind: write`, `fileName`, `toolCallId`, a diff and
new file contents. The initial probe checked `path` instead of `fileName`, so it
denied the write; `plan.read().exists` was false. The final probe checks the
observed `fileName` and uses the normal launcher. [P1] proves that older request
shape, not 1.0.83 behavior or a minimum version. No global CLI was installed.

The earlier SDK-level captures use `copilot-sdk-unversioned` to identify their
capture boundary; they did not record wire negotiation. [P3] supplies the explicit
status request/reply. Native question and fence observations at 1.0.83 are [PQ]
and [PF]. The question reply contains an `answer` string and `wasFreeform: true`.

## Devin details

`initialize` negotiates ACP 1. `session/new` creates a fixture-repository session.
The request `session/set_config_option { sessionId, configId: "mode", value: "plan" }`
receives `configOptions[0].id=mode` and `currentValue=plan` [D]. Permission requests
are answered with `{ outcome: { outcome: "cancelled" } }`. The observed plan is
ordinary agent message chunks. In the question scenario, the provider asks in
message text without a native question request [DQ]. Absence in this constrained
experiment remains `unknown`, not `unsupported`.

The probe tried `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` under its run
directory. These did not redirect Windows Devin session storage: the run directory
remained empty. The installed CLI keeps normal session state under
`{userHome}/AppData/Roaming/devin/cli/`, including its sessions database and logs.
No separate usable session-state override was established. No plan file was
observed there or in the fixture. These normal state writes are not global config
edits. `trusted_workspaces.json` and `app_state.json` had modification times before
this investigation; they were also added to subsequent hash audits.

## Cursor and OpenCode stopping points

Cursor was absent from PATH but runnable through the permitted discovery folder,
`{userHome}/AppData/Local/cursor-agent/versions/2026.04.29-c83a488/`.
Its help advertises `--mode plan` and `--plan`. Help alone does not prove ACP plan
behavior, a safe plan-file destination, or any `cursor/create_plan` outcome.
No safe override or interception for its native plan write was established.
The probe stops before creating a session and saves version/help output locally.
Therefore `markdown` versus `plan`, native `ask_question`, session/file identity,
and **every non-accepting outcome and subsequent behavior** remain unknown.
S07-01 must not call this a captured Cursor key fix.

OpenCode's installed `serve --help` did not establish a separate safe plan/state
override while preserving authentication in the normal data home. This run did
not move or copy the auth-containing data home and did not start the server.
Whether `prompt_async` accepts `agent: "plan"`, the native question protocol,
and any API naming a session's `.opencode/plans` file remain unknown. A future
investigation must establish containment before sending a planning prompt.

These are safety stops before the half-day ceiling, not claims that four hours
were spent on each provider. No provider exceeded that ceiling. Version minima
were not investigated with historical installs; no minimum is inferred from the
installed build. No plan file was observed escaping an override. If a future run
reports one in `changedGlobalPlans`, stop that capability and name the file;
do not delete it or retry the capability.

## Reproduction

Run from the repository root after the lockfile-pinned dependencies are installed.
Use an already authenticated normal CLI. Do not change `HOME`, copy credentials,
sign in/out, update a CLI, or edit global config. The committed entrypoint computes
paths from its own location and rejects a reused run ID. Raw files remain under
`packages/providers/.conformance-raw/plan/<run>/`; provider destinations are under
`.dev/provider-homes/<provider>/<run>/`; working directory is `.dev/fixture-repo`.

```powershell
bun packages/providers/src/conformance/plan-probes/probe.ts capture claude fence --run repro-claude-fence --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture codex plan --run repro-codex-init --timeout-ms 60000
bun packages/providers/src/conformance/plan-probes/probe.ts capture cursor plan --run repro-cursor-preflight --timeout-ms 30000
bun packages/providers/src/conformance/plan-probes/probe.ts capture copilot plan --run repro-copilot-plan --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture devin fence --run repro-devin-fence --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture opencode plan --run repro-opencode-preflight --timeout-ms 30000
```

For Claude/Copilot/Devin questions, substitute `questions` and a new run ID. For
their native-mode experiment, substitute `plan`. All six accept `fence`, but Cursor
and OpenCode currently stop at preflight for every scenario. The Codex module
also contains candidate `questions-free-text`, `questions-decline`,
`questions-cancel`, `questions-interrupt`, and `questions-process-exit` experiments.
None passed initialization here; their candidate payloads are not protocol findings.

The exact CLI version commands are `claude --version`, the resolved native Codex
binary with `--version`, Cursor's discovered `node.exe index.js --version`,
`node <installed @github/copilot/npm-loader.js> --version`, `devin --version`, and
the installed `opencode.exe --version`. SDK versions come from the installed
packages, not semver ranges. SDK traces are explicitly SDK-level; probe-assigned
exchange IDs are not presented as wire IDs.

Inspect `messages.jsonl`, `metadata.json`, `stderr.log` when present, and
`hygiene.json` before opting into sanitization. The sanitizer refuses unknown
operations/literals, path escapes, and existing output files. It retains finite
field shapes, control values, aliases, and computed booleans. Known telemetry
events are omitted and consecutive identical event observations collapse, as
declared in `fixture.ts`. Unknown event kinds stop projection. Private text,
dynamic question keys, tool output, real IDs, and paths never survive projection.
Hashes cover sanitized input, not raw authenticity. Review and independent
reproduction still matter.

```powershell
bun packages/providers/src/conformance/plan-probes/probe.ts sanitize repro-copilot-plan --reviewed
bun run --cwd packages/providers test -- src/conformance/__tests__/conformance.test.ts
bun run --cwd packages/providers typecheck
```

The fence challenge in `runtime.ts` asks for exactly four backticks around an
`mcode-plan` block containing an ordinary triple-backtick TypeScript block. The
recorded `exact` check trims only surrounding whitespace before comparing the
whole response; opener, closer, and nested-block checks are also stored separately.

Cleanup runs automatically on completion, failure, or timeout. SDK sessions use
their owned close/stop methods. Spawned CLI handles are the only process roots
passed to `taskkill /PID <owned-pid> /T /F`; no process-name matching occurs.
No command removes provider plan files or global files. Inspect the local raw
`processes.jsonl` and `hygiene.json` when a cleanup fails. Never treat missing
metadata or an incomplete audit as a successful capture.

## Filesystem and configuration audit

All finalized runs reported `changedConfigs=[]` and `changedGlobalPlans=[]`.
The only observed plan files were Copilot `plan.md` files below the run's
`session-state/<sessionId>/` directory. No source files were written in the fixture.
Plan-folder snapshots covered Claude, Cursor, Copilot, Devin's discovered/default
locations, and OpenCode. They compare file hashes, not just filenames.

The initial audit hashed six existing global files and recorded three absent
files. The final audit also includes two existing Windows Devin state/config
files. Every compared hash matched. The paths are `.codex/config.toml`,
`.claude/settings.json`, `.claude/settings.local.json`, `.cursor/cli-config.json`,
`.copilot/config.json`, `.copilot/mcp-config.json`, `.config/devin/config.json`,
`.config/opencode/opencode.json`, `.config/opencode/opencode.jsonc`, and Windows
Devin's `cli/trusted_workspaces.json` and `cli/app_state.json`. Absent files stayed
absent. Full before/after digests are in each run's local `hygiene.json`.

`~/.claude.json` changed during normal CLI use. It is reported separately as
`bookkeepingChanged=true`, under the chosen design's explicit exception, not
hidden among unchanged config files. Some provider runs overlapped, so that flag
does not attribute the bookkeeping write to each provider. No config contents or
credentials were copied, printed, or committed.

```powershell
git status --short --branch
git -C .dev/fixture-repo status --short
Get-ChildItem .dev/provider-homes,.dev/fixture-repo -Recurse -File -Filter *.md |
  Where-Object { $_.Name -eq 'plan.md' -or $_.FullName -match '[\\/]plans[\\/]' } |
  Select-Object FullName
Get-ChildItem packages/providers/.conformance-raw/plan/*/hygiene.json |
  ForEach-Object { $h = Get-Content $_ -Raw | ConvertFrom-Json; [pscustomobject]@{
    Run = $_.Directory.Name; ChangedConfigs = $h.changedConfigs.Count;
    ChangedGlobalPlans = $h.changedGlobalPlans.Count;
    BookkeepingChanged = $h.bookkeepingChanged; SpawnedExited = $h.allSpawnedExited
  } }
```

## Independent reproduction and consumer decisions

Independent reproduction is **pending**, owned by the parent workflow under the
chosen design. The implementation agent's repeated runs are not an independent
review. A second agent should run the six commands above with fresh IDs, checking
one row per provider. For Codex, Cursor, and OpenCode, this can reproduce a blocker;
it cannot turn the blocked native capability into a pass. This acceptance step
must remain open until that report exists.

Before consumer implementation, the parent should copy these applicable findings
into S07-02 and S07-12 through S07-14. No issue comments were sent by this task.

- S07-02: all native Codex payloads, question outcomes, and version gates remain
  unknown. Do not activate the proposed native path from this investigation.
- S07-12: the observed Claude `ExitPlanMode` input is empty. Keep the verified
  fence; native file identity is unproved. Native question presence is captured.
- S07-13: Cursor's key and rejection outcomes remain unknown. Copilot SDK 0.2.2
  has a proved plan read API and session-bound file at CLI 1.0.83/protocol 3, plus
  native questions. Do not assume a write permission callback at 1.0.83 or require
  an SDK bump on the basis of the older 1.0.56 trace.
- S07-14: Devin plan selection is acknowledged and its fence works; native
  questions and file identity are unknown. OpenCode remains blocked by containment.

[C1]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-01.captured.json
[C2]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-02.captured.json
[CF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-fence-01.captured.json
[X]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-codex-03.captured.json
[CU]: ../../packages/providers/src/conformance/plan-probes/cursor.ts
[P1]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-01.captured.json
[P2]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-02.captured.json
[P3]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-03.captured.json
[PQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-questions-01.captured.json
[PF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-fence-01.captured.json
[D]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-01.captured.json
[DQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-questions-01.captured.json
[DF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-fence-01.captured.json
[OC]: ../../packages/providers/src/conformance/plan-probes/opencode.ts
