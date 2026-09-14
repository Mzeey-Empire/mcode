# Windows console hygiene

## Sub-features

- Server startup, provider probes, session spawns, and process cleanup never open a visible console window under the console-less server or detached dev runtime.
- The same holds while a session runs: provider CLI children, taskkill/tasklist cleanup, and usage probes stay hidden.
- Development scripts (`dev-electron`, `dev-web`, `agent:up` helpers) spawn their children without console windows.

## How to get to it (user POV)

The user never enters this feature; they notice its absence when a terminal window flashes during app start, session start, or shutdown on Windows.

## Driving it with verify-mcode

On Windows only; on other platforms the command reports `skipped`.

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime console-audit
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime console-audit --watch 30
```

The audit reads `.dev/pids/server.pid` (and `desktop.pid` for `--tree desktop` or `--tree all`), walks each process's descendants, and reports any descendant that owns a visible window. `findings` are attributed to the audited tree: a classic console window is attributed through its conhost child to the console client, and any other visible window is attributed to its owning descendant. GUI owners (the Electron app itself) are excluded by name.

To catch a transient startup flash, run `runtime console-audit --watch 30` in one shell while running `bun run --shell system agent:down` then `agent:up` in another, or while launching the packaged desktop app. Watch mode also records `consoleWindowSightings`: every newly appearing `ConsoleWindowClass` or `CASCADIA_HOSTING_WINDOW_CLASS` window in the session, since Windows Terminal-hosted consoles cannot be attributed to a process tree by parentage. Correlate a sighting's title and timestamp with the action under test.

## Proof

1. With a healthy worktree runtime up, run the snapshot audit. `findings` must be empty.
2. Repeat with `--watch` across a runtime restart and, for full coverage, a packaged-app launch. `findings` must remain empty; inspect any `consoleWindowSightings` and confirm none correspond to a runtime child (a sighting with a `cmd`, `taskkill`, `tasklist`, `cursor-agent`, or `bun` title during the window is a defect signal).
3. Retain the JSON output under `.dev/verification/agent-runtime` as the receipt.

## Gotchas

- A Windows Terminal-hosted console window is owned by `WindowsTerminal.exe`, outside the audited tree; only watch-mode sightings can catch it, and they require manual correlation. Record an uncorrelated sighting as a gap, not a pass or a defect.
- Hidden console children (`windowsHide`) still spawn conhost; conhost presence alone is not a finding.
- The audit cannot run before the runtime starts because it needs the PID files. A missing PID file is an actionable error, not a failure.
- Static coverage is the companion gate: focused tests assert `windowsHide` on the process call sites (orphan cleanup, process kill, provider spawns, ACP runtime, usage probes), so new call sites must carry the option and its assertion.
