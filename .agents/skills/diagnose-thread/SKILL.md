---
name: diagnose-thread
description: Diagnose a stuck or slow Mcode thread from its local recording. Use when a thread hangs or stays Running, a turn never finishes, an approval or delegated result never arrives, or a flow is slow.
---

# Diagnose a Thread

Read what the app recorded and name the cause from that evidence. [The diagnostics runbook](../../../docs/agents/diagnostics.md) holds the data dirs, reader flags, database tables, and the meaning of every finding and channel; consult it at each step.

1. **Locate the recording.** Pick the data dir and database for the app the user ran from the runbook's table. Run `bun run diag --data-dir <dir> --db <db>`, and widen `--since` until the thread appears. Carry these three flags into every later command. Done when you have the thread id and its line in the summary.
2. **Check coverage.** Run the reader with `--thread <id>` and read the header first. A restart shows as a new run turning `on` with no `off` from the previous run. Done when you can say whether recording was on for the whole thread window, and you name any `recording off` marker, dropped records, or restart inside it.
3. **Read the findings.** Take each finding in order of certainty. `observed` is evidence, `waiting` points outside the agent, and `incomplete` needs confirming in the database. The reader judges against the thread's current state, so a turn that recovery closed after a restart shows no `stall`. An empty FINDINGS list proves nothing on its own. Done when every finding has its timeline line and a one-line meaning, and you have read the timeline's last rows for each lane.
4. **Follow the lanes.** For each delegated lane, trace `mcp.tool`, `delegate.launch`, `delegate.steer`, and `delegate.wake` between parent and child. An older build may lack a channel, so a missing channel is not a missing event. The footer counts hidden rows; `--json` prints them with their channel names, and `--ch <channel>` shows one channel in the timeline. Done when you know which lane stopped first and the last row it wrote.
5. **Confirm in the database.** Query the turn's rows read-only with the tables the runbook lists, at least its status, checkpoint phase, and the `accepted_at` and `persisted_at` times around the last recorded row. Done when the recording and the database tell one story, or you name where they disagree.

Report the cause as a chain, oldest first. Cite each link by its `L<n>` line, or by table and row for database evidence, and label it observed or inferred. End with what the recording cannot show and the one check that would settle it.
