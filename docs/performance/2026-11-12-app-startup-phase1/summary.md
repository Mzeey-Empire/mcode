# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 261 | 407 | 300 |
| B | 10 | 0 | 1316 | 1785 | 1000 |
| C | 10 | 0 | 89 | 193 | 30 |
| D | 10 | 0 | 228 | 367 | inside B |
| E | 10 | 0 | 259 | 390 | 250 |
| F | 10 | 0 | 777 | 1713 | 150 |
| total | 10 | 0 | 3268 | 3402 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 9; unsettled 1; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 69 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 686 ms; p90 1001 ms; measured 10; unmeasured 0
- migration plan read: p50 217 ms; p90 261 ms; measured 10; unmeasured 0
- bootstrap entered: p50 153 ms; p90 249 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 88 ms; p90 122 ms; measured 10; unmeasured 0
- database writer ready: p50 39 ms; p90 49 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 21 ms; p90 31 ms; measured 10; unmeasured 0
- read-only database opened: p50 18 ms; p90 26 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 17 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 16 ms; measured 10; unmeasured 0
- dependency container initialized: p50 12 ms; p90 14 ms; measured 10; unmeasured 0
- family child interruption: p50 8 ms; p90 11 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 9 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 7 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 2 ms; p90 4 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 178 ms; offset 2619 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 142 ms; offset 1892 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 122 ms; offset 3489 ms; before usable false; RPCs thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 170 ms; offset 3611 ms; before usable false; RPCs thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 228 ms; offset 4828 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 2: 113 ms; offset 26328 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 109 ms; offset 26751 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 261 ms; offset 28095 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 115 ms; offset 1554 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 123 ms; offset 1610 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 112 ms; offset 29588 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 114 ms; offset 2150 ms; before usable true; RPCs none; tasks codex version warmup, provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 166 ms; offset 2697 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 154 ms; offset 2361 ms; before usable true; RPCs provider.catalog, settings.get, app.stage, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 227 ms; offset 2515 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 133 ms; offset 5651 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 6: 101 ms; offset 6916 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 7: 344 ms; offset 2791 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 126 ms; offset 3238 ms; before usable false; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 146 ms; offset 1849 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 275 ms; offset 2740 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 167 ms; offset 3015 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 110 ms; offset 10186 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 10: 145 ms; offset 1566 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

## Variant A, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 173 | 217 | 300 |
| B | 10 | 0 | 1285 | 1453 | 1000 |
| C | 10 | 0 | 45 | 55 | 30 |
| D | 10 | 0 | 243 | 280 | inside B |
| E | 10 | 0 | 261 | 303 | 250 |
| F | 10 | 0 | 101 | 1582 | 150 |
| total | 10 | 0 | 2367 | 3378 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 9; unsettled 1; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 71 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 630 ms; p90 725 ms; measured 10; unmeasured 0
- migration plan read: p50 212 ms; p90 243 ms; measured 10; unmeasured 0
- bootstrap entered: p50 162 ms; p90 181 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 91 ms; p90 110 ms; measured 10; unmeasured 0
- database writer ready: p50 42 ms; p90 47 ms; measured 10; unmeasured 0
- read-only database opened: p50 19 ms; p90 29 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 23 ms; p90 26 ms; measured 10; unmeasured 0
- dependency container initialized: p50 14 ms; p90 16 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 16 ms; measured 10; unmeasured 0
- auth token resolved: p50 12 ms; p90 14 ms; measured 10; unmeasured 0
- family child interruption: p50 8 ms; p90 10 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 3 ms; p90 6 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 4 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 163 ms; offset 1615 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 174 ms; offset 20292 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 106 ms; offset 2222 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 253 ms; offset 2328 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 110 ms; offset 2863 ms; before usable false; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 124 ms; offset 3277 ms; before usable false; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 215 ms; offset 1891 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 103 ms; offset 1861 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 164 ms; offset 2015 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 202 ms; offset 2045 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 159 ms; offset 1607 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 169 ms; offset 1798 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 166 ms; offset 2038 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 108 ms; offset 1648 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 189 ms; offset 1756 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 172 ms; offset 1613 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

