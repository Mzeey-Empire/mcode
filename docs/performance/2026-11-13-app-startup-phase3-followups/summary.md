# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 153 | 168 | 300 |
| B | 10 | 0 | 503 | 526 | 1000 |
| C | 10 | 0 | 22 | 37 | 30 |
| D | 10 | 0 | 203 | 255 | inside B |
| E | 10 | 0 | 236 | 243 | 250 |
| F | 10 | 0 | 89 | 94 | 150 |
| total | 10 | 0 | 1022 | 1201 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 63 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 141 ms; p90 168 ms; measured 10; unmeasured 0
- migration plan read: p50 145 ms; p90 157 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 89 ms; p90 115 ms; measured 10; unmeasured 0
- database writer ready: p50 33 ms; p90 36 ms; measured 10; unmeasured 0
- read-only database opened: p50 17 ms; p90 22 ms; measured 10; unmeasured 0
- dependency container initialized: p50 12 ms; p90 14 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 14 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 8 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 3 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 130 ms; offset 982 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 144 ms; offset 1015 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 3: 123 ms; offset 963 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 124 ms; offset 963 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 151 ms; offset 980 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 134 ms; offset 961 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 144 ms; offset 952 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 8: 142 ms; offset 1148 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 183 ms; offset 1187 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 144 ms; offset 949 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

## Variant A, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 156 | 212 | 300 |
| B | 10 | 0 | 503 | 580 | 1000 |
| C | 10 | 0 | 22 | 31 | 30 |
| D | 10 | 0 | 200 | 237 | inside B |
| E | 10 | 0 | 238 | 259 | 250 |
| F | 10 | 0 | 88 | 94 | 150 |
| total | 10 | 0 | 1030 | 1182 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 62 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 136 ms; p90 216 ms; measured 10; unmeasured 0
- migration plan read: p50 144 ms; p90 201 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 91 ms; p90 96 ms; measured 10; unmeasured 0
- database writer ready: p50 35 ms; p90 36 ms; measured 10; unmeasured 0
- read-only database opened: p50 18 ms; p90 24 ms; measured 10; unmeasured 0
- services resolved: p50 12 ms; p90 14 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 13 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 7 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 132 ms; offset 1125 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 154 ms; offset 1111 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 164 ms; offset 956 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 142 ms; offset 947 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 134 ms; offset 964 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 113 ms; offset 1002 ms; before usable true; RPCs providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 6: 137 ms; offset 1166 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 7: 165 ms; offset 974 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 8: 121 ms; offset 988 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 128 ms; offset 1070 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 10: 153 ms; offset 1043 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

## Variant B, baseline

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 168 | 217 | 300 |
| B | 10 | 0 | 467 | 558 | 1000 |
| C | 10 | 0 | 16 | 24 | 30 |
| D | 10 | 0 | 202 | 233 | inside B |
| E | 10 | 0 | 244 | 260 | 250 |
| F | 10 | 0 | 88 | 97 | 150 |
| total | 10 | 0 | 1010 | 1196 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 62 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 138 ms; p90 231 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 93 ms; p90 104 ms; measured 10; unmeasured 0
- migration plan read: p50 84 ms; p90 93 ms; measured 10; unmeasured 0
- database writer ready: p50 34 ms; p90 37 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 23 ms; p90 25 ms; measured 10; unmeasured 0
- read-only database opened: p50 17 ms; p90 22 ms; measured 10; unmeasured 0
- services resolved: p50 13 ms; p90 15 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 14 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 4 ms; p90 10 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 9 ms; measured 10; unmeasured 0
- journal import: p50 7 ms; p90 8 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 3 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 108 ms; offset 2071 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 131 ms; offset 979 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 138 ms; offset 1069 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 4: 162 ms; offset 945 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 5: 158 ms; offset 932 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 162 ms; offset 1064 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 154 ms; offset 1074 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 8: 176 ms; offset 903 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 9: 147 ms; offset 926 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 10: 157 ms; offset 1126 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

## Variant B, candidate

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 154 | 237 | 300 |
| B | 10 | 0 | 488 | 582 | 1000 |
| C | 10 | 0 | 22 | 31 | 30 |
| D | 10 | 0 | 198 | 235 | inside B |
| E | 10 | 0 | 233 | 255 | 250 |
| F | 10 | 0 | 80 | 99 | 150 |
| total | 10 | 0 | 997 | 1155 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 62 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- bootstrap entered: p50 136 ms; p90 224 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 99 ms; p90 108 ms; measured 10; unmeasured 0
- migration plan read: p50 85 ms; p90 91 ms; measured 10; unmeasured 0
- database writer ready: p50 33 ms; p90 36 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 25 ms; p90 28 ms; measured 10; unmeasured 0
- read-only database opened: p50 17 ms; p90 23 ms; measured 10; unmeasured 0
- services resolved: p50 14 ms; p90 17 ms; measured 10; unmeasured 0
- dependency container initialized: p50 13 ms; p90 13 ms; measured 10; unmeasured 0
- auth token resolved: p50 10 ms; p90 11 ms; measured 10; unmeasured 0
- journal import: p50 7 ms; p90 10 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 6 ms; p90 8 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 3 ms; p90 5 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 5 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 4 ms; p90 4 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 3 ms; p90 3 ms; measured 10; unmeasured 0
- family child interruption: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- execution workers ready: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 161 ms; offset 923 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 2: 110 ms; offset 969 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 3: 147 ms; offset 1202 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 4: 143 ms; offset 1128 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 5: 144 ms; offset 913 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 6: 137 ms; offset 924 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 7: 174 ms; offset 949 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 8: 162 ms; offset 1012 ms; before usable true; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 128 ms; offset 935 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 10: 158 ms; offset 1039 ms; before usable true; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache

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
