# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 255 | 370 | 300 |
| B | 10 | 0 | 1380 | 1677 | 1000 |
| C | 10 | 0 | 145 | 195 | 30 |
| D | 10 | 0 | 236 | 357 | inside B |
| E | 10 | 0 | 258 | 290 | 250 |
| F | 10 | 0 | 1175 | 1491 | 150 |
| total | 10 | 0 | 3269 | 3331 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 67 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 622 ms; p90 829 ms; measured 10; unmeasured 0
- migration plan read: p50 223 ms; p90 301 ms; measured 10; unmeasured 0
- bootstrap entered: p50 145 ms; p90 217 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 92 ms; p90 129 ms; measured 10; unmeasured 0
- database writer ready: p50 43 ms; p90 62 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 24 ms; p90 34 ms; measured 10; unmeasured 0
- read-only database opened: p50 19 ms; p90 24 ms; measured 10; unmeasured 0
- services resolved: p50 14 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 14 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 11 ms; p90 15 ms; measured 10; unmeasured 0
- family child interruption: p50 4 ms; p90 11 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 8 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 4 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 114 ms; offset 2036 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 154 ms; offset 2150 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 132 ms; offset 3383 ms; before usable false; RPCs thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 155 ms; offset 23008 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 1: 135 ms; offset 24550 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 1: 111 ms; offset 25916 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 1: 134 ms; offset 28841 ms; before usable false; RPCs none; tasks none
- Launch 1: 101 ms; offset 28975 ms; before usable false; RPCs none; tasks none
- Launch 1: 106 ms; offset 29076 ms; before usable false; RPCs none; tasks none
- Launch 2: 136 ms; offset 1582 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 152 ms; offset 17135 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 220 ms; offset 1893 ms; before usable true; RPCs none; tasks codex version warmup, provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 153 ms; offset 2465 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 160 ms; offset 1840 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 194 ms; offset 5560 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 5: 226 ms; offset 2462 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 184 ms; offset 3259 ms; before usable true; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 155 ms; offset 1841 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 201 ms; offset 4047 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 7: 147 ms; offset 2933 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 100 ms; offset 2027 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 189 ms; offset 2127 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 106 ms; offset 5073 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 9: 129 ms; offset 2019 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 189 ms; offset 2148 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 220 ms; offset 11582 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 9: 121 ms; offset 20452 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 167 ms; offset 1876 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 114 ms; offset 16154 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 165 ms; offset 28297 ms; before usable false; RPCs provider.catalog; tasks none

## Variant A, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 182 | 195 | 300 |
| B | 10 | 0 | 1288 | 1595 | 1000 |
| C | 10 | 0 | 51 | 84 | 30 |
| D | 10 | 0 | 227 | 358 | inside B |
| E | 10 | 0 | 240 | 312 | 250 |
| F | 10 | 0 | 1558 | 1735 | 150 |
| total | 10 | 0 | 3314 | 3379 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 8; unsettled 2; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 68 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 644 ms; p90 768 ms; measured 10; unmeasured 0
- migration plan read: p50 220 ms; p90 302 ms; measured 10; unmeasured 0
- bootstrap entered: p50 158 ms; p90 185 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 96 ms; p90 141 ms; measured 10; unmeasured 0
- database writer ready: p50 42 ms; p90 53 ms; measured 10; unmeasured 0
- read-only database opened: p50 20 ms; p90 29 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 23 ms; p90 26 ms; measured 10; unmeasured 0
- services resolved: p50 14 ms; p90 18 ms; measured 10; unmeasured 0
- dependency container initialized: p50 14 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 13 ms; p90 14 ms; measured 10; unmeasured 0
- family child interruption: p50 8 ms; p90 12 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 8 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 2 ms; p90 4 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 158 ms; offset 1601 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 259 ms; offset 3450 ms; before usable false; RPCs provider.catalog, thread.syncPrs; tasks provider usage warmup, snapshot pin sweep
- Launch 1: 160 ms; offset 5298 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 2: 143 ms; offset 1518 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 170 ms; offset 12769 ms; before usable false; RPCs none; tasks none
- Launch 2: 162 ms; offset 15032 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 110 ms; offset 1768 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 167 ms; offset 1878 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 242 ms; offset 2964 ms; before usable true; RPCs providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 128 ms; offset 3441 ms; before usable false; RPCs thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 203 ms; offset 20452 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 122 ms; offset 29579 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 4: 152 ms; offset 1630 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 456 ms; offset 26025 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 4: 133 ms; offset 26787 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 181 ms; offset 1812 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 110 ms; offset 2158 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 222 ms; offset 2268 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 114 ms; offset 1825 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 194 ms; offset 1939 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 324 ms; offset 12783 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 140 ms; offset 1775 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 393 ms; offset 11261 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 199 ms; offset 11763 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 133 ms; offset 12064 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 127 ms; offset 12303 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 160 ms; offset 22821 ms; before usable false; RPCs none; tasks none
- Launch 9: 132 ms; offset 1868 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 246 ms; offset 2000 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 136 ms; offset 2107 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

