# Diagnose a Stuck Thread from Its Recording

When a thread hangs, a turn never finishes, or an approval never appears, read what the app recorded instead of reproducing it. The server writes a bounded recording for every thread while Settings > About > Troubleshooting logs is on, which is the default. The reader joins those recordings with the canonical events in the database and prints one timeline.

## Find the recording

Each process writes `diagnostics/t/<threadId>.jsonl` for thread records and `diagnostics/p/<runId>.jsonl` for its own run markers, under its data directory. Files rotate to `.1.jsonl` at 4 MB, and the server deletes recordings older than 7 days or beyond 256 MB in total.

Prefer the reader to raw files. Each append opens with a `{"writer":"<runId>","batch":<n>,"records":<count>}` line that is not a record. A flush at exit or when recording stops rewrites a batch whose append may not have landed under the same header, so a raw file can hold a batch twice, and the reader keeps one copy.

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

Each per-run header gives the PID, start, previous-run classification, whether provider processes end with the run, the shutdown requester, and the exit. Its last record counts the run's thread and process records. `no exit record` means the process was killed, crashed, or was still running at capture; it does not identify a killer. When the run had begun shutting down, the header also names the last `app.phase` it reached.

The header states what the evidence covers: the window, the first and last record, each run's recording intervals, and any dropped records. Check it first. A gap in the timeline means nothing happened only when recording was on throughout. A quiet line that ends in `(recording off at ...)` means the gap was not recorded.

Findings come before the timeline. Each one has a certainty:

- `observed`: the recording shows the fault, such as `open-span` (an action that started and never ended), `slow-span`, `error-end`, or `stall` (an unfinished turn with no activity for over a minute).
- `waiting`: an action waits on something outside the agent, such as an approval nobody answered or a `thread_wait` call on another thread.
- `incomplete`: coverage was lost, such as `restart-mid-turn`, `dropped`, or recording switched off mid-action. Confirm these against the canonical events before you conclude anything.

Timeline rows read `L<n> +<ms> <lane> <kind> <channel> <payload>`. Offsets count from the first row shown. Rows on lane `-` are process records with no thread. `db.canonical` rows come from the database; every other channel comes from the recording.

## Look up a channel

Each channel's entry in [`DIAG_CATALOG`](../../packages/shared/src/diagnostics/catalog.ts) has an `about` text that says what one record means, and its payload type names the fields. That is the only description of a channel, so read it there. To follow one kind of story, read these channels in order:

| Story | Channels |
|---|---|
| A server run | `app.run`, `app.shutdown`, `app.phase`, `app.exit`; `app.control` and `app.hang` for harness faults |
| A client's action | `ws.connection`, `rpc.request`, then the `agent.send` or `agent.stop` span |
| An approval | the `approval` span, `approval.push`, and the `rpc.request` that answered it |
| Delegated work, in the parent's lane | `mcp.tool`, `delegate.launch`, `delegate.task`, `delegate.steer`, `delegate.wake` |
| A Claude turn | `claude.turn`, `claude.stream`, `claude.process` |
| Events missing from the database | `provider.refused`, `progress.save-failed`, `agent.stopped`, `turn.recovered` |

## Confirm in the database

The reader's `db.canonical` rows carry only an event type and sequence. For a turn's state, query the database read-only with `bun run db:query -- "<sql>" [--db <path>]`, which prints rows as JSON and defaults to the `agent:up` database:

| Table | What it answers |
|---|---|
| `canonical_agent_turns` | The turn's `status`, its start and end, and `ending_json` |
| `canonical_agent_ingest_checkpoints` | The execution's `phase`, `terminal_outcome`, and `error` |
| `canonical_agent_events` | Each event's `accepted_at` and `persisted_at`; a growing gap means writes fell behind |
| `turn_steers` | Each steered message's `state` and when it changed |

## Record something new

Every channel is one entry in `DIAG_CATALOG` in [`packages/shared/src/diagnostics/catalog.ts`](../../packages/shared/src/diagnostics/catalog.ts). An entry declares the payload type, the ids each record must carry, for a span its time budget, and an `about` text that says what one record means. Use `null` for a span that waits on a person. Then call `diag.emit`, `diag.begin` and `diag.end`, or `diag.run` from `@mcode/shared/diagnostics`. The reader needs no change: span begins carry their budget, so it pairs and judges new spans by itself.

Payloads are thunks, so recording costs one boolean check while it is off. The recorder bounds and redacts every payload, but keep prompts, file contents, and tokens out of payloads in the first place.
