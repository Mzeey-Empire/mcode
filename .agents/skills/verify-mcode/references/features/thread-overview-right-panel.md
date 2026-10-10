# Thread Overview and right panel

## Sub-features

- Thread Overview is a card that docks in the chat canvas's top-right corner by default when the canvas is at least 896 pixels wide and the right panel is closed. While docked, message rows and the composer reserve 328 pixels on the right. The message-list scroll viewport stays at the chat edge.
- Below 896 pixels, or while the right panel is open, the card does not dock and the reserve is gone. `[data-testid="header-overview-toggle"]` then opens the card as an overlay at the same corner. Escape or an outside press closes the overlay.
- `header-overview-toggle` reports `aria-pressed="true"` while the card shows, docked or as an overlay. Pressing it on a docked card closes the card, and that close holds for the thread across right-panel changes for the session.
- The card scrolls within the canvas height, with a bottom fade while more content sits below.
- `header-panel-toggle` renders only while the right panel is closed. Once open, the panel's row 1 owns `panel-header-toggle` (Close panel) and `panel-header-expand` (Expand or Restore).
- `panel-header-expand` maximizes the panel within the app. It is not native window fullscreen. While maximized, the chat surface and Thread Overview are intentionally unavailable.

## How to get to it (user or client POV)

1. Start from a healthy runtime and a fresh owned Electron session at the product default 1200x800 window size (`apps/desktop/src/features/desktop-window/lifecycle/create-window.ts`). Assert `window.innerWidth === 1200`. Create or select a fresh disposable thread before any layout actions, so Overview has no remembered close.
2. If `[data-testid="right-panel"]` is visible, close it through `[data-testid="panel-header-toggle"]` and wait for `[data-testid="header-panel-toggle"]` to appear. Measure the chat canvas. At 896 pixels or wider, assert `[data-testid="thread-overview-card"]` is visible with `data-presentation="docked"` and the toggle is `aria-pressed="true"`.
3. Open the right panel through `header-panel-toggle`. Assert `[data-testid="right-panel"]` is visible, the card is gone, and `header-panel-toggle` is gone. Press `header-overview-toggle` and assert the card shows with `data-presentation="overlay"`. Press Escape and assert it closes.
4. Close the right panel through `panel-header-toggle` and assert the card docks again. Press the toggle to close it, open and close the right panel, and assert the card stays closed.
5. Inspect `[data-testid="panel-header-expand"]` and activate it only when its accessible name is `Expand`. Assert the chat surface and Overview are unavailable. Activate it again when its name is `Restore` to return to split mode.
6. For the narrow proof, shrink the canvas below 896 pixels with the panel closed. Assert no card and no reserve, then open the overlay through the toggle and close it with an outside press.

## Driving it with Electron Playwright

Use the stable `.agents/skills/electorn-live-testing` persistent Electron Playwright session. Do not add a repository harness or start the runtime from this feature proof.

- Run `runtime health` before collecting evidence. Continue only against the healthy, matching worktree instance.
- Drive public clicks and keyboard actions through the selectors above. Re-inspect the DOM after each layout transition.
- Capture assertions for `aria-pressed` on `header-overview-toggle`, the presence of `header-panel-toggle`, `data-presentation` on the card, and the composer and message-row right padding (328 pixels docked, none otherwise). Capture screenshots for the docked card, the overlay with the panel open, and the maximized panel under `.dev/verification/`.
- For cleanup, create the disposable managed-worktree thread through authenticated public `thread.create`, record its returned ID, then after proof call public `thread.delete` for that exact ID with `cleanupWorktree: true` and verify it is absent. Never delete by title or heuristic. Close UI state, disconnect Playwright, and stop only the Electron process owned by the session. Run `agent:down` only when this workflow started the runtime. Do not run live verification as part of documentation maintenance.

## Gotchas

- A maximized right panel must not be reported as showing Thread Overview. Its absence is the expected result.
- `panel-header-expand` means panel maximize or restore, not native window fullscreen. Classify native fullscreen observations separately.
- The 896-pixel threshold applies to the chat canvas, not the window. The sidebar and right panel both narrow the canvas.
- Classify stale or wrong runtime/build state as an environment failure; missing or contradictory selectors in the existing live interface as a harness defect; and missing proof for an intended state as a coverage gap. Update this feature file only for stale map entries, harness defects, or verifier-contract mismatches.
