# Packaged startup receipt

Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.

One discarded warm-up per key.

## Variant A

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 312 | 423 | 300 |
| B | 10 | 0 | 1544 | 1707 | 1000 |
| C | 10 | 0 | 79 | 219 | 30 |
| D | 10 | 0 | 308 | 465 | inside B |
| E | 10 | 0 | 305 | 331 | 250 |
| F | 10 | 0 | 107 | 1231 | 150 |
| total | 10 | 0 | 2886 | 3323 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 10; unsettled 0; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 69 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 750 ms; p90 785 ms; measured 10; unmeasured 0
- migration plan read: p50 272 ms; p90 352 ms; measured 10; unmeasured 0
- bootstrap entered: p50 193 ms; p90 278 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 120 ms; p90 134 ms; measured 10; unmeasured 0
- database writer ready: p50 52 ms; p90 63 ms; measured 10; unmeasured 0
- read-only database opened: p50 26 ms; p90 31 ms; measured 10; unmeasured 0
- auth token resolved: p50 16 ms; p90 28 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 20 ms; p90 25 ms; measured 10; unmeasured 0
- services resolved: p50 17 ms; p90 19 ms; measured 10; unmeasured 0
- dependency container initialized: p50 16 ms; p90 18 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 6 ms; p90 12 ms; measured 10; unmeasured 0
- family child interruption: p50 5 ms; p90 12 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 5 ms; p90 7 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 5 ms; p90 6 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 2 ms; p90 5 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- journal import: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 668 ms; offset 1772 ms; before usable true; RPCs none; tasks provider availability, snapshot pin sweep, codex version warmup, provider usage warmup, provider status, model cache
- Launch 1: 120 ms; offset 2699 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 1: 211 ms; offset 2819 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks snapshot pin sweep, provider usage warmup, provider status, model cache
- Launch 2: 160 ms; offset 2436 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 154 ms; offset 2371 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 3: 200 ms; offset 2525 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 143 ms; offset 2482 ms; before usable true; RPCs workspace.list, provider.catalog, settings.get, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 183 ms; offset 2625 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 106 ms; offset 16072 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 4: 238 ms; offset 32050 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 5: 107 ms; offset 2109 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 179 ms; offset 2216 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 6: 190 ms; offset 2087 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 118 ms; offset 6967 ms; before usable true; RPCs workspace.list, provider.catalog; tasks snapshot pin sweep
- Launch 7: 216 ms; offset 7085 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs; tasks snapshot pin sweep
- Launch 8: 179 ms; offset 2389 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 106 ms; offset 11510 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 9: 163 ms; offset 1929 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 208 ms; offset 3221 ms; before usable true; RPCs providers.listStatus, thread.syncPrs; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 100 ms; offset 3507 ms; before usable false; RPCs providers.listStatus, thread.syncPrs; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 9: 119 ms; offset 5928 ms; before usable false; RPCs none; tasks snapshot pin sweep
- Launch 9: 314 ms; offset 25745 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 215 ms; offset 2238 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 136 ms; offset 2453 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 577 ms; offset 25474 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 178 ms; offset 26213 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 294 ms; offset 26497 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 365 ms; offset 27125 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 122 ms; offset 30658 ms; before usable false; RPCs provider.catalog; tasks none

## Variant B

| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |
| --- | --- | --- | --- | --- | --- |
| A | 10 | 0 | 331 | 479 | 300 |
| B | 10 | 0 | 1462 | 2069 | 1000 |
| C | 10 | 0 | 159 | 205 | 30 |
| D | 10 | 0 | 307 | 8056 | inside B |
| E | 10 | 0 | 288 | 683 | 250 |
| F | 10 | 0 | 96 | 1242 | 150 |
| total | 10 | 0 | 3344 | 9436 | 2000 |

10 launches; 0 failed and excluded from percentiles; settled 7; unsettled 3; settled unmeasured 0.
Total p50 budget: 1500 ms. Thread reopened: false.
RPCs: at most 68 answered and 0 unanswered in one window; 0 dropped past the cap.

