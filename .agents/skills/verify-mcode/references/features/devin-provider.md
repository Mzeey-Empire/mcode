# Devin provider over local ACP

## Sub-features
- Enabling Devin (beta, default disabled) with an installed `devin` CLI starts threads on the Devin provider; `provider.cli.devin` covers off-PATH installs.
- Each thread owns one long-lived `devin acp` process behind the shared `AcpSessionRuntime`; sessions resume across idle eviction and restart through `session/load`.
- Auth is headless: the adapter resolves `WINDSURF_API_KEY` / `DEVIN_API_KEY` / `windsurf_api_key` env vars or `credentials.toml` and calls ACP `authenticate` (`methodId: "windsurf-api-key"`, `_meta.headless`). A failed authenticate fails that turn only.
- Models come from `session/new` `configOptions` with a static fallback; effort is part of the wire model id (`swe-2` + `high` -> `swe-2-high`). Model and mode changes apply through `session/set_config_option` without a respawn.
- Devin's flattened mode axis (Normal / Accept Edits / Smart / Bypass) renders in the shared Access Mode control and persists as `threads.devin_mode`; Plan interaction mode sends `plan` and restores the prior native mode.
- Permission prompts render Devin's real options; `switch_bypass` updates the thread's `devin_mode` so the composer reflects the mode Devin entered. `allow_always_global` is hidden.
- Usage reporting is tokens only: `usage_update` drives `contextEstimate`, the `session/prompt` response fills `turnComplete` tokens, and `costUsd` stays `null`.
- Handoff uses the history-replay side channel (path B-prime); Devin has no session-fork API.
- On Windows there is no OS sandbox: `full` maps to unsandboxed Bypass.

## How to get to it (user POV)

1. Install and authenticate the `devin` CLI (`devin auth login`, or set `WINDSURF_API_KEY`).
2. Enable Devin in Settings > Providers.
3. Open a thread on the Devin provider, pick a model and access mode, send a prompt, watch the reply stream.
4. Answer a permission prompt in a non-Bypass mode and confirm the settled card shows the option you picked.
5. Switch to Plan, send a planning prompt, return to Build, and confirm the prior access mode restores.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider devin --model <devin-model-id> --scenario completion --confirm-provider-call --allow-enable-devin
```

Devin defaults to disabled; `--allow-enable-devin` enables it through `settings.update` for the proof and restores the original setting on every terminal path. Completion requires `turnComplete` or `ended`, then a durable assistant message in `conversation.page` and `message.list`. The receipt omits assistant text and provider-private payloads. The `--scenario stop` variant proves `session/cancel` teardown.

The focused adapter tests (`vitest run devin` in `packages/providers`) cover the ACP boundary: authenticate credentials, model and mode `set_config_option` sequences including plan-mode restore, `session/load` resume, fs scoping refusals, permission option passthrough, and the event mapper. Use them when no Devin account is logged in.

## Gotchas

- A missing `devin` binary makes the provider report `cli_missing`; `listModels` then serves the static fallback catalog rather than failing.
- Devin authentication resolves per spawned process. Record a live authentication error as a blocked provider and rerun after `devin auth login` or setting `WINDSURF_API_KEY`.
- `allow_always` writes a project-local config file (`.devin/config.json` or `config.local.json`); inspect the session worktree's `.devin/` after a live permission prompt to confirm which file it uses.
- The Access Mode picker lists all Devin modes statically. The adapter tracks modes the session advertises and skips an unadvertised `set_config_option`, but account-gated modes are not yet filtered out of the picker.
