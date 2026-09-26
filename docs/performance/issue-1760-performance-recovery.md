# Issue 1760: performance recovery

Measured on September 25, 2026, on Windows with Bun 1.4.1. This record follows
the [original comparison](issue-1760-seven-task-evidence.md). It preserves that
earlier result and reports the optimized runtime at `8a498f7a` separately.
The later `cc6f0ec7` changes a test's floating-point assertion only.

The optimized version improves all five nonzero metric medians from the
initial PR. Its median largest logged pause remains zero. Four of six medians
also improve on the original implementation. Peak public event rate and sampled
memory still miss the original targets. The request to improve every original
metric is therefore not fully met.

## Ten-run comparison

Each cell contains the median, followed by the minimum and maximum in brackets.
Times are milliseconds. Lower is better except for public event rate.

| Metric | Original implementation | Initial PR | Optimized PR |
| --- | ---: | ---: | ---: |
| Largest logged server pause | 6491 [4893, 8079] | 0 [0, 1096] | 0 [0, 0] |
| Per-run task completion p95 | 32931 [22705, 47756] | 72911 [70481, 75846] | 26053 [23928, 30139] |
| Peak public events per second | 231 [177, 270] | 147.5 [138, 156] | 205.5 [170, 219] |
| Maximum sampled server working set, MiB | 446.4 [367.5, 623.9] | 588.7 [538.2, 627.6] | 458.3 [430.9, 493.1] |
| Terminal creation | 746 [103, 25863] | 196 [166, 1008] | 175.6 [126.9, 608.9] |
| Model list | 29 [11, 133] | 35 [7, 476] | 19.6 [5.0, 117.9] |

Against the initial PR, completion takes 64.3% less time, peak event rate is
39.3% higher, and sampled memory is 22.2% lower. Terminal creation takes 10.4%
less time and model listing takes 44.0% less time.

Against the original implementation, completion takes 20.9% less time.
Peak event rate remains 11.0% lower and sampled memory remains 2.7% higher.
Those two remaining gaps are not evidence of a proven performance ceiling.

## Workload and measurement limits

The unchanged public harness starts seven direct Codex tasks and one terminal
in this worktree's fixture repository. Each provider fixture emits 120 tool
pairs. The benchmark uses the checked-in provider fixture, without upstream
model calls. The separate desktop checks below use the real Codex provider.

- Completion is the p95 completion time among each run's seven tasks, then the
  median of those ten values. It is not a pooled p95 across all 70 tasks.
- Event rate is the largest one-second bucket of public event arrivals. It is
  not average processing throughput.
- Memory is the maximum of three server working-set samples, taken before
  dispatch, after the turns, and after cleanup. It is not a continuous peak.
  This clarifies the earlier document's shorter label, "peak server memory."
- A zero pause means no delay was logged by the default diagnostic. It does not
  mean that the event loop had zero latency.
- Terminal and model timings are one request per run while tasks are active.
- The original baseline is `15fa7030ad09b5c2d083efeb2e0670b68277220c`. The initial
  PR runtime is `0a73175d`. These historical cohorts used the same host and
  workload at different times. Host load was not held constant.
- No tests or builds ran concurrently with this final cohort. An unrelated
  server process consumed roughly one CPU core during it. Its contribution to
  the remaining differences was not established.

All ten optimized runs passed event ordering, duplicate and missing-event
checks, persisted conversation audits, and fixture-only cleanup. Each delivered
3466 public events. The maximum queue observations were seven pending commands,
one queued command per worker, and four in flight. The original baseline did
not record a comparable queue depth.

## Every optimized run

All rows had zero logged main-server pauses. Memory is MiB and times are ms.

| Run | Completion p95 | Peak events/s | Sampled memory | Terminal | Models |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 29904.329 | 179 | 430.895 | 608.941 | 117.923 |
| 2 | 30139.381 | 187 | 453.777 | 325.490 | 16.305 |
| 3 | 29335.843 | 170 | 444.551 | 230.683 | 25.523 |
| 4 | 25944.837 | 209 | 454.813 | 139.852 | 27.889 |
| 5 | 24035.207 | 208 | 437.164 | 196.337 | 55.097 |
| 6 | 26161.430 | 216 | 472.516 | 171.915 | 5.037 |
| 7 | 29806.950 | 180 | 471.328 | 178.944 | 10.793 |
| 8 | 25148.070 | 203 | 493.098 | 126.890 | 18.474 |
| 9 | 24624.156 | 213 | 474.363 | 172.181 | 18.552 |
| 10 | 23927.607 | 219 | 461.770 | 145.625 | 20.682 |

The local cohort manifest is `.dev/verification/issue-1760/final-cohort.json`.
Each receipt is under `.dev/verification/performance/seven-thread-live/`, in
the following directory, with filename `receipt.json`. These names identify
local artifacts; the table above is the committed reviewable result.

