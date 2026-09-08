# Resource lifecycle

## Sub-features

- A stopped turn releases its active session, while its cancelled runtime snapshot remains available for reconnect hydration.
- A harness-created direct thread can be deleted without worktree cleanup.
- Harness cleanup removes only harness-created receipts, timelines, and check logs.
- Diagnostics show bounded file metadata without raw logs or provider payloads.
- Full shutdown interrupts active turns, then awaits cleanup of the Codex processes that the runtime owns.

## How to get to it (user POV)

1. Start and stop a thread in the current project.
2. Delete the thread and keep the project checkout.
3. Confirm that no running indicator remains.
4. Remove verification evidence when you no longer need it.

## Driving it with verify-mcode

Run `runtime inspect` before and after the stop scenario. The live command requires `thread.delete` to confirm deletion of its own direct thread unless `--keep-thread` is present. Run `runtime cleanup` to remove harness-created files under `.dev/verification/agent-runtime`.

## Gotchas

- `cleanup` does not stop a runtime and does not reset or delete a database.
- Codex Stop retains its process. Full shutdown and session discard close it.
- Live teardown coverage for other providers remains incomplete.
- Memory-pressure integration remains a coverage gap.

## Full shutdown proof

Use an owned server process and the disposable fixture project. Run `runtime health` before this API proof.

1. Start two Codex turns through `agent.createAndSend` with read-only wait prompts.
2. Require two active turns. Record the server PID and its descendant PIDs with process creation times.
3. Send authenticated `POST /shutdown`. Require the `shutting_down` response, server exit code zero, and no surviving owned process.
4. Restart the owned server. Require healthy startup, zero active turns, and both persisted threads through `thread.list`.
5. Delete only the proof threads through `thread.delete`, then stop the owned server.

Retain a redacted receipt with the request, response, process identities, exit code, and restart results. Inspect it before handoff.
The focused Codex lifecycle test proves that interruption precedes process termination and that shutdown waits for exit.
This API proof does not prove the Electron Quit control.
