# App startup baseline, 2026-11-12

This is the baseline for the plan to make the packaged desktop app usable within 2 seconds of launch, and the decision note that picks what the plan does first. The goal is a p90 of 2,000 ms and a p50 of 1,500 ms from process creation (T0) to the first frame that shows the real project list and a composer that accepts typing (T1). A launch is settled when no server event-loop stall over 250 ms happens in the 10 seconds after T1.

The plan itself is not in the repository, so the decisions table at the end restates each step it decides. Segments A to F are the plan's split of T1 minus T0, and the receipt measures each one.

Neither fixture passes. `summary.md` and `receipt.json` are the harness output, unchanged. `buckets.mjs` regroups the receipt into the tables below.

| Variant | p50 ms | p90 ms | Settled |
| --- | --- | --- | --- |
| A, normal history | 2,886 | 3,323 | 10 of 10 |
| B, A plus one cut-off turn | 3,344 | 9,436 | 7 of 10 |

| Segment | Variant A p50 / p90 ms | Variant B p50 / p90 ms | p90 budget ms |
| --- | --- | --- | --- |
| A. T0 to server spawned | 312 / 423 | 331 / 479 | 300 |
| B. Spawned to listening | 1,544 / 1,707 | 1,462 / 2,069 | 1,000 |
| C. Listening to healthy | 79 / 219 | 159 / 205 | 30 |
| D. Window created to scripts evaluated | 308 / 465 | 307 / 8,056 | inside B |
| E. Server URL received to the last first-paint answer | 305 / 331 | 288 / 683 | 250 |
| F. That answer to the usable frame | 107 / 1,231 | 96 / 1,242 | 150 |

## What dominates each segment

### Segment B is mostly a wait for the execution workers, then the container

Each server step runs from the previous mark to its own, and the buckets cover every step. Each launch's bucket sum is within 1 ms of its segment B (measured).

| Segment B bucket | Variant A p50 / p90 ms | Variant B p50 / p90 ms |
| --- | --- | --- |
| process load (spawn to `bootstrap entered`) | 193 / 278 | 184 / 256 |
| container (auth, configuration, database, services) | 402 / 528 | 308 / 454 |
| late setup and orphan cleanup | 120 / 134 | 120 / 181 |
| execution workers | 750 / 785 | 712 / 988 |
| recovery | 51 / 61 | 106 / 939 |
| listeners | 3 / 6 | 5 / 7 |

The largest bucket is the `await workerOwnedTurnRuntime.whenReady()` at `server-bootstrap.ts:1131` (measured). What fills that wait is not attributed. In 17 of 20 launches the step takes 624 to 1,513 ms. In the other three it takes 160 to 183 ms, and a block of similar size shows up elsewhere: a 668 ms stall right at listen in A-1, which makes its segment C 678 ms, and 866 and 993 ms in `checkpoint interrupted` in B-3 and B-9, where the other eight variant B launches take 24 to 64 ms (measured). So part of the wait is probably main-thread work that runs while the server awaits the workers and lands wherever the event loop is at the time (inferred). Provider availability verification starts before the wait (`server-bootstrap.ts:769`) and was still running during A-1's stall, which makes it a candidate, not a cause. The record cannot show stalls before listen, because its stall ticks start at listen.

The container's largest step is `migration plan read`, 272 / 352 ms on variant A and 167 / 231 ms on variant B (measured). It runs from reading the migration catalogue (`database.ts:341`) to planning migrations (`database.ts:244`).

Process load is about an eighth of segment B at p50, 193 of 1,544 ms on variant A (measured), so it does not dominate.

Recovery is small on variant A. On variant B, its p90 of 939 ms comes from the two launches where `checkpoint interrupted` absorbed the block described above (measured), so it is likely not recovery cost (inferred). Variant B does not reproduce the 5.4 s and 5.8 s turn recoveries in the app logs the plan started from (measured).

"Late setup and orphan cleanup" is the step that ends at `orphan cleanup completed` (`server-bootstrap.ts:1110`). It starts at `services resolved` (`server-bootstrap.ts:499`), so it also covers the expired snapshot cleanup (`:796`), the expired draft image cleanup (`:856`), and the start of provider availability.