## Variant B, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 259 | 401 | 300 |
| B | 10 | 0 | 1060 | 1437 | 1000 |
| C | 10 | 0 | 79 | 209 | 30 |
| D | 10 | 0 | 226 | 344 | inside B |
| E | 10 | 0 | 205 | 656 | 250 |
| F | 10 | 0 | 1516 | 1712 | 150 |
| total | 10 | 0 | 3271 | 3361 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 9; unsettled 1; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 73 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 510 ms; p90 736 ms; measured 10; unmeasured 0
- bootstrap entered: p50 146 ms; p90 217 ms; measured 10; unmeasured 0
- migration plan read: p50 131 ms; p90 158 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 85 ms; p90 128 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 40 ms; p90 47 ms; measured 10; unmeasured 0
- database writer ready: p50 40 ms; p90 44 ms; measured 10; unmeasured 0
- journal import: p50 26 ms; p90 33 ms; measured 10; unmeasured 0
- read-only database opened: p50 16 ms; p90 29 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 20 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 13 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 4 ms; p90 10 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 9 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 8 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 7 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 4 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 144 ms; offset 1589 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 139 ms; offset 13270 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 252 ms; offset 2974 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 762 ms; offset 911 ms; before usable true; RPCs none; tasks provider availability, snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 3: 498 ms; offset 1957 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 125 ms; offset 2455 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 125 ms; offset 1563 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 136 ms; offset 1869 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 113 ms; offset 17369 ms; before usable false; RPCs none; tasks none
- Launch 5: 464 ms; offset 22088 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 194 ms; offset 22653 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 286 ms; offset 22952 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 197 ms; offset 23344 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 6: 214 ms; offset 2712 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 151 ms; offset 2926 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 237 ms; offset 1889 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 139 ms; offset 6621 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 7: 144 ms; offset 6862 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 7: 104 ms; offset 18303 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 7: 275 ms; offset 21648 ms; before usable false; RPCs none; tasks none
- Launch 7: 124 ms; offset 23241 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 8: 151 ms; offset 1596 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 147 ms; offset 17737 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 9: 171 ms; offset 1645 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 100 ms; offset 1540 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 146 ms; offset 1640 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 188 ms; offset 13956 ms; before usable false; RPCs provider.catalog; tasks none

## Variant B, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 191 | 226 | 300 |
| B | 10 | 0 | 1205 | 1550 | 1000 |
| C | 10 | 0 | 16 | 31 | 30 |
| D | 10 | 0 | 223 | 311 | inside B |
| E | 10 | 0 | 221 | 297 | 250 |
| F | 10 | 0 | 1022 | 1812 | 150 |
| total | 10 | 0 | 3300 | 3348 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 67 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 566 ms; p90 728 ms; measured 10; unmeasured 0
- bootstrap entered: p50 172 ms; p90 209 ms; measured 10; unmeasured 0
- migration plan read: p50 141 ms; p90 175 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 99 ms; p90 130 ms; measured 10; unmeasured 0
- database writer ready: p50 45 ms; p90 54 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 42 ms; p90 54 ms; measured 10; unmeasured 0
- journal import: p50 30 ms; p90 37 ms; measured 10; unmeasured 0
- read-only database opened: p50 19 ms; p90 28 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 3 ms; p90 22 ms; measured 10; unmeasured 0
- services resolved: p50 14 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 14 ms; p90 18 ms; measured 10; unmeasured 0
- auth token resolved: p50 13 ms; p90 16 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 6 ms; p90 11 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 10 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 8 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 7 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 4 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 130 ms; offset 1589 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 113 ms; offset 1762 ms; before usable true; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 167 ms; offset 1875 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 146 ms; offset 18966 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 105 ms; offset 20166 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 136 ms; offset 1429 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 126 ms; offset 30987 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 4: 257 ms; offset 1753 ms; before usable true; RPCs none; tasks codex version warmup, provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 144 ms; offset 2270 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 238 ms; offset 2414 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 173 ms; offset 1682 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 156 ms; offset 1834 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 106 ms; offset 1543 ms; before usable true; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 180 ms; offset 1649 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 170 ms; offset 8204 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 138 ms; offset 1514 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 153 ms; offset 16498 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 9: 124 ms; offset 2022 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 208 ms; offset 2146 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 111 ms; offset 25052 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 149 ms; offset 2285 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 106 ms; offset 12336 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep

