# App startup Phase 2 receipt, 2026-11-13

Phase 2 of the plan to make the packaged desktop app usable within 2 seconds works on the server's critical path. This receipt compares a package built from `d9eea085b` with the baseline package from `567720b79`, interleaved, on both fixture variants. The segments are defined in [the baseline note](../2026-11-12-app-startup-baseline/README.md).

`summary.md` and `receipt.json` are the harness output, unchanged.

| p50 / p90 ms | Variant A before | Variant A after | Variant B before | Variant B after | p90 budget |
| --- | --- | --- | --- | --- | --- |
| B. Spawned to listening | 1,082 / 1,213 | 499 / 614 | 997 / 1,130 | 459 / 588 | 1,000 |
| Longest stall before usable | 220 | 178 | 162 | 176 | 250 |
| Total, T0 to usable | 3,602 / 3,867 | 1,667 / 3,842 | 3,474 / 4,021 | 2,695 / 3,816 | 2,000 |

Both exit criteria hold. Segment B meets its budget on both variants, and no candidate launch has a server stall over 250 ms before it is usable. All 40 launches settled.

## Where segment B went

The `execution workers ready` step fell from 500 / 591 ms to 0 / 1 ms on variant A, and from 481 / 516 ms to 0 / 3 ms on variant B (measured). The writer and execution worker bundles now load from bytecode, as `server.cjs` already did. The rest of B is unchanged work: process load, the container, and orphan cleanup.

## Where the stalls went

The baseline package did not stall over 250 ms in this run, so this run alone does not show the stall fix. Earlier packages from this branch did. A package built before the Codex usage warmup change had stalls of 491 and 505 ms before usable, and one built after it but before the Codex catalog change had stalls of 450, 263 and 262 ms (measured, 10 launches per variant each). CPU profiles with an event-loop lag recorder attributed every stall over 250 ms to one cause. Each was a synchronous child process start on the server's main thread. Under startup load on Windows, one start blocks its thread for 260 to 535 ms. On an idle machine the same start takes about 3 ms, with or without starts on another thread at the same time (measured). So the cost comes from load, not from a lock the threads share.

The callers were Copilot CLI discovery, the skill scan, startup git and shell probes, provider status probes, the Codex usage warmup, and the Codex catalog `codex app-server`. Each now starts its process on one shared process worker thread, or no longer starts one at all. Real Codex sessions still start their process on the main thread. They begin after a user acts, not during startup.

## What the receipt does not show

The totals still miss the 2,000 ms budget at p90. Segment F, from the last first-paint answer to the usable frame, takes 2,407 to 2,759 ms in 6 of the 20 candidate launches, and those launches total 3,635 to 4,268 ms. In the other 14, F takes 54 to 992 ms and the launch totals at most 2,695 ms, except one. That launch, variant B launch 3, totals 5,198 ms because segment E took 3,735 ms. Segment E runs from the window receiving the server URL to the last first-paint answer. During it, the renderer sent `thread.startup.list` many times, and no server stall exceeded 131 ms. Phase 3 works on the renderer side of both.

Segment C, from listening to healthy, is bimodal on the candidate. It takes 9 to 39 ms in 11 of 20 launches and 163 to 1,207 ms in the other 9. No server stall of 100 ms or more overlaps segment C in any slow launch, in this run or in the previous receipt (19 slow launches). In 14 of those 19, the server listened less than 700 ms after T0. The server now listens about 550 ms earlier than before, when the desktop main process may still be busy with Electron's ready event and window creation, so it reads the health answer late (inferred). The record does not show the desktop main process's own work, so this is not proven.

## Method

Both packages were built with the CI packaging steps in a detached checkout, with `--config.npmRebuild=false`, as for the baseline. The harness ran from `d9eea085b`. Each variant got one discarded warm-up and 10 measured launches per package. None failed.

```sh
bun scripts/perf/app-startup-harness.mjs --exe <phase 2 package>/Mcode.exe --baseline <baseline package>/Mcode.exe --variants A,B --launches 10 --name phase2-d9eea085b
```

Stalls before listen were found with a probe build, not with this harness. The probe recorded event-loop lag from server start and wrote a CPU profile per launch. Each lag over 150 ms was then matched to the profile samples inside it.
