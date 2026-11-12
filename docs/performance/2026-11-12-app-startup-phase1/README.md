# App startup Phase 1 receipt, 2026-11-12

Phase 1 of the plan to make the packaged desktop app usable within 2 seconds starts the server before Electron is ready and polls its health every 25 ms on `127.0.0.1`. This receipt compares a package built from `70700d751` with the baseline package from `567720b79`, interleaved, on both fixture variants. The segments are defined in [the baseline note](../2026-11-12-app-startup-baseline/README.md).

`summary.md` and `receipt.json` are the harness output, unchanged.

| Segment, p50 / p90 ms | Variant A before | Variant A after | Variant B before | Variant B after | p90 budget |
| --- | --- | --- | --- | --- | --- |
| A. T0 to server spawned | 255 / 370 | 182 / 195 | 323 / 537 | 179 / 236 | 300 |
| C. Listening to healthy | 145 / 195 | 51 / 84 | 115 / 179 | 27 / 38 | 30 |

Segment A meets its budget on both variants. Segment C misses it on both. An earlier run of a package built from `32c896d54`, before the review fixes, gave the same picture: A at 173 / 217 and 191 / 226, C at 45 / 55 and 16 / 31.

## What the receipt does not show

The totals are not a Phase 1 result. Across both runs, segment F takes 500 ms or more in 54 of 80 launches, and every one of those launches totals between 3,245 and 3,545 ms, on both packages, however fast the earlier segments were. So those launches wait for something that ends at a roughly fixed time after launch, and F absorbs whatever time is left (inferred). In the other 26 launches F takes 65 to 201 ms, and 21 of them total under 3,000 ms. Phase 1 does not touch F. Which mode a launch gets varies from run to run: the candidate had 5 fast launches out of 10 on variant A in the earlier run, and 2 in this one.

Segment C misses its budget in both runs, and the baseline's C also moved between runs (variant A p50 89 ms before, 145 ms here), so C depends on the machine's state as well as on the change. On variant B, C takes 11 to 39 ms, close to what one 25 ms poll and a loopback probe cost. On variant A, it takes 11 to 93 ms. No server stall of 100 ms or more overlaps C in any candidate launch of either variant. The record keeps only stalls of 100 ms or more, so it cannot show what delays the health response. Server work that starts when the server listens is the likely cause (inferred). Variant A baseline launch 3 here has a 220 ms stall at listen, and the [Phase 0 receipt](../2026-11-12-app-startup-baseline/README.md) recorded one too. Segment C is checked again at the end of Phase 2, which works on the server after listen.

Neither package settles every launch. Variant A settled 10 of 10 launches before and 8 of 10 after, and variant B 8 of 10 on both. In the earlier run the counts were 9 and 9 on variant A and 9 and 10 on variant B. Every stall over 250 ms that unsettled a launch overlaps the snapshot pin sweep, which is server work after the app is usable and which Phase 2 targets.

## Method

Both packages were built with the CI packaging steps in a detached checkout, with `--config.npmRebuild=false`, as for the baseline. The harness ran from `70700d751`, with each variant getting one discarded warm-up and 10 measured launches per package. None failed.

```sh
bun scripts/perf/app-startup-harness.mjs --exe <phase 1 package>/Mcode.exe --baseline <baseline package>/Mcode.exe --variants A,B --launches 10 --name phase1-70700d751
```

The spawn environment before `app.whenReady()` was checked with an Electron 35.7.5 probe, not a unit test. `app.getPath("temp")`, `app.getPath("userData")`, `app.getVersion()`, `app.isPackaged`, `process.resourcesPath`, `process.execPath`, and all 136 `process.env` keys were identical before and after ready.
