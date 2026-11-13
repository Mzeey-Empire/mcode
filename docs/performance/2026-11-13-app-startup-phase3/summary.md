# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 155 | 206 | 300 |
| B | 10 | 0 | 498 | 537 | 1000 |
| C | 10 | 0 | 25 | 243 | 30 |
| D | 10 | 0 | 249 | 749 | inside B |
| E | 10 | 0 | 219 | 230 | 250 |
| F | 10 | 0 | 2059 | 2654 | 150 |
| total | 10 | 0 | 3282 | 3760 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 68 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 131 ms; p90 162 ms; measured 10; unmeasured 0
- migration plan read: p50 144 ms; p90 160 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 92 ms; p90 117 ms; measured 10; unmeasured 0
- database writer ready: p50 32 ms; p90 41 ms; measured 10; unmeasured 0
- read-only database opened: p50 16 ms; p90 19 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 16 ms; measured 10; unmeasured 0
- dependency container initialized: p50 12 ms; p90 13 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 10 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 5 ms; p90 8 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 2 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 179 ms; offset 896 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 2: 139 ms; offset 1408 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 161 ms; offset 1693 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 155 ms; offset 927 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 5: 147 ms; offset 1065 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 151 ms; offset 1045 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 141 ms; offset 1039 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 8: 152 ms; offset 1336 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 9: 180 ms; offset 1061 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 113 ms; offset 1501 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

## Variant A, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 169 | 242 | 300 |
| B | 10 | 0 | 491 | 538 | 1000 |
| C | 10 | 0 | 30 | 156 | 30 |
| D | 10 | 0 | 214 | 325 | inside B |
| E | 10 | 0 | 224 | 239 | 250 |
| F | 10 | 0 | 67 | 92 | 150 |
| total | 10 | 0 | 1047 | 1794 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 63 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 135 ms; p90 167 ms; measured 10; unmeasured 0
- migration plan read: p50 145 ms; p90 160 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 91 ms; p90 99 ms; measured 10; unmeasured 0
- database writer ready: p50 32 ms; p90 36 ms; measured 10; unmeasured 0
- read-only database opened: p50 17 ms; p90 18 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 15 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 14 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 12 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 7 ms; p90 8 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 188 ms; offset 1017 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 2: 153 ms; offset 968 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 158 ms; offset 997 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 4: 191 ms; offset 1166 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 5: 166 ms; offset 965 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 143 ms; offset 1731 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 171 ms; offset 924 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 8: 165 ms; offset 1376 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 145 ms; offset 935 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 144 ms; offset 1922 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

## Variant B, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 164 | 219 | 300 |
| B | 10 | 0 | 473 | 535 | 1000 |
| C | 10 | 0 | 20 | 50 | 30 |
| D | 10 | 0 | 219 | 327 | inside B |
| E | 10 | 0 | 220 | 246 | 250 |
| F | 10 | 0 | 2400 | 2542 | 150 |
| total | 10 | 0 | 3276 | 3473 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 67 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 136 ms; p90 212 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 90 ms; p90 106 ms; measured 10; unmeasured 0
- migration plan read: p50 85 ms; p90 98 ms; measured 10; unmeasured 0
- database writer ready: p50 33 ms; p90 36 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 23 ms; p90 25 ms; measured 10; unmeasured 0
- read-only database opened: p50 17 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 17 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 16 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 14 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 10 ms; measured 10; unmeasured 0
- journal import: p50 5 ms; p90 9 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 6 ms; p90 7 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 135 ms; offset 929 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 148 ms; offset 1771 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 170 ms; offset 1847 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 129 ms; offset 902 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 5: 171 ms; offset 1157 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 6: 151 ms; offset 909 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 7: 122 ms; offset 905 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 8: 136 ms; offset 1033 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 9: 158 ms; offset 879 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 165 ms; offset 958 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache

## Variant B, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 156 | 521 | 300 |
| B | 10 | 0 | 462 | 542 | 1000 |
| C | 10 | 0 | 115 | 207 | 30 |
| D | 10 | 0 | 285 | 719 | inside B |
| E | 10 | 0 | 224 | 243 | 250 |
| F | 10 | 0 | 81 | 107 | 150 |
| total | 10 | 0 | 1320 | 1520 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 62 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 132 ms; p90 154 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 88 ms; p90 120 ms; measured 10; unmeasured 0
- migration plan read: p50 84 ms; p90 99 ms; measured 10; unmeasured 0
- database writer ready: p50 31 ms; p90 42 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 25 ms; p90 29 ms; measured 10; unmeasured 0
- read-only database opened: p50 15 ms; p90 19 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 17 ms; measured 10; unmeasured 0
- dependency container initialized: p50 12 ms; p90 14 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 12 ms; measured 10; unmeasured 0
- journal import: p50 7 ms; p90 10 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 5 ms; p90 9 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 9 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 5 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- execution workers ready: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 121 ms; offset 1487 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 159 ms; offset 2157 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 219 ms; offset 1397 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 130 ms; offset 933 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 123 ms; offset 1287 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 158 ms; offset 1191 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 149 ms; offset 1389 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 8: 184 ms; offset 1123 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 9: 153 ms; offset 1214 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 10: 189 ms; offset 1267 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

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
