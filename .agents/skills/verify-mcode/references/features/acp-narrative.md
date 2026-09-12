# ACP narrative ordering (Cursor and Devin)

## Sub-features

- `agent_thought_chunk` reasoning renders as non-final thought segments, never as assistant text.
- A `tool_call` lifecycle marker renders its tool card at invocation position, even when `rawInput` is empty.
- A later `tool_call_update` carrying `rawInput` merges enriched input into the existing card instead of appending a duplicate.
- Out-of-order completions keep invocation order: cards appear where their markers arrived, not where they finished.
- A reload or reopen shows the same thought/tool/response order from durable narrative data.

## How to get to it (user POV)

1. Set the provider CLI path to the owned fixture wrapper.
2. Open a thread on the Cursor provider (or Devin) in the fixture workspace.
3. Send any prompt and watch the turn narrate.
4. Reload the thread and confirm the same order persists.

## Driving it with verify-mcode

Run `runtime health` first. The fixture replaces the real provider CLI, so no provider account is required.

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop acp-narrative check
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop acp-narrative setup
```

`setup` writes an owned `.cmd` wrapper under `.dev/verification/acp-narrative` and prints its absolute path. Set that path as `provider.cli.cursor` (Settings or the Electron-local settings socket) in the owned Electron runtime only. For Devin, set `provider.cli.devin` instead and provide `WINDSURF_API_KEY=fixture` in the runtime environment so headless `authenticate` resolves a credential.

Start a fresh direct Cursor thread under `.dev/fixture-repo` through the Composer and send any prompt. The fixture answers `initialize`, `session/new`, and `session/prompt`, then emits two `agent_thought_chunk` updates, three `tool_call` markers (`fx-read`, `fx-search`, `fx-bash`), a mid-stream input merge for `fx-search`, a data-less progress update for `fx-read`, and completions in the order `fx-search`, `fx-bash`, `fx-read`. One fixture process supports repeated prompts; restart it only if the session dies.

## Proof

1. During the turn, assert two thought rows render the fixture reasoning text before any tool card, and that three tool cards appear in marker order `Read`, `Grep`/`Search`, `Bash`/`Terminal` while still running.
2. Assert `fx-search` shows its merged `pattern` input before its completion, and `fx-read` shows `src/fixture.ts` only at completion.
3. After completion, capture the stable transcript: reasoning, then the three cards in invocation order, then the final assistant text `ACP fixture turn complete.` Screenshot it.
4. Reload the thread and compare `narrative.get` / `message.list` order with the rendered rows. Retain screenshots and the redacted receipt under `.dev/verification/acp-narrative/`.
5. Restore the prior provider CLI path, then run `desktop acp-narrative cleanup --confirm-cleanup`.

## Gotchas

- The fixture does not emit permission prompts, plans, subagent updates, or usage data; it proves ordering and thought rendering only.
- A data-less `in_progress` update for `fx-read` must not consume the input merge: the real path still merges at the terminal update. The `check` command's fixture test pins the emitted sequence; the mapper tests pin the event translation.
- `runtime check --phase acp` runs the Cursor and Devin mapper suites plus the ACP session-runtime suite as the deterministic regression gate; use it when no Electron session is available.
- Devin mode selection and plan-mode restore are covered by focused adapter tests, not this fixture.