Server steps by p90:
- execution workers ready: p50 712 ms; p90 988 ms; measured 10; unmeasured 0
- checkpoint interrupted: p50 34 ms; p90 866 ms; measured 10; unmeasured 0
- bootstrap entered: p50 184 ms; p90 256 ms; measured 10; unmeasured 0
- migration plan read: p50 167 ms; p90 231 ms; measured 10; unmeasured 0
- orphan cleanup completed: p50 120 ms; p90 181 ms; measured 10; unmeasured 0
- database writer ready: p50 49 ms; p90 78 ms; measured 10; unmeasured 0
- journal import: p50 30 ms; p90 43 ms; measured 10; unmeasured 0
- read-only database opened: p50 23 ms; p90 37 ms; measured 10; unmeasured 0
- dependency container initialized: p50 16 ms; p90 24 ms; measured 10; unmeasured 0
- services resolved: p50 16 ms; p90 22 ms; measured 10; unmeasured 0
- auth token resolved: p50 13 ms; p90 16 ms; measured 10; unmeasured 0
- conversation display materialization completed: p50 7 ms; p90 13 ms; measured 10; unmeasured 0
- stale startup work recovery completed: p50 8 ms; p90 11 ms; measured 10; unmeasured 0
- orphaned background tools settled: p50 4 ms; p90 7 ms; measured 10; unmeasured 0
- snapshot store ID ensured: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- HTTP listener opened: p50 4 ms; p90 5 ms; measured 10; unmeasured 0
- external thread control reconciled: p50 1 ms; p90 4 ms; measured 10; unmeasured 0
- family child interruption: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- automatic workspace setup reconciled: p50 2 ms; p90 3 ms; measured 10; unmeasured 0
- terminal checkpoint reopening: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- terminal checkpoint retirement: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- approval recovery completed: p50 2 ms; p90 2 ms; measured 10; unmeasured 0
- IPC listener opened: p50 1 ms; p90 2 ms; measured 10; unmeasured 0
- runtime flags resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- schema patches applied: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- turn reconciliation: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- abandoned evidence resolved: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- interrupted plans recovered: p50 1 ms; p90 1 ms; measured 10; unmeasured 0
- resume scheduler started: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- coordinator wake recovered: p50 0 ms; p90 1 ms; measured 10; unmeasured 0
- configuration resolved and shutdown marker inspected: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- native questions recovered: p50 0 ms; p90 0 ms; measured 10; unmeasured 0
- turn recovery completed: p50 0 ms; p90 0 ms; measured 10; unmeasured 0

Stalls and overlapping candidate causes (not proof):
- Launch 1: 141 ms; offset 1849 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 1: 233 ms; offset 18342 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 2: 100 ms; offset 2131 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 165 ms; offset 2231 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.startup.list, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 2: 101 ms; offset 6474 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 3: 104 ms; offset 8770 ms; before usable true; RPCs workspace.list, provider.catalog; tasks snapshot pin sweep
- Launch 3: 201 ms; offset 8874 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs; tasks snapshot pin sweep
- Launch 4: 156 ms; offset 3363 ms; before usable true; RPCs workspace.list, provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 4: 258 ms; offset 3641 ms; before usable false; RPCs workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 257 ms; offset 2235 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 5: 106 ms; offset 10135 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 6: 148 ms; offset 5558 ms; before usable true; RPCs settings.get, app.stage, workspace.icon.resolve, thread.syncPrs; tasks provider usage warmup, snapshot pin sweep
- Launch 7: 129 ms; offset 3936 ms; before usable true; RPCs none; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 7: 151 ms; offset 7002 ms; before usable true; RPCs none; tasks snapshot pin sweep
- Launch 7: 108 ms; offset 9266 ms; before usable true; RPCs workspace.list, provider.catalog; tasks snapshot pin sweep
- Launch 7: 3055 ms; offset 9374 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs; tasks snapshot pin sweep
- Launch 7: 100 ms; offset 30625 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 8: 121 ms; offset 2088 ms; before usable true; RPCs provider.catalog, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 158 ms; offset 2209 ms; before usable true; RPCs app.stage, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 8: 218 ms; offset 29671 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 9: 216 ms; offset 9054 ms; before usable true; RPCs settings.get; tasks snapshot pin sweep
- Launch 9: 571 ms; offset 9839 ms; before usable true; RPCs workspace.list, provider.catalog, settings.get; tasks snapshot pin sweep
- Launch 9: 270 ms; offset 10410 ms; before usable false; RPCs app.stage, thread.syncPrs; tasks snapshot pin sweep
- Launch 9: 803 ms; offset 10680 ms; before usable false; RPCs workspace.icon.resolve, thread.startup.list, thread.syncPrs; tasks snapshot pin sweep
- Launch 9: 151 ms; offset 21495 ms; before usable false; RPCs none; tasks none
- Launch 10: 166 ms; offset 2145 ms; before usable true; RPCs settings.get, workspace.icon.resolve, thread.syncPrs, providers.listStatus; tasks provider usage warmup, provider status, model cache, snapshot pin sweep
- Launch 10: 108 ms; offset 5834 ms; before usable false; RPCs none; tasks snapshot pin sweep
- Launch 10: 186 ms; offset 6251 ms; before usable false; RPCs provider.catalog; tasks snapshot pin sweep
- Launch 10: 169 ms; offset 24730 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 209 ms; offset 25209 ms; before usable false; RPCs provider.catalog; tasks none
- Launch 10: 310 ms; offset 26525 ms; before usable false; RPCs provider.catalog; tasks none

