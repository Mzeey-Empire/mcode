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
| Claude | native: SDK `permissionMode: plan` [C3] | native: `ExitPlanMode.plan` equals the entire written file [C3] | native: `AskUserQuestion` reaches `canUseTool`; denying reply captured [C1] | native: `ExitPlanMode.planFilePath` matches the Write path and existing file in the same session [C3] | fence-only: all four checks true [CF] | CLI **2.1.293**, SDK **0.3.291**; minimum unknown, no historical-version validation |
| Codex | native: accepted `turn/start.collaborationMode` and completed turn [X] | native: `item/plan/delta` and completed `plan` item [X] | native: ordinary/free-text answers, decline, error cancellation, interrupt and process-exit traces [XQ] [XF] [XD] [XC] [XI] [XE] | unsupported in the measured conversation-only path: no plan path event or plan file in the eight runs; not a universal absence guarantee [X] | fence-only: all four checks true [XX] | CLI **0.161.0**, `gpt-6.1-sol` selected from `model/list`; minimum unknown |
| Cursor | native: acknowledged ACP `session/set_mode` with `modeId: plan`, then plan request [CU] | native: `cursor/create_plan.plan`; cancelled/rejected replies end without implementation [CU] [CUR] | unknown: live questions with Auto and Composer 2.5 produced prose, no `cursor/ask_question` [CUQ] [CUQ2] | unknown: request contains no plan-file path; non-accepting replies wrote no plan [CU] | fence-only: all four checks true [CUF] | CLI **2026.04.29-c83a488**, ACP **1**; minimum unknown |
| Copilot | native: `mode.set({mode: plan})` resolves and `session.mode_changed` reports `newMode: plan` [P3] | native **read API**: `session.rpc.plan.read()` returns `exists=true`, string content, and a path [P3]. A distinct plan event remains unknown | native: SDK `onUserInputRequest` supplies question/choices; the freeform reply and continued turn are captured [PQ] | native identity proved: the API path exists inside the run, and its directory name equals `session.sessionId` [P3] | fence-only: all four checks true [PF] | CLI **1.0.83**, SDK **0.2.2**, reported protocol **3** [P3]; minimum unknown, no older-version compatibility gate proved |
| Devin | native: ACP `session/set_config_option`, `configId: mode`, `value: plan`; reply reports current value `plan` [D] | fence-only: plan text appeared as message chunks; no dedicated native plan output established [D], fallback [DF] | unknown: the requested clarification produced message chunks, not an observed native question request [DQ] | unknown: no event tied a plan file to this session [D]; no mutation authorized | fence-only: all four checks true [DF] | CLI **3000.11.3**, negotiated ACP **1** [D]; minimum unknown, no historical-version validation |
| OpenCode | native: `prompt_async` accepts `agent: plan` with HTTP 204; returned messages name that agent [OC] | fence-only: text response, no dedicated plan event measured [OC] [OCF] | native: `question.asked`, answer API HTTP 200, `question.replied`, then idle [OCQ] | unknown: no native session plan path proved; bounded file probe described below [OC] | fence-only: all four checks true [OCF] | CLI/server **1.18.28**, HTTP API unversioned; minimum unknown |

No row establishes filesystem read-only enforcement. Selecting a mode and
observing planning behavior does not prove that every write path is blocked.

## Codex details

The initial `unknown` rows were probe artifacts. Removing `sqlite_home` and
`mcp_servers={}` restored initialization. Session state in the normal Codex home
is permitted; the probe retains `ephemeral: true` and run-local `log_dir`.
`model/list` returned `gpt-6.1-sol` as the default, and actual turns completed on it.
The stale `s07-codex-03` timeout fixture was removed.

