# Composer context tracker

## Sub-features

- A thread with reported context usage shows a 20 by 20 pixel context ring in the Composer controls.
- Hovering the ring, or focusing it with the keyboard, opens a tooltip that shows the used percentage, a usage bar, used tokens, capacity, and remaining tokens on one line.
- The ring and the usage bar use the same color tier: primary below 70 percent, amber from 70 percent through 89 percent, and destructive at 90 percent or more.
- The tracker does not show for a thread without context usage or without a context window.

## How to get to it (user POV)

1. Select a thread that has reported context usage and an active model context window.
2. Find the Context window ring before the Composer send control.
3. Hover over the ring or focus it with the keyboard.
4. Inspect the visible tooltip.

## Driving it with Electron Playwright

Use the stable `.agents/skills/electorn-live-testing` persistent Electron Playwright session. Do not add a repository harness for this feature.

1. Run `runtime health` before proof collection.
2. Use an owned thread whose reported context usage is greater than zero and below 70 percent. Assert that the `Context window:` image is visible, focusable, 20 by 20 pixels, opens the usage progress bar on hover and keyboard focus, and shares the primary tier with the bar.
3. Use owned threads whose reported usage is from 70 through 89 percent and at least 90 percent. Capture each stable tooltip with its ring and progress bar. Inspect the computed ring stroke and bar background to confirm that both use the amber tier for the first state and the destructive tier for the second state.
4. Capture the normal color tier tooltip with the ring and usage bar under `.dev/verification/`. Confirm that used tokens, capacity, and remaining tokens remain on one line.
5. After proof, delete only exact owned threads. Disconnect Playwright and stop only the Electron process started for the session.

## Gotchas

- Context usage comes from the latest reported input token count. A fresh thread has no ring.
- The ring represents context usage. A low-quota badge is a separate signal.
- If the available owned threads cannot reach a threshold, report that state as a coverage gap. Do not change usage data outside the public product path.

## Proof

Drive each color tier through the Composer UI. Retain and inspect a screenshot that shows the ring and its tooltip for a normal color tier state. Retain the Electron assertions for all three tiers, including the matching ring stroke and usage-bar background. Report a missing threshold capture as a coverage gap.
