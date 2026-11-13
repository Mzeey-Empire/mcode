# App startup Phase 3 follow-ups receipt, 2026-11-13

The Phase 3 follow-ups open the window and paint the first frame in the theme the user last used, instead of always dark. This receipt compares a package built from `926acb75f` with the Phase 3 package built from `3d3df9872`, interleaved, on both fixture variants. The segments are defined in [the baseline note](../2026-11-12-app-startup-baseline/README.md).

`summary.md` and `receipt.json` are the harness output, unchanged.

| p50 / p90 ms | Variant A before | Variant A after | Variant B before | Variant B after | p90 budget |
| --- | --- | --- | --- | --- | --- |
| C. Listening to healthy | 22 / 37 | 22 / 31 | 16 / 24 | 22 / 31 | 30 |
| D. Window created to scripts evaluated | 203 / 255 | 200 / 237 | 202 / 233 | 198 / 235 | inside B |
| E. URL received to last first-paint answer | 236 / 243 | 238 / 259 | 244 / 260 | 233 / 255 | 250 |
| F. Last first-paint answer to usable | 89 / 94 | 88 / 94 | 88 / 97 | 80 / 99 | 150 |
| Total, T0 to usable | 1,022 / 1,201 | 1,030 / 1,182 | 1,010 / 1,196 | 997 / 1,155 | 2,000 |

This receipt checks for a regression. It cannot show the theme fix, because every harness launch starts from fresh data directories with no cached theme, so both packages paint dark. All 40 launches settled. The longest server stall in any launch was 183 ms, and every stall came before the app was usable.

Two p90 budgets are missed, by both packages at different times. Across the two runs against `3d3df9872`, the before and after p90 values are:

| p90 ms | A before | A after | B before | B after | Budget |
| --- | --- | --- | --- | --- | --- |
| C, run at `6361557d4` | 38 | 35 | 41 | 36 | 30 |
| C, run at `926acb75f` | 37 | 31 | 24 | 31 | 30 |
| E, run at `6361557d4` | 250 | 249 | 259 | 275 | 250 |
| E, run at `926acb75f` | 243 | 259 | 260 | 255 | 250 |

The baseline misses both budgets too, and the direction changes between runs, so ten launches per set do not show a regression. They do not rule out a small one. E's p50 is lower after in three of four sets.

## Unsettled launches in earlier runs

Two earlier receipts for this branch compared it with `42f5039d7`, the Phase 3 head before it was rebased onto `main`. Two of their 60 candidate launches had a server stall over 250 ms (260 and 251 ms), against none of 60 baseline launches. This branch changes no server or packaging code. Both stalls overlapped the `codex version warmup` task, and stalls that overlap it run 155 to 187 ms on average against 136 to 159 ms for those that do not. Two in 60 against none in 60 is not a significant difference (Fisher exact test, p about 0.5). Two later runs against the true base, at `6361557d4` and at `926acb75f`, settled every launch.

## Method

Both packages were built with the CI packaging steps in a detached checkout, with `--config.npmRebuild=false`, as for the baseline. Each variant got one discarded warm-up and 10 measured launches per package. None failed.

```sh
bun scripts/perf/app-startup-harness.mjs --exe <follow-ups package>/Mcode.exe --baseline <phase 3 package>/Mcode.exe --variants A,B --launches 10 --name followups-926acb75f-vs-3d3df9872
```

The light-theme launch capture in the pull request was recorded outside the harness. Each launch used fresh data directories, a `settings.json` with the light theme, and one priming launch so the app could cache the theme before the recorded launch. It records one launch per package at 60 frames per second, so it shows the first captured frames, not every frame the compositor drew.
