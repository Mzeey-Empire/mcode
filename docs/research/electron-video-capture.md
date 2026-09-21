# Electron Video Capture for PR Evidence — Research Notes

**Status:** Research only — no implementation changes.

Goal: record short before/after videos of the Mcode Electron desktop app during
verification runs and attach them to pull requests. Constraints: Windows, reuse
the existing agent-owned Electron + `connectOverCDP` session
(`.agents/skills/electorn-live-testing/scripts/electron-session.mjs`), no new
repo dependencies (isolated `.dev/playwright-scratch/` pattern), artifacts under
`.dev/verification/` (`.dev/` is gitignored).

Environment facts verified on this machine: `ffmpeg` is **not** on PATH;
`gh` 2.99.0 is installed; the worktree pins `electron@35.7.5`
(`apps/desktop/package.json`), which ships **Chromium 134**
(<https://github.com/electron/electron/releases/tag/v35.0.0>).

## Recommended approach

**CDP `Page.startScreencast` over the existing Playwright session, frames piped
to an ffmpeg binary acquired in the scratch install, output H.264 `.mp4` to
`.dev/verification/`, attached with `gh pr comment --attach`.**

- The existing session already owns a `BrowserContext` and `Page`
  (`electron-session.mjs` lines 66–89). `browserContext.newCDPSession(page)`
  (Playwright v1.11+, <https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session>)
  exposes a `CDPSession` on that same page — no new connection, no new process.
- This is the exact mechanism Playwright uses internally for `recordVideo`: on
  Chromium it sends `Page.startScreencast` with `format: 'jpeg'`, writes each
  `Page.screencastFrame` payload into ffmpeg, and acks every frame with
  `Page.screencastFrameAck`
  (<https://github.com/microsoft/playwright/blob/c0cc9802/packages/playwright-core/src/server/chromium/crPage.ts>;
  original implementation commit
  <https://github.com/microsoft/playwright/commit/8ec55e1fb24e063a78f354f0fe8e2521594bccc9>).
  We replicate ~40 lines of that on top of the live session.
- Works on Chromium 134: `Page.startScreencast` is a stable, long-lived CDP
  command (documented at
  <https://chromedevtools.github.io/devtools-protocol/tot/Page#method-startScreencast>).
- Frame content only changes when the page repaints, which suits UI evidence;
  no desktop region math, no dependency on window visibility/focus.

### Minimal implementation sketch

New helper in the existing harness, e.g.
`.agents/skills/electorn-live-testing/scripts/record-video.mjs`, exporting
`startVideoRecording(electronSession, { outPath, fps, ffmpegPath })` and a
returned `stop()`:

```js
const cdp = await electronSession.context.newCDPSession(electronSession.page);

// ffmpeg spawned once, reading raw JPEG frames from stdin:
//   ffmpeg -y -f image2pipe -framerate <fps> -i pipe:0
//     -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p out.mp4
// (image2pipe and yuv420p/even-dimensions are required for broadly-playable H.264;
//  GitHub recommends H.264 for maximum browser compatibility.)

cdp.on("Page.screencastFrame", (frame) => {
  // Ack must be sent before Chromium emits the next frame.
  cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  ffmpeg.stdin.write(Buffer.from(frame.data, "base64"));
});
await cdp.send("Page.startScreencast", {
  format: "jpeg", quality: 80, everyNthFrame: 1,
});
```

`stop()` sends `Page.stopScreencast`, closes `ffmpeg.stdin`, and awaits ffmpeg
exit so the moov atom is written. Output: `.dev/verification/<name>.mp4`.

Ack contract: Chromium sends no further `screencastFrame` events until the
previous one is acked, and it only emits frames when the page actually
repaints — both behaviors documented in the protocol discussion at
<https://github.com/ChromeDevTools/devtools-protocol/issues/17> and
<https://stackoverflow.com/questions/71437739>. Ack first, then process.

Timing caveat: `image2pipe` assigns each frame `1/fps`, so a 5 s idle gap
compresses to nothing and playback speed is approximate. Acceptable for
before/after evidence. If wall-clock fidelity matters, write
`frame-%05d.jpg` files plus a concat-demuxer list using each frame's
`metadata.timestamp` (the field Playwright's own recorder feeds to ffmpeg —
same crPage.ts source above), or use the gdigrab alternative below.

ffmpeg binary, in order of preference:

1. `bunx playwright install ffmpeg` run inside `.dev/playwright-scratch` —
   Playwright ships a managed ffmpeg build exactly for this purpose
   (`npx playwright install ffmpeg`; see the registry check in
   <https://github.com/microsoft/playwright/blob/54e92be7/packages/playwright/src/mcp/browser/config.ts>
   and <https://github.com/microsoft/playwright/issues/15265>). On Windows it
   lands under `%LOCALAPPDATA%\ms-playwright\ffmpeg-*\ffmpeg-win.exe`.
2. `ffmpeg-static` added to `.dev/playwright-scratch/package.json` — same
   isolation pattern as Playwright itself; resolves to a plain `.exe` path.

Attach: `gh pr comment <n> --body-file body.md --attach .dev/verification/x.mp4`
or `gh pr create --attach ...`. GitHub CLI uploads image/media attachments and
rewrites local `![](path)` references into uploaded URLs
(<https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli>).
Requires push access; the machine already has `gh` 2.99.0.

## Evaluated alternatives

### 1. Playwright `recordVideo` — rejected for this session model

`electron.launch()` does accept `recordVideo` (since v1.12) and produces `.webm`
files (<https://playwright.dev/docs/api/class-electron>; working example at
<https://til.simonwillison.net/electron/testing-electron-playwright>). But our
harness deliberately spawns Electron itself and attaches with
`chromium.connectOverCDP()` (`start-electron.mjs` line 277,
`electron-session.mjs` line 68). Video recording is a context-creation option,
and `browser.newContext()` fails over CDP
(`Target.createBrowserContext: Failed to create browser context`);
recording on an existing context is an open feature request
(<https://github.com/microsoft/playwright/issues/29065>,
<https://stackoverflow.com/questions/72262516>). Rejected: would require
replacing the owned-process session model, not reusing it.

### 2. Puppeteer `page.screencast()` / `page.record()` — rejected

`puppeteer.connect({ browserURL: 'http://127.0.0.1:<debugPort>' })` can attach
to the same Electron CDP endpoint (`browserURL` option added in
<https://github.com/puppeteer/puppeteer/commit/15af75f9a24ad9a91ab7cd7a57290e212c8c1c49>;
Electron remote-debugging pattern in
<https://stackoverflow.com/questions/55579075>). Two problems:

- `page.screencast()` is **deprecated** in favor of `page.record()`, writes
  WebM/VP9 at 30 fps, and still requires ffmpeg on the system
  (<https://pptr.dev/api/puppeteer.page.screencast>).
- `page.record()` is attractive — it uses the new CDP
  `Page.startScreenRecording` and emits an MP4 stream with no ffmpeg
  (<https://pptr.dev/api/puppeteer.page.record>) — but that protocol command is
  tip-of-tree only. It does not exist in Chromium 134; the Cypress team notes it
  would fail at runtime even on Electron 41
  (<https://github.com/cypress-io/cypress/pull/34745>). Off the table until the
  repo's Electron major is much newer.

Rejected: adds a second automation library to the scratch install for something
~40 lines of CDP code already covers. The `puppeteer-mcp-claude` MCP server can
connect via `browserWSEndpoint` but exposes no screencast tool, so it is not a
video path either.

### 3. ffmpeg `gdigrab` (OS-level capture) — viable fallback

ffmpeg's GDI grab device records the whole desktop, a region, or a single
window by title or HWND on Windows
(<https://ffmpeg.org/ffmpeg-devices.html#gdigrab>):

```sh
ffmpeg -y -f gdigrab -framerate 15 -i "title=<window title>" \
  -c:v libx264 -pix_fmt yuv420p .dev/verification/out.mp4
# or a desktop region:
ffmpeg -y -f gdigrab -framerate 15 -offset_x 10 -offset_y 20 \
  -video_size 1280x800 -i desktop out.mp4
```

Get the window title at runtime via `await electronPage.title()` (Electron uses
the page title; there is no static `title:` in `create-window.ts`). Pros: true
wall-clock timing, captures native window chrome and OS dialogs. Cons: needs
ffmpeg anyway, title matching is brittle, and capture degrades if the window is
minimized or fully occluded. Keep as the fallback when CDP screencast frames
prove unreliable; on macOS the equivalent is `-f avfoundation -i "1:none"` and
on X11 `-f x11grab` (same ffmpeg devices doc).

### 4. In-app capture (`desktopCapturer` + `MediaRecorder`) — rejected as invasive

Electron exposes `desktopCapturer.getSources({ types: ['window'] })` and
`session.setDisplayMediaRequestHandler` so a renderer can call
`navigator.mediaDevices.getDisplayMedia` and record the stream with
`MediaRecorder` to a `.webm` Blob saved over IPC
(<https://www.electronjs.org/docs/latest/api/desktop-capturer>;
MediaRecorder: <https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder>).
This produces real-time video including smooth streaming animations, but
requires product code changes (main-process handler, renderer capture UI or
test hook, IPC file save) purely for test evidence. Rejected: violates the
"no product changes for harness evidence" constraint.

## PR attachment reality

Historically there was no public API for PR-body uploads; that is no longer
true. GitHub CLI now supports `--attach` on `gh issue/pr create|edit|comment`,
uploading image and media files and embedding uploaded URLs into the body —
a lone-paragraph `![](local/path.mp4)` reference renders as an inline video
player (<https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli>).
Limits per GitHub docs: 10 MB videos on free plans, 100 MB on paid plans;
supported video types are `.mp4`, `.mov`, `.webm`, with H.264 recommended for
cross-browser playback
(<https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files>).
Keep clips short (a 10–20 s 1280px JPEG-quality-80 screencast encodes well
under 10 MB).

If `--attach` is unavailable (no push access), the remaining options are:
manual drag-drop into the PR body, `gh release upload` + hotlinking the asset
URL, or committing the file — the last is undesirable since `.dev/` is
gitignored by design and binaries do not belong in the repo.

## Caveats

- CDP screencast captures the web contents only, not native window chrome,
  menus, or OS dialogs. Use gdigrab when the evidence must include those.
- `Page.startScreencast` params `maxFramesInFlight`/`sendLastFrame` exist only
  in newer Chromium; on 134 assume strict one-frame-in-flight ack semantics
  (Cypress PR 34745 above documents where those fields appear).
- Screencast emits frames only on repaint; a completely static page yields a
  near-empty video. Trigger a small repaint (or rely on the interaction under
  test) before stopping.
- Frame delivery pauses while an ack is outstanding — write to ffmpeg's stdin
  asynchronously rather than awaiting disk flushes inside the handler.
