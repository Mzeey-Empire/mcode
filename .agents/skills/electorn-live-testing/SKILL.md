---
name: electorn-live-testing
description: Drive the Mcode Electron desktop app with Playwright and capture what it shows. Use to start the desktop app, screenshot a screen, hover an element, or check a UI change live.
---

# Electron Live Testing

Use one persistent Playwright connection to an agent-owned Electron process. Launch once, keep the browser and page handles in the Node REPL, and issue small commands against those handles until verification is complete.

## Start the session

1. Read `docs/agents/runtime.md`. Run `bun run agent:setup` if runtime artifacts are absent or stale. Start the worktree runtime with `bun run --shell system agent:up` if it is not healthy. Poll `healthUrl` and `appUrl` before you start Electron.
2. Read `.dev/ports.json`. Never print its token or seeded credentials.
3. Make Playwright importable by the Node REPL. Prefer an existing external installation. Otherwise use the helper to create an isolated private package under `.dev/playwright-scratch`. Never add Playwright to the repository package manifest:

   ```powershell
   bun .agents/skills/electorn-live-testing/scripts/ensure-playwright.mjs
   ```

4. Start or reuse the owned Electron process. The launcher selects a dynamic CDP port and records only its own PID:

   ```powershell
   bun .agents/skills/electorn-live-testing/scripts/start-electron.mjs
   ```

5. Add the absolute `.dev/playwright-scratch/node_modules` directory with `mcp__node_repl__js_add_node_module_dir`.
6. Import Playwright and the session helper in `mcp__node_repl__js`. Use top-level `var` names because the kernel preserves bindings:

   ```js
   var electronPlaywright = await import("playwright");
   var electronSessionHelper = await import(
     "./.agents/skills/electorn-live-testing/scripts/electron-session.mjs"
   );
   var electronSession = await electronSessionHelper.connectElectronSession({
     playwright: electronPlaywright,
     repoRoot: nodeRepl.cwd,
   });
   var electronPage = electronSession.page;
   nodeRepl.write({ pid: electronSession.pid, url: electronPage.url() });
   ```

Do not reset the Node REPL while the application is open. Do not launch a second session to perform the next action.

If the REPL rejects Playwright's ESM entry with a missing default export, load
the installed CommonJS entry instead, then use the same session helper:

```js
var electronModule = await import("node:module");
var electronRequire = electronModule.createRequire(
  nodeRepl.cwd + "/.dev/playwright-scratch/package.json"
);
var electronPlaywright = electronRequire("playwright");
```

Without a persistent Node REPL, write each step as a script under `.dev/verification/` and run it with `node` from the repository root. Electron keeps the app and its state between steps. Connecting never reloads the page, so each step finds the app as the last one left it. The app signs in through the desktop process, not the seeded login cookie, so no step needs a reload to sign in:

```js
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const playwright = createRequire(`${repoRoot}/.dev/playwright-scratch/package.json`)("playwright");
// Windows needs a file URL to import an absolute path.
const skill = (name) => import(pathToFileURL(`${repoRoot}/.agents/skills/electorn-live-testing/scripts/${name}`).href);
const { connectElectronSession, disconnectElectronSession } = await skill("electron-session.mjs");

const session = await connectElectronSession({ playwright, repoRoot });
// act on session.page
await disconnectElectronSession(session);
```

## Operate directly

Run each observation or action as a new `mcp__node_repl__js` call against `electronPage`, `electronSession.context`, or `electronSession.browser`.

Prefer accessible Playwright locators and explicit postconditions. Re-inspect after navigation or any action that changes the page structure. Keep console errors and failed requests in persistent arrays when they matter to the test.

The session can hover. Playwright moves the real pointer, so CSS `:hover` styles and Mcode tooltips appear as they do for a user. Tooltips open 400 ms after the pointer arrives, and their popup has no `tooltip` role:

```js
await electronPage.getByRole("button", { name: "Settings" }).hover();
await electronPage.locator('[data-slot="tooltip-content"]').waitFor();
```

Use Playwright for deterministic DOM, keyboard, focus, popup, multi-tab, and timing checks. Use computer use only when visual inspection or native-window behavior cannot be established through Playwright. Computer use supplements the Playwright evidence; it does not replace assertions.

For Browser lifecycle changes, cover the states that can regress:

- An agent starts while a Browser tab already exists.
- Two or more tabs retain independent URL and page state.
- Switching away and back preserves the live hidden tab.
- Background creation does not steal focus unless the product contract requires it.
- Popup behavior preserves the expected automation target.
- A clean Electron restart restores or reloads only the states promised by the issue.

Select the in-app model before the test turn. Exploratory turns run on Haiku or Sonnet: `pickModel(electronPage, { model: "Haiku" })` from `scripts/pick-model.mjs` selects one in the composer and throws on any other model. Select another provider by hand when the test needs it. The model selected in the app is independent from the model running this testing workflow.

To minimize or restore the app window on Windows, call `setElectronWindowState(electronSession.pid, "minimized")` or `"normal"` from `scripts/window-state.mjs`. It changes only the app window and leaves focus where it is. The desktop window turns off background throttling, so a minimized page still reports `visible` and keeps painting. A minimize test therefore checks that the chat keeps up and shows the latest state at restore. Install a frame probe or a store subscription before you minimize.

