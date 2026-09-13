# Composer Enter to send

## Sub-features

- Enter submits the primary Composer draft when the editor is eligible.
- Shift+Enter inserts a line break instead of sending.
- A follow-up Enter is accepted after the previous draft clears, even if the prior send RPC is still in flight.
- IME composition Enter does not submit.

## How to get to it (user or client POV)

1. Open a new chat and select `.dev/fixture-repo`.
2. Focus the Composer (`Message Mcode`).
3. Type a short prompt and press Enter.
4. Type a second prompt and press Enter again without waiting for the first turn to finish starting.

## Driving it with verify-mcode

There is no dedicated `verify-mcode.mjs` namespace yet. Use the owned Electron live-testing session plus the disposable proof script:

```powershell
bun run --shell system agent:up
bun run agent:ready
bun .agents/skills/electorn-live-testing/scripts/ensure-playwright.mjs
bun .agents/skills/electorn-live-testing/scripts/start-electron.mjs
bun .agents/skills/verify-mcode/scripts/composer-enter-send-proof.mjs
bun .agents/skills/electorn-live-testing/scripts/stop-electron.mjs
```

Focused regression:

```powershell
bun run --cwd apps/web test -- src/features/conversation/composer/submission/useComposerSubmissionController.test.tsx src/components/chat/lexical/ComposerEditor.test.tsx
```

## Gotchas

- Before this fix, `submitInFlightRef` stayed true until the full send RPC settled, so Enter after a cleared draft could silently no-op.
- Existing-worktree mode without a selected worktree shows a toast instead of a silent no-op.
- Do not mutate user projects; keep proofs on `.dev/fixture-repo`.

## Proof

- Normal entry: new-chat Composer on fixture-repo.
- Realistic input: two unique prompt strings entered with the Enter key.
- Stable result: each Enter clears that draft from the Composer.
- Expected evidence: `.dev/verification/composer-enter-send/receipt.json` plus the two screenshots it names.
- Side effect: the first send may open checkout confirmation or start a turn; the proof only requires the Composer clear on Enter.
