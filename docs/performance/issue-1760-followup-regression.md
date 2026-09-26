# Follow-up completion regression, 2026-09-25

## Reproduction

The owned Electron dev app at `bb1e241d` reproduced the reported failure with
real Codex `gpt-5.6-luna`. The first message completed. The second reply arrived
and the server persisted a completed turn in about three seconds, but the UI
still showed Thinking and Stop after 50 seconds. Public `agent.activeCount` was
zero while the renderer retained `runtimePhase: running` and a null execution ID.

The earlier completion, Stop, reload, and seven-task benchmark checks did not
cover consecutive successful follow-ups. Those results did not establish that
this interaction worked.

## Cause and correction

Optimistic send clears the execution ID and marks the task running. Worker-owned
`turnStarted` supplies a new execution ID without optional file-effect metadata.
The renderer compared two empty file-effect IDs, incorrectly classified the
start as a duplicate, and skipped binding the execution. Terminal events then
failed the execution ownership check.

The duplicate guard now also checks execution identity. It still preserves the
existing file-generation comparison, duplicate-start behavior, and stale-event
fence. No backend scheduling or persistence behavior changed in this correction.

## Verification

The same owned Electron app was cleanly relaunched with the renderer fix.
All task mutations used this worktree's `.dev/fixture-repo`.

| Real Codex desktop action | Observed result |
| --- | --- |
| First prompt and short follow-up | Replies appeared and Send returned; follow-up reached idle in 5.063 seconds |
| Longer follow-up; switch away after text starts, then return before completion | Public active count stayed 1 before, during, and after navigation; streaming and Stop remained visible on return |
| Completion of the switched turn | Final marker appeared, active count became 0, and Stop disappeared |
| Another follow-up after navigation | Reply completed and remained idle for 46.552 seconds |
| Reload, reopen, and another follow-up | Saved reply restored; new reply completed normally |
| Durable public conversation | Five assistant messages and five distinct completed execution receipts, with every expected marker |
| Renderer errors and cleanup | No page errors; both owned reproduction tasks deleted and owned Electron stopped |

The new regression tests failed before the fix. Afterward, all 109 tests across
follow-up ownership, event branches, task isolation, and turn persistence passed.
Web TypeScript checking and targeted Oxlint passed. Independent read-only review
found no actionable issue in the guard or tests.

Evidence is retained under `.dev/verification/issue-1760-followup/` and uploaded
to PR #1768. The verification feature map now requires consecutive turns,
navigation during streaming, delayed-event observation, and a post-reload turn.

This proves the reported Codex text-response workflow in Electron. It is not a
new performance benchmark, a Claude/Cursor live proof, or a file-change Review
proof. Separate source-review concerns about late MCP attribution and worker
file-summary publication remain outside this correction.