To size the window, call `setElectronWindowSize(electronPage, { width, height })` from `scripts/window-state.mjs` before each capture. It resizes the real window and throws when the screen cannot fit the size or when the page and window already disagree. The session blocks `page.setViewportSize`, because in Electron it lays the page out at a fake size inside the unchanged window until Electron restarts.

## Read app state

Read a store through the module instance the app uses. `appModuleUrl` from `scripts/app-probes.mjs` returns the URL the page loaded a module from; import that URL inside `evaluate`:

```js
var appProbes = await import("./.agents/skills/electorn-live-testing/scripts/app-probes.mjs");
var threadStoreUrl = await appProbes.appModuleUrl(electronPage, "/src/stores/threadStore.ts");
var currentThreadId = await electronPage.evaluate(
  async (url) => (await import(url)).useThreadStore.getState().currentThreadId,
  threadStoreUrl,
);
```

Once a module is edited while Vite runs, the app imports it as `<path>?t=<edit time>`, and importing the bare path creates a second, empty store. Ask for the URL again after an edit or a reload.

## Measure and capture evidence

Warm each path before timing it. Record multiple samples with `performance.now()` around the exact user-visible transition, then report the sample count, median, minimum, and maximum. Do not claim a performance change from a single run.

Measure motion on every frame inside the page. A screen recording holds only the frames that repainted. Run `electronPage.evaluate(appProbes.installFrameProbe, { selector, label })` before the action, then `electronPage.evaluate(appProbes.readFrameProbe, label)`. Each sample holds the frame time, the match count, and the position, size, opacity, and visibility of the first four matches.

Store screenshots, logs, and measurements under `.dev/verification/`. Keep exploratory specifications under `.dev/playwright-scratch/`; do not commit them.

To screenshot, drive the app to the screen, then run the capture script instead of writing one. It connects like any other step, so the app keeps its state, and it creates the output folder:

```powershell
node .agents/skills/electorn-live-testing/scripts/capture.mjs --out .dev/verification/<name>.png --width 1280 --height 800 --hover 'role=button[name="Settings"]'
```

`--width` and `--height` resize the real window. `--hover` takes a Playwright selector that matches one element, and the script waits for the tooltip delay and any fade before the capture. From the Node REPL, call `capture(electronPage, parseCaptureArguments([...]))` from the same script.

When the live usage source is down, `--usage-fixture <providerId>` fills the open thread's usage with invented quota readings so the Usage row renders. Wait until the thread has started: a starting thread's Overview has no Usage row, so the fixture changes nothing on screen. The script adds `.usage-fixture` to the file name and restores the previous usage after the capture, including on failure. A capture taken with it is not live data: say so wherever you show it, including the PR body. From the REPL, pass `"--usage-fixture", "<providerId>"` to `parseCaptureArguments` and call `capture`, which applies and restores the fixture for you. Every capture first restores any fixture left in the app, so do not apply one yourself before calling `capture`.

## Record before and after evidence

UI changes carry a before and an after capture into the PR. The UI Changes section of `.github/pull_request_template.md` says when a capture must be a video. Capture only on the default empty database. If `agent:up` warns that it holds a filtered copy of real data from `bun run db:seed`, run `bun run agent:reset` first. Take the before capture before editing renderer code, or run the base build; keep conditions identical across both — same window size, same workflow, same data.

Photos are `electronPage.screenshot({ path })` under `.dev/verification/`. For video:

1. Run `bun .agents/skills/electorn-live-testing/scripts/ensure-ffmpeg.mjs` to resolve an ffmpeg binary into the scratch install.
2. Start the recorder on the live session, drive the workflow, then stop:

   ```js
   var videoRecorder = await import(
     "./.agents/skills/electorn-live-testing/scripts/record-video.mjs"
   );
   var recording = await videoRecorder.startVideoRecording(electronSession, {
     outPath: ".dev/verification/<name>.mp4",
   });
   // ... drive the UI ...
   nodeRepl.write(await recording.stop());
   ```

The screencast captures web contents only — no native menus or OS dialogs. Clips play at real speed. Each frame holds until the page repaints, and the last frame holds until `stop()`. For window-level capture use `ffmpeg -f gdigrab -i "title=<window title>"` with the title from `electronPage.title()`. `docs/research/electron-video-capture.md` covers the approach and the rejected alternatives.

Keep clips to 10–20 seconds; GitHub caps free-plan video attachments at 10 MB. Attach at creation with `gh pr create --attach <file>` so evidence lands in the PR body, not in a follow-up comment — and confirm the upload renders. A local path is not evidence.

Main-process and preload changes require a rebuild and clean Electron relaunch. Renderer-only edits can use hot reload for iteration, but final lifecycle evidence requires a clean relaunch so stale guest or generation state cannot mask a failure.

## Close the owned session

Disconnect Playwright, then stop the exact process tree owned by the launcher:

```js
await electronSessionHelper.disconnectElectronSession(electronSession);
electronSession = undefined;
electronPage = undefined;
nodeRepl.write("Playwright disconnected");
```

```powershell
bun .agents/skills/electorn-live-testing/scripts/stop-electron.mjs
```

Then run `bun run --shell system agent:down` only when this workflow started the runtime. The stop helper verifies the recorded executable and dynamic CDP port before stopping the PID tree. If verification fails, inspect `.dev/electron-live-testing.json` and the live command before cleanup. Never kill Electron processes by name.

Report desktop evidence separately from focused automated tests.
