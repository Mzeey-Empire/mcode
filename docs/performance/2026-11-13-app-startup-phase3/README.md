# App startup Phase 3 receipt, 2026-11-13

Phase 3 of the plan to make the packaged desktop app usable within 2 seconds works on the renderer and the window. This receipt compares a package built from `42f5039d7` with the Phase 2 package built from `d9eea085b`, interleaved, on both fixture variants. The segments are defined in [the baseline note](../2026-11-12-app-startup-baseline/README.md).

`summary.md` and `receipt.json` are the harness output, unchanged.

| p50 / p90 ms | Variant A before | Variant A after | Variant B before | Variant B after | p90 budget |
| --- | --- | --- | --- | --- | --- |
| E. URL received to last first-paint answer | 219 / 230 | 224 / 239 | 220 / 246 | 224 / 243 | 250 |
| F. Last first-paint answer to usable | 2,059 / 2,654 | 67 / 92 | 2,400 / 2,542 | 81 / 107 | 150 |
| Total, T0 to usable | 3,282 / 3,760 | 1,047 / 1,794 | 3,276 / 3,473 | 1,320 / 1,520 | 2,000 |

Both variants meet the program targets of 1,500 ms at p50 and 2,000 ms at p90. F was over 150 ms in 14 of 20 baseline launches and in none of the 20 candidate launches. All 40 launches settled, and the longest server stall before usable was 219 ms.

## What held F

The window was created hidden and shown on Electron's `ready-to-show` event, or by a 3 s fallback timer. A window created hidden on Windows often does not draw a frame until it is shown, so `ready-to-show` waited for the timer. In a measurement run with the window marks added to the analysis, every slow baseline launch (13 of 20) had `ready-to-show` 3,030 to 3,907 ms after the window was created. The usable frame came between 36 ms before and 4 ms after it. In the fast launches, `ready-to-show` came 1 to 9 ms before the renderer received the server URL. Removing the unused Google Fonts stylesheet alone left F slow in 15 of 20 launches.

The window is now visible from creation, with the dark background colour it already had, and `ready-to-show` only records the launch mark.

## What was tried and dropped

Three renderer changes were built and measured against a package with only the font and window changes: render before `terminal.capabilities` answers, send `workspace.list` at socket open, and fetch settings once. React committed 30 to 50 ms earlier, but the first-paint answers then waited behind that first render on the renderer's main thread. Settings moved from about 45 ms to about 170 ms after the URL, and the thread list from about 220 ms to about 300 ms. Time from URL to usable went from 272 / 340 ms to 317 / 387 ms on variant A and from 345 / 365 ms to 346 / 371 ms on variant B. They are not in this phase.

## What the receipt does not show

Segment C, from listening to healthy, still misses its 30 ms budget at p90, and segment D, from window created to scripts evaluated, has a tail of 700 ms or more. Both tails appear with either window behaviour. Across this phase's runs, C exceeded 100 ms in 22 of 80 hidden-window launches (28%) and 41 of 100 visible-window launches (41%). D exceeded 400 ms in 16 of 80 (20%) and 28 of 100 (28%). The visible window may add to these tails, since it starts drawing while the server is still starting (inferred, not measured). The two slowest candidate launches show it: the 1,972 ms launch spent 691 ms in C, and the 2,213 ms launch spent 1,201 ms in D, where the candidate medians are 30 to 115 ms and 214 to 285 ms.

No measured launch reopened a thread, so the receipt covers startup with no thread selected.

## Method

Both packages were built with the CI packaging steps in a detached checkout, with `--config.npmRebuild=false`, as for the baseline. The harness ran from `42f5039d7`. Each variant got one discarded warm-up and 10 measured launches per package. None failed.

```sh
bun scripts/perf/app-startup-harness.mjs --exe <phase 3 package>/Mcode.exe --baseline <phase 2 package>/Mcode.exe --variants A,B --launches 10 --name phase3-42f5039d7
```

The window and per-answer marks above come from runs with a local change to `scripts/perf/app-startup/analysis.mjs` that copies the existing `windowCreated`, `readyToShow`, `socketOpen` and per-answer marks into each launch's analysis. That change is not committed.