### Segment D is the renderer, with five launches that take 4.8 to 8.6 seconds

D measures only the renderer. In 15 launches it takes 231 to 465 ms and finishes before the server listens. In the other five it takes 4,782 to 8,556 ms: A-7, B-3, B-6, B-7 and B-9 (measured). No launch falls in between.

The likely cause is the Google Fonts stylesheet in `apps/web/index.html:13`, which the packaged renderer loads from `file://` (`create-window.ts:166`) ahead of its module script (inferred). A pending stylesheet blocks script execution, so a slow fetch from `fonts.googleapis.com` delays D. The eager bundle is the same on every launch, so bundle evaluation is unlikely to explain a jump from at most 465 ms to at least 4,782 ms (inferred). The receipt has no mark between window creation and scripts evaluated, so this is not measured.

A late renderer also costs more than D. In B-7 and B-9 it sent its first-paint requests about 9 seconds after T0, while the snapshot pin sweep was still running. B-7 then had a 3,055 ms stall that started 62 ms before T1, and B-9 had stalls of 571 ms before T1 and 270 and 803 ms after it. Both launches are unsettled (measured).

### Segment E is about 300 ms, and server stalls are about a fifth of it

Server stalls cover 59 ms of segment E at p50 and 81 ms at p90 on variant A, and 58 and 102 ms on variant B (measured). The container, recovery and process load all finish before listen, and E starts after the server is healthy, so none of them is inside E (measured). The receipt keeps no per-request timings, so it cannot split the remaining time between the renderer's request order and the server's answers. The plan's code reading puts the renderer's order first: it awaits `terminal.capabilities` and sends `workspace.list` from the sidebar's mount effect (inferred, not re-measured here).

### Long stalls overlap the snapshot pin sweep

Seven stalls over 250 ms start before T1 or within the settle window: A-1 668 ms, B-4 258 ms, B-5 257 ms, B-7 3,055 ms, and B-9 571, 270 and 803 ms. The snapshot pin sweep was running during all seven. Provider usage warmup, provider status and model cache were running during three of them (measured). Overlap is a candidate, not proof.

Five more stalls over 250 ms happen 25 to 28 seconds after T0, in A-9, A-10 and B-10. Each overlaps only `provider.catalog` requests and no startup task (measured). They fall outside the settle window, so the goal does not gate them.

### No thread reopens at launch

No harness launch reopened a thread (measured), but each harness launch starts from a fresh profile, so that alone does not answer the question. The renderer reopens a thread only from `sessionStorage` (`workspaceStore.ts:836`, `open-thread-memory.ts`). `session-storage-probe.cjs` saves a value in one launch of Electron 35.7.5 and reads it in the next, using the same default session and `file://` loading as the main window. After the relaunch `sessionStorage` is empty, while `localStorage` keeps its value (measured). So T1 needs no "latest messages painted" condition, and E gains no conversation request.

### Segment F has a slow mode that nothing here explains

F takes 77 to 131 ms in 13 launches and 975 to 1,434 ms in seven: A-6, A-8, A-9, A-10, B-1, B-5 and B-10 (measured). Server stalls cover at most 291 ms of those seven windows (measured), so the slow mode is not server stalls. The record has no renderer mark between the last answer and the usable frame, so the cause is unknown. The plan has no step for F.

## Decisions for the later phases

The plan skips any step marked "if Phase 0 shows" when Phase 0 does not show it.