| Required question | Decision and evidence |
|---|---|
| Exact accepted `turn/start.collaborationMode`, `developer_instructions`, and `additionalContext` | native: `{mode:"plan",settings:{model:"gpt-6.1-sol",reasoning_effort:"low",developer_instructions:null}}`, `additionalContext:{}`. Reply status `inProgress`, then completed plan [X]. An array for additionalContext was rejected with -32600 in raw run `r1-codex-plan` |
| Completed `plan` item and `item/plan/delta` | native: string `delta`; completed item `{type:"plan",id,text}` [X] |
| Native question request and ordinary answer | native: `item/tool/requestUserInput` carries threadId, turnId, itemId, questions with id/header/question/isOther/isSecret/options, isBlocking and autoResolutionMs. Response `{answers:{[questionId]:{answers:["Brief"]}}}` resolves the request and produces a plan [XQ] |
| Free-text answer | native: the same response with `answers:["Use a cheerful greeting."]`, outside the listed options; request resolves and plan completes [XF] |
| Decline response | native measured candidate: `answers:[]` per question; request resolves, model replies in prose, turn completes [XD]. This is not a dedicated decline protocol literal |
| Cancel response | native measured JSON-RPC error `{code:-32800,message:"Probe cancelled"}`; request resolves and turn completes with prose [XC]. It does not itself interrupt the turn |
| `turn/interrupt` while a question waits | native: acknowledged request with threadId/turnId, `serverRequest/resolved`, terminal status `interrupted`; no answer reply was sent [XI] |
| Process exit while a question waits | native observed lifecycle: owned child killed with a pending question; process exits SIGTERM, no question reply or turn/completed appears [XE]. The request cannot outlive its connection |
| No plan file expected | no plan path in the captured plan/question events, no plan file in run/fixture snapshots, no changed global plans in any of the eight scenarios. No file mutation path established |
| Minimum version for each capability | unknown; tested 0.161.0 only. Successful current captures do not establish an older-version gate |

The runner now creates an empty aggregate stderr file immediately and one stderr
file per spawned child, even when the child exits silently. SDK-spawned Claude
also uses that recorder. Tests exercise a failing child with stderr and a silent
failing child. No existing provider process was killed.

## Claude details

The probe uses normal sign-in, SDK `permissionMode: "plan"`, `persistSession: false`,
and a run-local settings file. Shell tools are not offered. Both `PreToolUse` and
`canUseTool` allow Write only inside this run's plansDirectory. `ExitPlanMode`
is denied after capture, so the probe never authorizes implementation.

Root cause of [C2]: no Write was attempted, so neither permission path denied one.
The model reported a conflict between the requested directory and its assigned
home-folder plan path. The reruns exposed why: CLI debug reports
`plansDirectory must be within project root`. Both an absolute sibling path and
a relative `../provider-homes/...` override fail that constraint. The probe now
uses `.dev/fixture-repo/.claude/plans/<run>/`, the permitted fixture-root fallback.
The settings file stays under `.dev/provider-homes/claude/<run>/`.

In `r1-claude-plan-03`, the model attempted a Write in the run root but outside
its plansDirectory, then attempted a home path; the hook denied both. In
`r1-claude-file`, it wrote an explicitly requested run-local file, but the native
assigned path was still the home path and ExitPlanMode input stayed empty.
These are diagnostic runs, not native-file claims.

With the valid in-project override, [C3] shows a Write with session_id and exact
file_path, then `ExitPlanMode` permission input with `plan` and `planFilePath`.
The same path exists after the turn and uses one alias in the sanitized trace;
`probe/file.sessionId` matches the Write hook's session. `matchesWrittenPlan=true`
compares the complete ExitPlanMode plan against that file's bytes. At this build,
a correctly located native plan file supplies the full payload; the empty [C2]
input must not be used to reject the native path. [CF] still proves the fallback.

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

## Cursor results

Cursor was absent from PATH but runnable through the permitted discovery folder,
`{userHome}/AppData/Local/cursor-agent/versions/2026.04.29-c83a488/`.
The launcher runs `node.exe index.js acp`, negotiates ACP 1 and acknowledges
`session/set_mode {sessionId,modeId:"plan"}`. `cursor/create_plan` supplies
`toolCallId`, `name`, `overview`, **`plan`**, `todos`, `isProject`, and `phases`.
It supplies neither `markdown` nor a plan-file path. The toolCallId links it to
that session's updates. A source-file link inside plan prose is not plan identity.