Donor versus fixture statistics:

| Table | Donor | A | B |
| --- | --- | --- | --- |
| workspaces | 24 | 24 | 24 |
| threads | 287 | 26 | 26 |
| messages | 4163 | 333 | 334 |
| tool_call_records | 12373 | 2066 | 2066 |
| turn_snapshots | 144 | 0 | 0 |
| thread_tasks | 16 | 0 | 0 |
| _migrations | 23 | 0 | 0 |
| __drizzle_migrations | 110 | 110 | 110 |
| provider_model_cache | 6 | 6 | 6 |
| hook_executions | 238 | 4 | 4 |
| thought_segments | 4490 | 382 | 382 |
| pull_request_review_links | 0 | 0 | 0 |
| provider_catalog_snapshots | 808 | 808 | 808 |
| workspace_worktrees | 303 | 0 | 0 |
| thread_control_approvals | 0 | 0 | 0 |
| thread_control_audit | 60 | 27 | 27 |
| external_thread_control_pairings | 0 | 0 | 0 |
| external_thread_control_deliveries | 0 | 0 | 0 |
| canonical_agent_events | 216758 | 596 | 600 |
| canonical_agent_ingest_checkpoints | 1976 | 0 | 1 |
| canonical_agent_items | 117210 | 1863 | 1864 |
| canonical_agent_threads | 279 | 26 | 26 |
| canonical_agent_turns | 1976 | 143 | 144 |
| canonical_collaboration_actions | 47 | 0 | 0 |
| workspace_terminal_preferences | 0 | 0 | 0 |
| canonical_legacy_message_provenance | 3779 | 331 | 331 |
| canonical_legacy_migration_checkpoints | 1 | 1 | 1 |
| terminal_cleanup_ledger | 0 | 0 | 0 |
| cleanup_jobs | 0 | 0 | 0 |
| workspace_environment_automatic_setup_attempts | 7 | 0 | 0 |
| workspace_environment_queued_turns | 18 | 0 | 0 |
| workspace_environment_setup_gates | 18 | 0 | 0 |
| parent_assistant_text_checkpoint_chunks | 160 | 0 | 0 |
| parent_assistant_text_checkpoints | 15 | 0 | 0 |
| project_action_runs | 5 | 0 | 0 |
| workspace_environment_command_approvals | 0 | 0 | 0 |
| workspace_environment_storage_settings | 14 | 14 | 14 |
| thread_startups | 283 | 0 | 0 |
| turn_diff_snapshots | 33 | 0 | 0 |
| canonical_conversation_display_mappings | 19733 | 1645 | 1646 |
| conversation_display_materialization_state | 1 | 1 | 1 |
| canonical_writer_operation_receipts | 697 | 8 | 8 |
| canonical_writer_live_publication_heads | 92 | 2 | 2 |
| canonical_writer_thread_operation_receipts | 0 | 0 | 0 |
| store_identity | 1 | 0 | 0 |
| plans | 0 | 0 | 0 |
| git_commit_requests | 0 | 0 | 0 |
| approval_receipts | 0 | 0 | 0 |
| turn_steers | 32 | 0 | 0 |
| turn_reverts | 0 | 0 | 0 |
| provider_model_sightings | 304 | 304 | 304 |
| turn_resume_schedules | 0 | 0 | 0 |
| plan_implement_requests | 0 | 0 | 0 |
| plan_comments | 0 | 0 | 0 |
| plan_question_answers | 0 | 0 | 0 |
| mcode_schema_compatibility | 1 | 1 | 1 |
| thread_provider_sessions | 225 | 0 | 0 |
| delegated_tasks | 77 | 0 | 0 |
| thread_pull_requests | 1 | 0 | 0 |
| canonical_agent_item_content_appends | 0 | 0 | 0 |
| turn_file_evidence | 112 | 0 | 0 |
| worktreeThreads | 135 | 0 | 0 |
| openOrDraftPrThreads | 1 | 0 | 0 |
| fileBytes | 2010206208 | 105164800 | 105205760 |
| freelistCount | 266047 | 0 | 0 |