Donor versus fixture statistics:

| Table | Donor | A | B |
| --- | --- | --- | --- |
| workspaces | 24 | 24 | 24 |
| threads | 290 | 26 | 26 |
| messages | 4207 | 333 | 334 |
| tool_call_records | 12650 | 2066 | 2066 |
| turn_snapshots | 157 | 0 | 0 |
| thread_tasks | 16 | 0 | 0 |
| _migrations | 23 | 0 | 0 |
| __drizzle_migrations | 110 | 110 | 110 |
| provider_model_cache | 6 | 6 | 6 |
| hook_executions | 269 | 4 | 4 |
| thought_segments | 4749 | 382 | 382 |
| pull_request_review_links | 0 | 0 | 0 |
| provider_catalog_snapshots | 808 | 808 | 808 |
| workspace_worktrees | 303 | 0 | 0 |
| thread_control_approvals | 0 | 0 | 0 |
| thread_control_audit | 62 | 27 | 27 |
| external_thread_control_pairings | 0 | 0 | 0 |
| external_thread_control_deliveries | 0 | 0 | 0 |
| canonical_agent_events | 221020 | 596 | 600 |
| canonical_agent_ingest_checkpoints | 1993 | 0 | 1 |
| canonical_agent_items | 118964 | 1863 | 1864 |
| canonical_agent_threads | 282 | 26 | 26 |
| canonical_agent_turns | 1993 | 143 | 144 |
| canonical_collaboration_actions | 47 | 0 | 0 |
| workspace_terminal_preferences | 0 | 0 | 0 |
| canonical_legacy_message_provenance | 3779 | 331 | 331 |
| canonical_legacy_migration_checkpoints | 1 | 1 | 1 |
| terminal_cleanup_ledger | 0 | 0 | 0 |
| cleanup_jobs | 0 | 0 | 0 |
| workspace_environment_automatic_setup_attempts | 7 | 0 | 0 |
| workspace_environment_queued_turns | 18 | 0 | 0 |
| workspace_environment_setup_gates | 18 | 0 | 0 |
| parent_assistant_text_checkpoint_chunks | 17 | 0 | 0 |
| parent_assistant_text_checkpoints | 1 | 0 | 0 |
| project_action_runs | 5 | 0 | 0 |
| workspace_environment_command_approvals | 0 | 0 | 0 |
| workspace_environment_storage_settings | 14 | 14 | 14 |
| thread_startups | 286 | 0 | 0 |
| turn_diff_snapshots | 33 | 0 | 0 |
| canonical_conversation_display_mappings | 20344 | 1645 | 1646 |
| conversation_display_materialization_state | 1 | 1 | 1 |
| canonical_writer_operation_receipts | 764 | 8 | 8 |
| canonical_writer_live_publication_heads | 95 | 2 | 2 |
| canonical_writer_thread_operation_receipts | 0 | 0 | 0 |
| store_identity | 1 | 0 | 0 |
| plans | 0 | 0 | 0 |
| git_commit_requests | 0 | 0 | 0 |
| approval_receipts | 0 | 0 | 0 |
| turn_steers | 33 | 0 | 0 |
| turn_reverts | 0 | 0 | 0 |
| provider_model_sightings | 304 | 304 | 304 |
| turn_resume_schedules | 0 | 0 | 0 |
| plan_implement_requests | 0 | 0 | 0 |
| plan_comments | 0 | 0 | 0 |
| plan_question_answers | 0 | 0 | 0 |
| mcode_schema_compatibility | 1 | 1 | 1 |
| thread_provider_sessions | 228 | 0 | 0 |
| delegated_tasks | 80 | 0 | 0 |
| thread_pull_requests | 2 | 0 | 0 |
| canonical_agent_item_content_appends | 0 | 0 | 0 |
| turn_file_evidence | 129 | 0 | 0 |
| worktreeThreads | 138 | 0 | 0 |
| openOrDraftPrThreads | 2 | 0 | 0 |
| fileBytes | 2010206208 | 105164800 | 105201664 |
| freelistCount | 261376 | 0 | 0 |