| Fresh session | Candidate reply | Subsequent behavior |
|---|---|---|
| `r1-cursor-plan-02` [CU] | `{outcome:{outcome:"cancelled",feedback:"Keep this plan for review. Do not implement."}}` | model reports cancellation before saving; prompt returns `end_turn`; no plan or source writes |
| `r1-cursor-rejected` [CUR] | same wrapper with `outcome:"rejected"` | model reports rejection, offers revision, returns `end_turn`; no plan or source writes |
| `r1-cursor-feedback` [CUB] | same wrapper with `outcome:"feedback"` | model reports cancellation; `end_turn`; no writes. This is not a distinct supported feedback outcome |

Read-only inspection of the installed `7414.index.js` corroborates the live
results: accepted is success, rejected consumes `outcome.reason`, and every
other outcome becomes cancellation. `feedback` is an ignored candidate field,
not a supported revision API. Do not return a method-not-found error to decline
a plan: the installed client has a local file fallback on extension errors.

The first live run changed `.cursor/cli-config.json`. Inspection then found the
CLI's `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` overrides. Subsequent runs used
`{providerHome}/config` and `{providerHome}/data` with normal sign-in, without
copying credentials. No subsequent audited config or global plan changed.
The first global config mutation is a hygiene failure, retained below.

Native questions remain unknown after three live prompts, including an explicit
`ask_question` prompt and a Composer 2.5 selection from the account's model list
[CUQ] [CUQ2]. These turns emitted prose and no native request. Installed code
contains a candidate `{toolCallId,title,questions:[{id,prompt,options:[{id,label}],allowMultiple}]}`
shape and `answered`/`skipped` responses, but that is source evidence only.
No captured native-question claim is made. The bounded experiments stopped here,
before the half-day ceiling, without changing the production adapter.

## OpenCode results

The installed executable runs `serve --hostname 127.0.0.1 --port 0` with cwd set
to the fixture repo. The runner uses the address printed by its owned child.
Normal authentication and session storage remain in the normal provider home;
no auth-containing directory is relocated. `GET /global/health` reports 1.18.28.

`POST /session/<id>/prompt_async` with `{agent:"plan",parts:[{type:"text",text:...}]}`
returns 204. SSE events then deliver the turn, and `GET /session/<id>/message`
returns user/assistant messages with `info.agent:"plan"` [OC]. Native questions
arrive as `question.asked` with `properties.sessionID`, `id`, `questions` containing
header/question/options, and `tool.messageID/callID`. The probe replies through
`POST /question/<id>/reply {answers:[["Brief"]]}`; HTTP 200/true is followed by
`question.replied` and `session.idle` [OCQ]. The fence is exact [OCF].

`r1-opencode-file-03` [OCFILE] explicitly requests the native session plan file
under `.dev/fixture-repo/.opencode/plans`. The model reads the fixture, finds no
such file, and returns prose. Neither the SSE stream nor message API identifies
a session-owned plan file. This remains unknown, not proof that the server can
never produce one. No native file mutation is authorized by this evidence.

Diagnostic run `r1-opencode-plan` completed its turn but initially reported blocked
because cleanup cancelled an already aborted SSE reader. Cleanup now ignores only
that expected AbortError. `r1-opencode-file-02` hit two external-directory requests:
rejecting the first returned 200, rejecting the second returned 404
`PermissionNotFoundError`. That failed experiment is retained raw, not used as a
native identity claim. The final fixture-only probe completed without permissions.
No provider exceeded its half-day ceiling; historical version minima remain unknown.

## Reproduction

Run from the repository root after the lockfile-pinned dependencies are installed.
Use an already authenticated normal CLI. Do not change `HOME`, copy credentials,
sign in/out, update a CLI, or edit global config. The committed entrypoint computes
paths from its own location and rejects a reused run ID. Raw files remain under
`packages/providers/.conformance-raw/plan/<run>/`; provider destinations are under
`.dev/provider-homes/<provider>/<run>/` where supported; working directory is
`.dev/fixture-repo`. Claude's validated plansDirectory is inside that fixture repo.

