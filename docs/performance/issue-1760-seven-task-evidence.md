# Issue 1760: seven-task evidence

Measured on Windows with Bun 1.4.1 and the public seven-task fixture harness. The
baseline was `15fa7030ad09b5c2d083efeb2e0670b68277220c`; the candidate
runtime was merge commit `0a73175d`. Each row is one sequential run with seven
Codex tasks and one terminal. All 20 runs passed the persisted reload audit,
had no missing, duplicate, or reordered events, and cleaned up their own
resources. The candidate uses four execution workers. The diagnostic-only fix
in `fe98cec3` does not change the default runtime path.

`Stall` is the largest logged main-server event-loop delay during the run; zero
means none was logged. `Rate` is the largest one-second bucket of public event
arrivals. The baseline rate is derived from its saved arrival timestamps using
the candidate harness's bucket formula. `Memory` is peak server working set in
MiB. `Finish` is the p95 completion time among that run's seven tasks. Terminal
and models are the single RPC observation in each run. Times are milliseconds.

| Run | Events | Stall | Rate/s | Memory | Finish | Terminal | Models | Queued/worker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before 1 | 3458 | 7775 | 177 | 378.6 | 47756 | 24197 | 133 | unavailable |
| Before 2 | 3458 | 8079 | 245 | 623.9 | 29606 | 2605 | 40 | unavailable |
| Before 3 | 3458 | 6956 | 250 | 445.4 | 26953 | 25863 | 14 | unavailable |
| Before 4 | 3458 | 6483 | 270 | 447.3 | 25621 | 809 | 35 | unavailable |
| Before 5 | 3458 | 5871 | 259 | 460.8 | 24854 | 684 | 119 | unavailable |
| Before 6 | 3458 | 6322 | 200 | 367.5 | 36525 | 7115 | 128 | unavailable |
| Before 7 | 3458 | 7096 | 207 | 538.0 | 36256 | 133 | 24 | unavailable |
| Before 8 | 3459 | 6309 | 208 | 533.1 | 37795 | 146 | 11 | unavailable |
| Before 9 | 3459 | 6499 | 217 | 394.1 | 38664 | 117 | 16 | unavailable |
| Before 10 | 3459 | 4893 | 258 | 417.6 | 22705 | 103 | 24 | unavailable |
| After 1 | 3465 | 0 | 147 | 555.3 | 73301 | 200 | 18 | 1 |
| After 2 | 3466 | 0 | 138 | 538.2 | 75846 | 217 | 52 | 1 |
| After 3 | 3466 | 0 | 148 | 574.3 | 73599 | 176 | 9 | 1 |
| After 4 | 3466 | 0 | 149 | 576.4 | 75128 | 284 | 56 | 1 |
| After 5 | 3466 | 0 | 148 | 592.4 | 72390 | 205 | 36 | 1 |
| After 6 | 3466 | 0 | 142 | 590.1 | 72521 | 193 | 7 | 1 |
| After 7 | 3466 | 0 | 156 | 602.7 | 70955 | 166 | 49 | 1 |
| After 8 | 3466 | 0 | 141 | 627.6 | 75179 | 181 | 17 | 1 |
| After 9 | 3466 | 0 | 156 | 608.3 | 70481 | 175 | 34 | 1 |
| After 10 | 3466 | 1096 | 142 | 587.2 | 71338 | 1008 | 476 | 1 |

| Metric | Before median (range) | After median (range) |
| --- | ---: | ---: |
| Largest server pause, ms | 6491 (4893–8079) | 0 (0–1096) |
| Peak public events/s | 231 (177–270) | 147.5 (138–156) |
| Peak server memory, MiB | 446.4 (367.5–623.9) | 588.7 (538.2–627.6) |
| Per-run finish p95, ms | 32931 (22705–47756) | 72911 (70481–75846) |
| Terminal creation, ms | 746 (103–25863) | 196 (166–1008) |
| Model list, ms | 29 (11–133) | 35 (7–476) |

The candidate queue had at most seven pending commands and one queued command
per worker. The baseline harness did not record a comparable queue depth.
The change sharply reduced the observed long server pauses and kept the tested
controls within their budgets. It also reduced peak event throughput by about
36%, more than doubled completion p95, and raised median peak working set by
about 142 MiB. These are material costs, not an overall latency win. An
exploratory eight-worker run did not improve completion and used more memory;
the fixed pool remains at four.

The stopped-task run durably cancelled only its selected execution, while the
six peers completed in order. Stop returned in 584 ms and terminal creation in
914 ms; cleanup passed. It recorded a 770 ms server pause 1.25 seconds after
startup. After run 10 recorded 1096 ms at 1.73 seconds, while provider sends
and terminal startup were active. Work tracing was off for these default runs,
so the exact operation causing either pause is unknown. They must not be
credited to, or ruled out from, a specific operation solely from timestamps.

During follow-up, enabling the old `MCODE_SERVER_WORK_TRACE` also enabled it
inside the SQLite writer worker. That worker's pauses were incorrectly counted
as server-loop pauses. `fe98cec3` limits this trace to the main thread. Ten
additional seven-task runs with the corrected trace all passed, with largest
main-server delays of 312, 242, 272, 325, 471, 306, 244, 228, 316, and 430 ms.
Their traces recorded no main-thread event application or finalization work for
these worker-owned Codex turns. Those runs did not reproduce either default-run
pause above 500 ms; the intermittent startup pause is tracked in
[issue #1767](https://github.com/Mzeey-Empire/mcode/issues/1767).

On the owned Electron app, a real Codex reply remained visible after reload;
the model picker opened in 58 ms, task switch in 1004 ms, terminal prompt in
2338 ms, and a PowerShell command printed in 269 ms. Stop cleared its button
in 119 ms. After reload the prompt remained, the Stop button was absent, and
SQLite showed a `Cancelled` turn with a `cancelled` ingest checkpoint. These
are individual desktop observations, not latency distributions. Claude and
Cursor adapter behavior was checked by focused tests, not live provider runs.