## Variant B, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 323 | 537 | 300 |
| B | 10 | 0 | 1466 | 2257 | 1000 |
| C | 10 | 0 | 115 | 179 | 30 |
| D | 10 | 0 | 259 | 393 | inside B |
| E | 10 | 0 | 250 | 462 | 250 |
| F | 10 | 0 | 570 | 1488 | 150 |
| total | 10 | 0 | 3264 | 3466 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 8; unsettled 2; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 69 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 706 ms; p90 1364 ms; measured 10; unmeasured 0
- bootstrap entered: p50 194 ms; p90 283 ms; measured 10; unmeasured 0
- migration plan read: p50 140 ms; p90 202 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 105 ms; p90 136 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 45 ms; p90 72 ms; measured 10; unmeasured 0
- database writer ready: p50 50 ms; p90 61 ms; measured 10; unmeasured 0
- journal import: p50 31 ms; p90 44 ms; measured 10; unmeasured 0
- read-only database opened: p50 22 ms; p90 31 ms; measured 10; unmeasured 0
- services resolved: p50 16 ms; p90 19 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 7 ms; p90 18 ms; measured 10; unmeasured 0
- dependency container initialized: p50 15 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 11 ms; p90 15 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 6 ms; p90 13 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 8 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 8 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- IPC listener opened: p50 2 ms; p90 6 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 4 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 195 ms; offset 2809 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 180 ms; offset 3004 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 146 ms; offset 1802 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 227 ms; offset 15500 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 137 ms; offset 1593 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 115 ms; offset 2863 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 169 ms; offset 3028 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 246 ms; offset 2388 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 132 ms; offset 2634 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 195 ms; offset 2193 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 225 ms; offset 3513 ms; before usable false; RPCs provider.catalog, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 132 ms; offset 1626 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 134 ms; offset 8332 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 8: 398 ms; offset 3654 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 239 ms; offset 4052 ms; before usable false; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 160 ms; offset 3412 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 150 ms; offset 1857 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 225 ms; offset 7145 ms; before usable false; RPCs none; tasks snapshot pin sweep
- Launch 10: 105 ms; offset 7466 ms; before usable false; RPCs none; tasks snapshot pin sweep
- Launch 10: 410 ms; offset 7571 ms; before usable false; RPCs none; tasks snapshot pin sweep
- Launch 10: 232 ms; offset 15789 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 10: 262 ms; offset 16358 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 10: 240 ms; offset 21181 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 135 ms; offset 21735 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 144 ms; offset 28216 ms; before usable false; RPCs provider.catalog; tasks none

## Variant B, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 179 | 236 | 300 |
| B | 10 | 0 | 1208 | 1625 | 1000 |
| C | 10 | 0 | 27 | 38 | 30 |
| D | 10 | 0 | 268 | 1693 | inside B |
| E | 10 | 0 | 248 | 448 | 250 |
| F | 10 | 0 | 1254 | 1823 | 150 |
| total | 10 | 0 | 3290 | 3372 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 8; unsettled 2; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 68 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 605 ms; p90 837 ms; measured 10; unmeasured 0
- bootstrap entered: p50 167 ms; p90 207 ms; measured 10; unmeasured 0
- migration plan read: p50 151 ms; p90 187 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 100 ms; p90 131 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 52 ms; p90 64 ms; measured 10; unmeasured 0
- database writer ready: p50 47 ms; p90 56 ms; measured 10; unmeasured 0
- journal import: p50 31 ms; p90 42 ms; measured 10; unmeasured 0
- read-only database opened: p50 21 ms; p90 27 ms; measured 10; unmeasured 0
- services resolved: p50 16 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 14 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 13 ms; p90 16 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 7 ms; p90 14 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 10 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 10 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 8 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 4 ms; p90 4 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 196 ms; offset 2350 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 122 ms; offset 1459 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 216 ms; offset 15481 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 129 ms; offset 1507 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 159 ms; offset 24687 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 140 ms; offset 26833 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 138 ms; offset 28349 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 3: 126 ms; offset 29405 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 4: 152 ms; offset 2435 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 334 ms; offset 2587 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 116 ms; offset 26683 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 151 ms; offset 1547 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 133 ms; offset 8991 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 6: 136 ms; offset 1642 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 197 ms; offset 20796 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 7: 106 ms; offset 2066 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 243 ms; offset 2172 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 141 ms; offset 4865 ms; before usable true; RPCs approval.listPending; tasks snapshot pin sweep
- Launch 8: 103 ms; offset 5006 ms; before usable true; RPCs agent.listHeldSteers, thread.listAttention, terminal.listActive; tasks snapshot pin sweep
- Launch 8: 617 ms; offset 5173 ms; before usable true; RPCs provider.catalog, settings.get; tasks snapshot pin sweep
- Launch 8: 737 ms; offset 5872 ms; before usable false; RPCs workspace.icon.resolve, thread.syncPrs; tasks snapshot pin sweep
- Launch 9: 161 ms; offset 2016 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 230 ms; offset 2177 ms; before usable false; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 122 ms; offset 1629 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 182 ms; offset 1751 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

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
| fileBytes | 2010206208 | 105164800 | 105205760 |
| freelistCount | 261376 | 0 | 0 |
