# Diagnose a Stuck Thread from Its Recording

When a thread hangs, a turn never finishes, or an approval never appears, read what the app recorded instead of reproducing it. The server writes a bounded recording for every thread while Settings > About > Troubleshooting logs is on, which is the default. The reader joins those recordings with the canonical events in the database and prints one timeline.

## Find the recording

Each process writes `diagnostics/t/<threadId>.jsonl` for thread records and `diagnostics/p/<runId>.jsonl` for its own run markers, under its data directory. Files rotate to `.1.jsonl` at 4 MB, and the server deletes recordings older than 7 days or beyond 256 MB in total.

| App | Data directory | Database |
|---|---|---|
| The user's installed Mcode | `~/.mcode` | `~/.mcode/mcode.db` |
| This worktree's `agent:up` server | `.dev` | `.dev/db/app.sqlite` |
| The [live-testing](../../.agents/skills/electorn-live-testing/SKILL.md) Electron app | `.dev/electron-live-testing/runtime` | `.dev/electron-live-testing/runtime/db/app.sqlite` |

Inside a checkout the reader defaults to the `agent:up` server. To read another app, pass `--data-dir` and `--db`. The reader opens the database read-only.

## Run the reader

```powershell
bun run diag                                    # threads active in the last 15 minutes, one line each
bun run diag --thread <threadId>                # one thread's findings and timeline
bun run diag --workspace <workspaceId>          # every thread in a workspace, one lane per thread
bun run diag --thread <threadId> --since 2h --ch agent.send,agent.stop,approval
bun run diag --data-dir ~/.mcode --db ~/.mcode/mcode.db --thread <threadId>
```

`--since` takes a duration such as `20m` or an ISO time. `--limit` caps the timeline at its newest rows, 400 by default. Without `--ch`, the timeline hides high-volume rows (`push.canonical`, streamed deltas, and status ticks) and its last line counts them. Name a channel with `--ch` to see all of its rows. `--json` prints the newest rows up to the limit, hidden ones included, for a script.

Start without a scope to find the thread, then rerun with `--thread` or `--workspace`. A scoped query also reads every thread delegated from the scope with `delegate_task`, at any depth and in any workspace, and labels each one `(delegated by <lane>)`.

## Read the output

Each per-run header gives the PID, start, previous-run classification, whether provider processes end with the run (on Windows they sit in a job that kills them when the server exits, so an abrupt exit ends them too), shutdown requester and exit; its last record counts the run's thread records as well as its process records; `no exit record` means the process may have been killed, crashed, or still running at capture, and does not identify a killer; when the run had begun shutting down, the header also names the last `app.phase` it reached. `app.stall` bounds a late-callback window, not an exact stall onset. `app.control` rows are accepted reliability-harness commands; their `id` reappears on the `app.hang` that measured a hang and on the `app.exit` of a harness-ended run. An `agent.stop` span with `by: "shutdown"` marks each thread the server stopped while shutting down.

`rpc.request` rows record when the server received a send, stop, steer, retry, resume, question answer, or approval answer, over which connection (`conn`) and from which kind of client, and the request's outcome. Rows on lane `-` are process records with no thread, such as an approval answer, which links to its thread's `approval` span by the approval id. `ws.connection` rows record when each `conn` opened, from which kind of client, and when it closed with which close code.

The header states what the evidence covers: the window, the first and last record, each run's recording intervals, and any dropped records. Check it first. A gap in the timeline means nothing happened only when recording was on throughout. A quiet line that ends in `(recording off at ...)` means the gap was not recorded.

Findings come before the timeline. Each one has a certainty:

- `observed`: the recording shows the fault, such as `open-span` (an action that started and never ended), `slow-span`, `error-end`, or `stall` (an unfinished turn with no activity for over a minute).
- `waiting`: an action waits on something outside the agent, such as an approval nobody answered or a `thread_wait` call on another thread.
- `incomplete`: coverage was lost, such as `restart-mid-turn`, `dropped`, or recording switched off mid-action. Confirm these against the canonical events before you conclude anything.

Timeline rows read `L<n> +<ms> <lane> <kind> <channel> <payload>`. Offsets count from the first row shown. `db.canonical` rows come from the database; every other channel comes from the recording. `approval.push` records when an approval request or resolution was written to sockets and names those connections; it does not confirm client receipt. `turn.recovered` names each execution the next start interrupted and its recovery incident, while `agent.stopped` records the runtime phase and whether a terminal outcome was committed when shutdown stop finished. `app.exit` lists up to three inner errors of a failed exit, with bounded first-line messages.

For a parent that delegated work, follow these rows in its lane: `mcp.tool` for each Mcode tool call, `delegate.launch` for the child's start (its end names the child thread), `delegate.steer` for a result pushed into the parent's running turn, and `delegate.wake` for whether the child's result reached the parent or why it was held. `reached` is stamped when the result's message is saved, which can trail the moment the provider received it. In a Claude thread, `claude.stream` rows name the tool calls they start or finish, and `parent` names the sub-agent tool call a message belongs to. `claude.stream` rows carry `uuid`, task and tool ids, and terminal reasons so a steer's id can be followed from `claude.turn steer-queued` through the frames that name it. `claude.turn` rows record the adapter's own decisions: steer queued and answered, a cut-short segment absorbed while named steers waited, stop requested, and stream ended with the cause known to the adapter. `steer-queued` and `stop-requested` name the tool calls open at that moment; `claude.process` records the Claude CLI process's spawn, exit code or signal, and tree termination for the thread. `provider.refused` names provider events the server refused because their execution had already ended. `progress.save-failed` names accepted events a save could not write, and `exhausted` says no retry follows, so events missing from the database after a shutdown can be traced to it.

## Confirm in the database

The reader's `db.canonical` rows carry only an event type and sequence. For a turn's state, query the database read-only with `bun:sqlite`:

| Table | What it answers |
|---|---|
| `canonical_agent_turns` | The turn's `status`, its start and end, and `ending_json` |
| `canonical_agent_ingest_checkpoints` | The execution's `phase`, `terminal_outcome`, and `error` |
| `canonical_agent_events` | Each event's `accepted_at` and `persisted_at`; a growing gap means writes fell behind |
| `turn_steers` | Each steered message's `state` and when it changed |

## Record something new

Every channel is one entry in `DIAG_CATALOG` in [`packages/shared/src/diagnostics/catalog.ts`](../../packages/shared/src/diagnostics/catalog.ts). An entry declares the payload type, the ids each record must carry, and, for a span, its time budget. Use `null` for a span that waits on a person. Then call `diag.emit`, `diag.begin` and `diag.end`, or `diag.run` from `@mcode/shared/diagnostics`. The reader needs no change: span begins carry their budget, so it pairs and judges new spans by itself.

Payloads are thunks, so recording costs one boolean check while it is off. The recorder bounds and redacts every payload, but keep prompts, file contents, and tokens out of payloads in the first place.
