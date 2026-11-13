# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 496 | 714 | 300 |
| B | 10 | 0 | 1082 | 1213 | 1000 |
| C | 10 | 0 | 119 | 174 | 30 |
| D | 10 | 0 | 221 | 376 | inside B |
| E | 10 | 0 | 175 | 309 | 250 |
| F | 10 | 0 | 1740 | 1991 | 150 |
| total | 10 | 0 | 3602 | 3867 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 66 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 500 ms; p90 591 ms; measured 10; unmeasured 0
- migration plan read: p50 182 ms; p90 231 ms; measured 10; unmeasured 0
- bootstrap entered: p50 140 ms; p90 219 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 80 ms; p90 92 ms; measured 10; unmeasured 0
- database writer ready: p50 37 ms; p90 41 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 19 ms; p90 29 ms; measured 10; unmeasured 0
- read-only database opened: p50 16 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 12 ms; p90 13 ms; measured 10; unmeasured 0
- services resolved: p50 11 ms; p90 13 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 10 ms; measured 10; unmeasured 0
- family child interruption: p50 3 ms; p90 7 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 107 ms; offset 1826 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 220 ms; offset 2193 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 109 ms; offset 2413 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 219 ms; offset 2059 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 137 ms; offset 2278 ms; before usable false; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 114 ms; offset 1566 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 204 ms; offset 1950 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 110 ms; offset 2129 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 126 ms; offset 1603 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 164 ms; offset 2035 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 139 ms; offset 2085 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

## Variant A, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 164 | 233 | 300 |
| B | 10 | 0 | 499 | 614 | 1000 |
| C | 10 | 0 | 28 | 515 | 30 |
| D | 10 | 0 | 278 | 321 | inside B |
| E | 10 | 0 | 229 | 249 | 250 |
| F | 10 | 0 | 90 | 2528 | 150 |
| total | 10 | 0 | 1667 | 3842 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 65 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 127 ms; p90 185 ms; measured 10; unmeasured 0
- migration plan read: p50 145 ms; p90 179 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 93 ms; p90 109 ms; measured 10; unmeasured 0
- database writer ready: p50 32 ms; p90 36 ms; measured 10; unmeasured 0
- read-only database opened: p50 18 ms; p90 20 ms; measured 10; unmeasured 0
- services resolved: p50 16 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 16 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 5 ms; p90 7 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 4 ms; p90 6 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 137 ms; offset 1422 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 132 ms; offset 1276 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 166 ms; offset 1368 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 178 ms; offset 1747 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 166 ms; offset 884 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 6: 144 ms; offset 1203 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 145 ms; offset 1129 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 8: 142 ms; offset 2381 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 146 ms; offset 1100 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 10: 125 ms; offset 1418 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache

## Variant B, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 401 | 657 | 300 |
| B | 10 | 0 | 997 | 1130 | 1000 |
| C | 10 | 0 | 121 | 163 | 30 |
| D | 10 | 0 | 214 | 243 | inside B |
| E | 10 | 0 | 172 | 193 | 250 |
| F | 10 | 0 | 1716 | 1811 | 150 |
| total | 10 | 0 | 3474 | 4021 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 70 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 481 ms; p90 516 ms; measured 10; unmeasured 0
- bootstrap entered: p50 126 ms; p90 158 ms; measured 10; unmeasured 0
- migration plan read: p50 124 ms; p90 136 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 76 ms; p90 97 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 39 ms; p90 45 ms; measured 10; unmeasured 0
- database writer ready: p50 38 ms; p90 39 ms; measured 10; unmeasured 0
- journal import: p50 26 ms; p90 31 ms; measured 10; unmeasured 0
- read-only database opened: p50 16 ms; p90 20 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 15 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 13 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 2 ms; p90 9 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 6 ms; p90 8 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 7 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 2 ms; p90 6 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 4 ms; p90 4 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 4 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 115 ms; offset 1789 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 162 ms; offset 2741 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 111 ms; offset 1526 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 123 ms; offset 1551 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 106 ms; offset 1821 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 103 ms; offset 1879 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 122 ms; offset 1982 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 105 ms; offset 1737 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 107 ms; offset 1554 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 106 ms; offset 1976 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 116 ms; offset 1903 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep

## Variant B, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 167 | 539 | 300 |
| B | 10 | 0 | 459 | 588 | 1000 |
| C | 10 | 0 | 39 | 609 | 30 |
| D | 10 | 0 | 281 | 685 | inside B |
| E | 10 | 0 | 228 | 719 | 250 |
| F | 10 | 0 | 76 | 2534 | 150 |
| total | 10 | 0 | 2695 | 3816 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 64 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 132 ms; p90 178 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 88 ms; p90 103 ms; measured 10; unmeasured 0
- migration plan read: p50 82 ms; p90 89 ms; measured 10; unmeasured 0
- database writer ready: p50 34 ms; p90 35 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 23 ms; p90 29 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 18 ms; measured 10; unmeasured 0
- read-only database opened: p50 15 ms; p90 17 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 17 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- journal import: p50 6 ms; p90 10 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 9 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 5 ms; p90 8 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 3 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 0 ms; p90 2 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 125 ms; offset 1247 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 161 ms; offset 1291 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 3: 126 ms; offset 1003 ms; before usable true; RPCs none; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 131 ms; offset 5142 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs; tasks provider usage warmup, model cache, snapshot pin sweep
- Launch 3: 223 ms; offset 5273 ms; before usable false; RPCs thread.startup.list, thread.startup.list, thread.startup.list, thread.startup.list, thread.startup.list, thread.startup.list, thread.startup.list, thread.startup.list, browserAutomation.host.register, browserAutomation.host.updateTargets, thread.syncPrs; tasks provider usage warmup, model cache
- Launch 3: 215 ms; offset 5496 ms; before usable false; RPCs thread.syncPrs; tasks provider usage warmup, model cache
- Launch 4: 107 ms; offset 1328 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 144 ms; offset 1713 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 123 ms; offset 1803 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 143 ms; offset 1723 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 8: 151 ms; offset 2637 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 176 ms; offset 1257 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 154 ms; offset 894 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

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
