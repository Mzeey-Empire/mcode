# Thread transcript

## Sub-features

- Tail follow during cache hydration and streamed output.
- Older history loads after an upward scroll reaches the resident history boundary.
- A reading position survives history insertion, row measurement, and a cached thread switch.
- Messages, reasoning, tools, and the final response retain their order across turn completion.
- The DOM contains visible message and narrative rows plus overscan. Cached data remains separate from mounted DOM.
- Expanded tool-group children share the transcript viewport. Group expansion survives row unmounts and cached thread switches.
- Each completed turn footer counts the displayed thread's tools and subagents, independent of the provider.

## How to get to it (user or client POV)

Open a thread in the fixture workspace. Scroll upward, switch to New thread, then reopen the original thread.
For active turns, repeat the switch before completion and again after completion.

## Driving it with Electron Playwright

Run `runtime health` through `scripts/verify-mcode.mjs` before proof collection.
Connect to the owned Electron instance through the Electron live-testing skill.
Use only `.dev/fixture-repo` for new turns. Preserve user threads and database contents.

Seed reusable synthetic history in an idle owned Electron runtime:

```powershell
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop transcript seed
```

The command creates a new fixture thread with 13 turns, enough for history pagination.
The last turn contains 120 reasoning/tool pairs. Earlier turns contain three pairs each.
The controlled provider boundary, `scripts/transcript-provider-fixture.mjs`, generates the same content structure with fresh IDs.
This recipe captures the synthetic test data, not user conversations or a database snapshot.
The command restores the previous Codex CLI setting and prints a receipt path with the thread title.
Wait for `ok: true` before UI verification. A failed seed retains its partial history and reports an error.
Use that title in the proof below. Run `desktop transcript --help` for options and interrupted-run recovery.

With a completed long fixture open, import `scripts/transcript-proof.mjs` in the persistent Node REPL:

```js
await transcriptProof.proveTranscriptCache(electronPage, {
  threadTitle: "Long transcript verification",
  evidenceDirectory: repoRoot + "/.dev/verification/transcript",
});
```

The proof uses normal scroll and thread navigation. It saves two screenshots and an assertion receipt without database writes.

## Pinned prompt boundary

Scroll a fixture prompt above the viewport. Check that the pinned prompt has no card fill, border, or shadow. Move transcript text across its lower boundary and capture the short fade instead of a hard cut. Click the jump control and confirm that the original prompt returns. An earlier turn can remain pinned. Scroll to the first prompt and confirm that the fade disappears when no prompt is pinned. Repeat with Overview open and closed.

## Scroll-to-bottom alignment

Scroll upward in a long fixture thread until the down-arrow button appears. With Overview open, closed, and after a window resize, assert that the button and transcript content have the same horizontal center within one pixel. Capture and inspect the centered button. Click it and confirm that the transcript reaches the bottom and the button disappears.

During a controlled active turn, queue a follow-up through the Composer. Repeat the
button check with the queue visible, then remove the queued message. Assert that
the button stays inside the transcript viewport and above the queue in both
states. Remove the follow-up before completion so it cannot start another turn.

## Gotchas

- For ACP-provider reasoning and tool-card ordering, the deterministic boundary check is the [ACP narrative fixture](acp-narrative.md) plus `runtime check --phase acp`; the seeded history here covers transcript layout, not provider event mapping.
- React StrictMode recreates the viewport. Restore state belongs to that viewport instance.
- Save a row key and offset while row heights are provisional. A raw scrollTop cannot survive inserted history.
- Restore the sticky prompt inset with the reading position. Applying it twice shifts narration by one row.
- A passing cache round trip does not prove a cold reload or an active turn.
- A single large message or one command's output remains one measured row. Expanded group children are separate measured rows.

## Proof

1. Open a completed long turn. Run the cache proof above and inspect both screenshots.
2. Scroll to older history. Assert that older message sequences prepend without changing the visible row and offset.
3. Start a controlled turn. Switch away during narration, return, and assert that narration precedes the single final response.
4. Reload after completion. Compare public `message.list` order and `narrative.get` records with the rendered transcript.
   Confirm that the last fixture turn shows 120 steps and an earlier turn shows three steps. Counts must not include other turns.
5. Retain screenshots and RPC receipts under `.dev/verification/`. Report missing active, cold-cache, or provider coverage as gaps.

Focused checks live in `MessageList.thread-switch.test.tsx`, `transcript-viewport.test.ts`, and `virtual-items.test.ts`.
These checks support the live proof; they do not replace it.

## Expanded groups

### Active command previews

In an idle owned runtime, use the transcript fixture CLI wrapper and send `overlapping commands` in a new fixture thread. Save the previous CLI setting and restore it after the turn.
The fixture starts five commands together and completes them out of order.

1. Before the first result, assert that five `Running command` buttons have `aria-expanded="true"`.
2. Close one preview. Assert that it stays closed while the other commands run.
3. After completion, assert that no running preview remains and the turn shows one collapsed `Ran 5 commands` group.
4. Expand the group. Assert that all five commands retain their matching outputs.

This controlled Codex protocol check does not establish live Claude or Cursor coverage.

### Active expanded-group switch

Use two fixture threads, including an active turn with a completed command group.
Keep the fixture CLI setting until the controlled turn completes so the live
proof uses one stable provider configuration.

1. Reload during the active turn and reopen it. Confirm that its existing commands
   and progress messages return. Expand its completed group, switch to the other
   thread, and return.
2. Open a command output, then scroll down and up through the group. Confirm that
   the output belongs to that command and does not overlap the next row.
3. Inspect every mounted `.transcript-item`, including overscan. Each wrapper must
   contain a child whose `data-transcript-key` matches the wrapper's `data-id`.
   Require unique wrapper IDs. Checking only existing children misses empty rows.
4. Wait for completion and repeat the switch. Assert that reasoning and commands
   precede one assistant response row, with no repeated narrative groups.
5. Reload and repeat the row and order assertions. Retain and inspect a screenshot
   and the row-key assertions under `.dev/verification/`.

### Virtualized completed groups

Use a fixture turn with 180 consecutive completed commands and no intervening thoughts.

1. Open the group. Assert that the summary retains its position and fewer than 60 command children mount at an 800-pixel viewport height.
2. Open one command's output. Assert that its text appears without overlap with the next row.
3. Scroll through the middle and end. Assert that the correct commands appear and the mounted child count remains bounded.
4. Switch away with a command visible. Return and assert that the same child key and offset return.
5. Return to the summary and close it with the keyboard. Assert that the children unmount and the summary retains focus.

Measure at least five warm expansions on the same runtime and viewport. Record the build mode with the results.
Count mounted children as well as frame times; development React overhead is not a production latency measurement.