```text
after-2026-09-25T21-10-23-813Z-4bf144ab-f4b5-49df-88d4-8c80a0d0b9d8
after-2026-09-25T21-10-56-894Z-a115cc20-328a-4dea-a2b3-d31faffde650
after-2026-09-25T21-11-30-031Z-c95b34d0-9f6d-44ed-b57a-804f8ff6d0db
after-2026-09-25T21-12-03-033Z-e8d1e249-9f15-453c-9d18-afd9581fac85
after-2026-09-25T21-12-32-933Z-9ad255f1-fd1f-4b16-8291-56ef49b7f660
after-2026-09-25T21-12-59-911Z-4e4ab32b-7281-4bdf-9219-125ae026753b
after-2026-09-25T21-13-28-694Z-5b62691c-9ce3-4d20-b2d9-2db090e395bd
after-2026-09-25T21-14-01-558Z-d7ca1563-f27f-4bf2-9884-f9d2559a47ed
after-2026-09-25T21-14-29-420Z-c22652c7-ec2a-4424-866d-682b5f8ddd60
after-2026-09-25T21-14-56-624Z-c24b17b0-d971-494d-b3db-36f4a028f7cf
```

The public workload is reproducible with:

```powershell
bun scripts/perf/seven-thread-live-harness.mjs --run --confirm-run --label after
```

## Changes supported by the measurements

The first trace found repeated whole-thread loads during terminal writes.
Loading transaction-local terminal state reduced 1701 loads taking 18.312 s
to 66 loads taking 26 ms in the scoped comparison. Reusing consecutive
narrative message resolutions and prepared queries removed more repeated work.
The resolver preserves the original lookup order when multiple canonical
sources share a display message.

The writer now groups already-ready independent appends within bounds of eight
operations, 512 KiB, and 16 ms. It adds no fill delay. Repeated executions and
control operations remain ordering barriers. Acknowledgments and publication
wait for the physical commit. A failed group rolls back and retries semantic
writes individually, without replaying provider actions. One operation can
exceed the time bound before the next boundary check.

The remaining changes reduce allocation and startup work. Worker bundles omit
unused schemas. Legacy event workers start on their first event. Recovery
checkpoints copy changed tool records and calculate deltas before cloning.
Admission persists turn settings in one atomic row update. Worker collection
and guarded idle collection release completed execution memory. The execution
pool remains at four workers. Legacy providers now pay worker startup on their
first event.

These changes were measured incrementally and checked with focused behavior
tests. The final ten-run cohort measures their combined effect. A single
exploratory run does not establish the isolated benefit of each change.

Several alternatives were rejected. Eight workers did not recover completion
speed. A later three-worker trial reduced memory to 399.9 MiB but took 33.648 s
and reached only 148 events/s. A 1 ms group fill delay also reduced throughput.
Forced full collection during active critical memory pressure reduced memory
but harmed throughput. None of those experiments is the shipped configuration.

## Cancellation and remaining startup pause

The separate Stop-one run returned in 1103 ms. It cancelled only the selected
third task. All six peers completed, and all seven persisted audits passed.
The cancelled reconnect snapshot and cleanup also passed. No server pause was
logged. The receipt directory is:

```text
after-stop-one-2026-09-25T21-15-34-504Z-a763a605-5150-484e-8fcc-7b80ce3738a4
```

A separate run with `MCODE_SERVER_WORK_TRACE=1` passed the same correctness
checks. It recorded an 842 ms startup pause about 1.5 seconds into the run.
The work trace measured the same incident at 835.6 ms. Its window contained
seven publication samples, each below 0.34 ms, with no main-thread event
application or finalization samples. Later trace windows also contained no
event application or finalization work. This does not identify the startup
pause's cause. It remains covered by
[issue #1767](https://github.com/Mzeey-Empire/mcode/issues/1767).

The traced run's receipt directory is:

```text
after-2026-09-25T21-17-05-673Z-e750de8c-5e38-46e9-9a1f-1eb3732938fe
```

## Desktop checks and automated checks

The owned Electron app used the freshly built server bundle and its separate
worktree-local database. Two new direct fixture tasks used real Codex with
GPT-5.6 Luna. The reply `ISSUE1760_RECOVERY_FINAL_PASS` survived reload and task
reopening. Both stopped turns retained their partial replies and "You stopped"
state after reload. The public conversation API independently returned the
persisted messages. Only the two recorded task IDs were deleted during cleanup.

Five warm model-picker opens took 62.8 to 100.8 ms, with a median of 76.3 ms.
Five task switches took 372.7 to 608.2 ms, with a median of 416.0 ms. A terminal
reached its fixture PowerShell prompt in 1189 ms. PowerShell printed the expected
command marker. Command output timing is excluded because an earlier identical
marker was already present. These are current-build observations, not a matched
desktop speed comparison.

The first Stop measurement took 4775 ms from the Playwright action call to the
"Stopping" state. It includes actionability waiting and did not measure final
idle restoration. A second check recorded the actual DOM click and restored
the idle composer after 591 ms, or 718 ms from the Playwright action call.
Both cancellations completed. These observations do not establish a Stop
latency distribution or prove that every desktop Stop meets the 2 s target.
Local captures and timings are under `.dev/verification/issue-1760/final-ui-*`.

Focused checks cover transaction rollback, commit failure, peer isolation,
duplicate delivery, recovery bounds, cloning ownership, atomic settings,
legacy worker startup, and memory collection guards. Existing provider checks
cover Claude and Cursor adapters. There is no new live performance claim for
those providers.

At `cc6f0ec7`, CI passed tests, lint, typecheck, build, and Linux canary
packaging. The earlier trace test failed on `220.00000000000006` versus `220`.
Its assertion now allows floating-point arithmetic error. Production timing
behavior did not change.