```powershell
bun packages/providers/src/conformance/plan-probes/probe.ts capture claude fence --run repro-claude-fence --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture codex plan --run repro-codex-plan --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture cursor plan --run repro-cursor-plan --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture copilot plan --run repro-copilot-plan --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture devin fence --run repro-devin-fence --timeout-ms 120000
bun packages/providers/src/conformance/plan-probes/probe.ts capture opencode questions --run repro-opencode-questions --timeout-ms 120000
```

For Claude/Copilot/Devin questions, substitute `questions` and a new run ID. For
their native-mode experiment, substitute `plan`. All six accept `fence`.
Claude's file-identity proof uses `file-identity`. Cursor's other candidate replies
use `plan-rejected` and `plan-feedback`, each in a fresh process/session.
Codex also accepts `questions-free-text`, `questions-decline`,
`questions-cancel`, `questions-interrupt`, and `questions-process-exit` experiments.
All eight Codex scenarios ran in this fix round. The default model is discovered
through `model/list` for each run, not hard-coded to an unavailable model.

The exact CLI version commands are `claude --version`, the resolved native Codex
binary with `--version`, Cursor's discovered `node.exe index.js --version`,
`node <installed @github/copilot/npm-loader.js> --version`, `devin --version`, and
the installed `opencode.exe --version`. SDK versions come from the installed
packages, not semver ranges. SDK traces are explicitly SDK-level; probe-assigned
exchange IDs are not presented as wire IDs.

Inspect `messages.jsonl`, `metadata.json`, `stderr.log`, `child-*.stderr.log`, and
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

The initial implementation runs reported no audited config or global-plan changes.
Fix round 1 has one exception: `r1-cursor-plan` changed `.cursor/cli-config.json`
before the CLI overrides were discovered. That is a failed hygiene result, not a
clean run. No global plan changed in any new run. The global config was neither
restored nor deleted. Subsequent Cursor runs use the overrides and audit cleanly.
Claude plans now also exist inside `.dev/fixture-repo/.claude/plans/<run>/`, and
one diagnostic plan exists at `.dev/provider-homes/claude/r1-claude-file/plans/greet-plan.md`.
No source files were written in the fixture.
Plan-folder snapshots covered Claude, Cursor, Copilot, Devin's discovered/default
locations, and OpenCode. They compare file hashes, not just filenames.

The initial audit hashed six existing global files and recorded three absent
files. The final audit also includes two existing Windows Devin state/config
files. The compared paths are `.codex/config.toml`,
`.claude/settings.json`, `.claude/settings.local.json`, `.cursor/cli-config.json`,
`.copilot/config.json`, `.copilot/mcp-config.json`, `.config/devin/config.json`,
`.config/opencode/opencode.json`, `.config/opencode/opencode.jsonc`, and Windows
Devin's `cli/trusted_workspaces.json` and `cli/app_state.json`. Absent files stayed
absent. Full before/after digests and file inventories are in each run's local `hygiene.json`.

Every new run below recorded `allSpawnedExited=true`. Empty audit lists are shown
as `[]`. Bookkeeping is the separately measured `~/.claude.json` hash, not a
provider attribution; overlapping runs can observe the same normal CLI update.

| New run | changedConfigs | changedGlobalPlans | bookkeepingChanged |
|---|---|---|---|
| r1-codex-plan | [] | [] | false |
| r1-codex-plan-02 | [] | [] | false |
| r1-codex-questions | [] | [] | false |
| r1-codex-questions-free-text | [] | [] | false |
| r1-codex-questions-decline | [] | [] | false |
| r1-codex-questions-cancel | [] | [] | false |
| r1-codex-questions-interrupt | [] | [] | false |
| r1-codex-questions-process-exit | [] | [] | false |
| r1-codex-fence | [] | [] | false |
| r1-claude-plan | [] | [] | true |
| r1-claude-plan-02 | [] | [] | true |
| r1-claude-plan-03 | [] | [] | true |
| r1-claude-file | [] | [] | true |
| r1-claude-file-02 | [] | [] | true |
| r1-claude-file-03 | [] | [] | true |
| r1-cursor-plan | [.cursor/cli-config.json] | [] | false |
| r1-cursor-rejected | [] | [] | true |
| r1-cursor-feedback | [] | [] | false |
| r1-cursor-questions-02 | [] | [] | true |
| r1-cursor-fence-02 | [] | [] | false |
| r1-cursor-plan-02 | [] | [] | false |
| r1-cursor-questions-03 | [] | [] | false |
| r1-cursor-questions-04 | [] | [] | true |
| r1-opencode-plan | [] | [] | false |
| r1-opencode-questions | [] | [] | false |
| r1-opencode-fence | [] | [] | false |
| r1-opencode-file-identity | [] | [] | true |
| r1-opencode-file-02 | [] | [] | false |
| r1-opencode-file-03 | [] | [] | true |

