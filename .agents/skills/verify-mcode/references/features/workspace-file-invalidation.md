# Local workspace file invalidation

## Sub-features

- Files, selected Review file content, and `@` file autocomplete refresh after an external local change is detected at an attention boundary.
- Review compares the live filesystem again. Last turn remains the recorded agent comparison, so an external edit never gains agent attribution.
- An open Mcode Browser preview on a local loopback address reloads. Remote pages do not reload.
- The server tracks one dirty-set fingerprint per workspace scope. A `file.refresh` RPC diffs the current `git status` against that baseline and broadcasts `files.changed` only when the set moved. Untracked directories are fingerprinted per file (`git status --untracked-files=all`), so adding or removing a file inside an already-untracked `?? dir/` still moves the fingerprint.
- Clients call `file.refresh` on attention boundaries: window focus, panel mount, thread scope change, and `@` picker open. There is no ambient filesystem watch.

## How to get to it (user or client POV)

1. Register `.dev/fixture-repo` as an Mcode workspace and open its Files, Review, `@` autocomplete, and local loopback Preview surfaces.
2. Select one text file in Files and Review. Capture the file content, autocomplete choice, Preview, and both Review comparison modes.
3. Edit that fixture file outside Mcode, inspect the disk content, then focus the window or open a surface so the client requests `file.refresh`. Confirm the stable refresh on every surface.
4. Rename or delete the file and confirm the Files catalog and live Review comparison refresh while Last turn retains its agent-attributed content.

## Driving it with Mcode Browser

- Run `runtime health`, then register the fixture workspace and use the public Mcode Browser Preview control. Do not use a generic browser automation tool for this shared Preview surface.
- Capture Files, selected Review content, `@` autocomplete, Mcode Browser Preview, and Review before and after one external fixture edit plus one attention trigger. Save screenshots and redacted receipts under `.dev/verification`.
- Dirty more than 100 paths in `.dev/fixture-repo` between two refreshes. Confirm one whole-workspace refresh, then restore only those owned files.
- Close the client WebSocket through the public client lifecycle, make another fixture edit, and call `file.refresh`. Confirm no push reaches the closed client. Reconnect and confirm a fresh baseline plus one refresh reports the outstanding delta.

## Gotchas

- Keep every edit in `.dev/fixture-repo`. Inspect the disk content after each external edit.
- `file.refresh` only emits after a baseline exists; the first call per scope records the fingerprint silently. Verifiers must baseline, write, then refresh again to observe a delta.
- A missing registered fixture workspace or Mcode Browser host blocks the visual journey. Record the exact blocker. Focused tests do not replace the rendered proof.
- Do not treat live filesystem changes as agent changes. Last turn is historical agent evidence; live Review is the filesystem comparison.
