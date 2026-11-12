# App startup Phase 1 receipt, 2026-11-12

Phase 1 of the plan to make the packaged desktop app usable within 2 seconds starts the server before Electron is ready and polls its health every 25 ms on `127.0.0.1`. This receipt compares a package built from `32c896d54` with the baseline package from `567720b79`, interleaved, on both fixture variants. The segments are defined in [the baseline note](../2026-11-12-app-startup-baseline/README.md).

`summary.md` and `receipt.json` are the harness output, unchanged.

| Segment, p50 / p90 ms | Variant A before | Variant A after | Variant B before | Variant B after | p90 budget |
| --- | --- | --- | --- | --- | --- |
| A. T0 to server spawned | 261 / 407 | 173 / 217 | 259 / 401 | 191 / 226 | 300 |
| C. Listening to healthy | 89 / 193 | 45 / 55 | 79 / 209 | 16 / 31 | 30 |

Segment A meets its budget on both variants. Segment C misses it by 25 ms on variant A and 1 ms on variant B.

## What the receipt does not show

The totals are not a Phase 1 result. Segment F still switches between about 100 ms and about 1,500 ms from launch to launch on both packages. In this run that slow mode raised the baseline's variant A p50 to 3,268 ms, against 2,886 ms in the Phase 0 receipt. Phase 1 does not touch F, so any change in the total p50 is mostly F's slow mode.

Segment C on variant A takes 45 to 63 ms in half its launches, and none of those launches records a server stall of 100 ms or more. The likely cause is the main process: the server now reports healthy while main is still creating the window, so main handles the health response late (inferred). The receipt has no main-process mark between window creation and healthy, so this is not measured.

## Method

Both packages were built with the CI packaging steps in a detached checkout, with `--config.npmRebuild=false`, as for the baseline. The harness ran from `32c896d54`, with each variant getting one discarded warm-up and 10 measured launches per package. None failed.

```sh
bun scripts/perf/app-startup-harness.mjs --exe <phase 1 package>/Mcode.exe --baseline <baseline package>/Mcode.exe --variants A,B --launches 10 --name phase1-32c896d54
```

The spawn environment before `app.whenReady()` was checked with an Electron 35.7.5 probe, not a unit test. `app.getPath("temp")`, `app.getPath("userData")`, `app.getVersion()`, `app.isPackaged`, `process.resourcesPath`, `process.execPath`, and all 136 `process.env` keys were identical before and after ready.