`~/.claude.json` changed during normal CLI use. It is reported separately as
`bookkeepingChanged=true`, under the chosen design's explicit exception, not
hidden among unchanged config files. Some provider runs overlapped, so that flag
does not attribute the bookkeeping write to each provider. No config contents or
credentials were copied, printed, or committed. Codex and OpenCode may keep normal
session state in their standard homes under the user's explicit exception. Claude
SDK hook transcripts name its normal `~/.claude/projects/<fixture-slug>/` location;
plan writes are separately constrained and audited. Cursor's final config, data,
and compile cache are all beneath its provider run directory.

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
one row per provider. The live results above replace the earlier preflight blockers.
This acceptance step must remain open until the independent report exists.

Before consumer implementation, the parent should copy these applicable findings
into S07-02 and S07-12 through S07-14. No issue comments were sent by this task.

- S07-02: Codex 0.161.0 accepts the captured collaboration mode with an object
  additionalContext. Plan items, questions, answer variants and termination paths
  are captured. An older-version activation gate remains unproved.
- S07-12: Claude 2.1.293 supplies the full plan and planFilePath after a native
  file exists. The exact session/path identity is proved in [C3]. Use a valid
  in-project plansDirectory; the earlier empty payload came from a broken override.
- S07-13: Cursor sends `plan`; `cancelled` and `rejected` end without implementation.
  `feedback` maps to cancellation, not revision. Native questions/file identity
  remain unproved. Copilot SDK 0.2.2
  has a proved plan read API and session-bound file at CLI 1.0.83/protocol 3, plus
  native questions. Do not assume a write permission callback at 1.0.83 or require
  an SDK bump on the basis of the older 1.0.56 trace.
- S07-14: Devin plan selection is acknowledged and its fence works; native
  questions and file identity are unknown. OpenCode 1.18.28 accepts `agent: plan`
  on prompt_async and has captured native questions and a verified fence. Its
  native plan-file identity remains unknown; do not delete guessed plan files.

[C1]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-01.captured.json
[C2]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-02.captured.json
[CF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-claude-fence-01.captured.json
[C3]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-claude-file-03.captured.json
[X]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-plan-02.captured.json
[XQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions.captured.json
[XF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions-free-text.captured.json
[XD]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions-decline.captured.json
[XC]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions-cancel.captured.json
[XI]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions-interrupt.captured.json
[XE]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-questions-process-exit.captured.json
[XX]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-codex-fence.captured.json
[CU]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-plan-02.captured.json
[CUR]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-rejected.captured.json
[CUB]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-feedback.captured.json
[CUQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-questions-03.captured.json
[CUQ2]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-questions-04.captured.json
[CUF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-cursor-fence-02.captured.json
[P1]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-01.captured.json
[P2]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-02.captured.json
[P3]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-03.captured.json
[PQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-questions-01.captured.json
[PF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-copilot-fence-01.captured.json
[D]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-01.captured.json
[DQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-questions-01.captured.json
[DF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/s07-devin-fence-01.captured.json
[OC]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-opencode-file-identity.captured.json
[OCQ]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-opencode-questions.captured.json
[OCF]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-opencode-fence.captured.json
[OCFILE]: ../../packages/providers/src/conformance/fixtures/plan-protocol/r1-opencode-file-03.captured.json