| Step | Plan's condition | What the baseline shows | Decision |
| --- | --- | --- | --- |
| Phase 1: probe `127.0.0.1`, poll every 25 ms, spawn the server before `whenReady` | none | A is 423 ms and C is 219 ms at p90 on variant A, against 300 and 30 | Go as written. |
| Phase 2.1: fix the recovery step that costs the time | attributed first; if variant B does not reproduce the logged 5 s recovery, use the user's records and reshape variant B | not reproduced | Wait for launch records from a nightly that includes the launch record, read them with `bun run perf:startup:records`, and reshape variant B to match. |
| Phase 2.2: fix what Phase 0 ties to a stall over 250 ms before T1 or in the settle window | a tie from Phase 0 | the snapshot pin sweep overlaps all seven such stalls | Go. Profile the snapshot pin sweep first, then the provider warmups. |
| Phase 2.3: move expired snapshot and draft image cleanup after listen | if Phase 0 shows either over 50 ms | neither has its own mark; the step that holds both, plus other setup and orphan cleanup, takes 120 ms at p50; the fixture has no turn snapshots | Skip. Revisit only if the user's records show that step at least 50 ms longer than on the fixture. |
| Phase 2.4: skip migration re-hashing with a stamp; bytecode-compile the writer and worker bundles | if the container is above 300 ms | the container is 528 and 454 ms at p90, and the migration step is the largest part | Go with the migration stamp. Hold the bytecode step until the execution-worker wait is attributed. |
| Risk fallback: listen before recovery behind a barrier | only if process load dominates B | process load is 193 of 1,544 ms at p50 | Not triggered. |
| Phase 3.1: self-host Crimson Text | none | the likely cause of the five slow D launches | Go first among the renderer steps. Its receipt tests the inference. |
| Phase 3.2 and 3.3: stop awaiting `terminal.capabilities`; send all first-paint requests at socket open | none | E is 331 and 683 ms at p90 | Go as written. |
| Phase 3.4: fix the `thread.listAll` or `thread.listAttention` query | if either exceeds 100 ms on variant A | the receipt keeps no per-request timings | Not evaluated. Read request durations from launch records when Phase 3 starts. |
| Phase 4: shrink the renderer bundle | only if D is on the critical path | D is on it only in the five slow launches, where the bundle is unlikely to be the cause | Not triggered. Recheck after Phase 3.1, and after Phase 1 moves the server spawn ahead of the window. |

Two items need attribution before the phases that depend on them:

- The execution-worker wait, before Phase 2.4's bytecode step. Stall ticks that start at `bootstrap entered`, or a CPU profile of the server during startup, would show what runs during it.
- Segment F's slow mode. The plan has no step for it, and F's budget is 150 ms.

## Limits

- One machine: Intel Core i7-12700, 64 GB RAM, NVMe SSD, Windows 11 Pro 10.0.26300. The app is version 0.13.0 on Electron 35.7.5.
- The fixture is a filtered copy of one real database. It has 26 of 287 threads and no turn snapshots or worktrees. `summary.md` lists row counts for the donor database and both fixtures.
- Each server step includes whatever else the event loop ran during it, and the record shows no stalls before listen.
- Each variant has 10 launches, and p90 is the ninth value, so one launch moves it. Variant B's p90 total is B-7.

## Method

The package was built from `567720b79`, which is `main` plus the launch record. The harness ran at `444cb7b05` on 2026-11-12 from a checkout of that commit:

```sh
bun scripts/perf/app-startup-harness.mjs --exe <package checkout>/apps/desktop/release/win-unpacked/Mcode.exe --variants A,B --launches 10 --name baseline-567720b79
```

Each variant had one discarded warm-up and 10 measured launches. None failed. The harness gives the app no `NODE_ENV`, as a Start menu launch does. The packaged build bakes `NODE_ENV="production"` into the main process and server bundles (`apps/desktop/scripts/build-main.mjs:50` and `:90`), so payload validation is off either way. Only the server's single-instance default still reads `NODE_ENV` at runtime, and it sees the same empty value a user's launch does.

To regenerate the tables:

```sh
bun docs/performance/2026-11-12-app-startup-baseline/buckets.mjs docs/performance/2026-11-12-app-startup-baseline/receipt.json
```

To rerun the `sessionStorage` probe, run it twice with the same empty directory:

```sh
apps/desktop/node_modules/electron/dist/electron.exe docs/performance/2026-11-12-app-startup-baseline/session-storage-probe.cjs write <empty directory>
apps/desktop/node_modules/electron/dist/electron.exe docs/performance/2026-11-12-app-startup-baseline/session-storage-probe.cjs read <same directory>
```
