#!/usr/bin/env node
/**
 * Launch the packaged Electron main process under Playwright, capture a
 * screenshot of the first window, dump main/renderer console output, then
 * exit (leaving the app running if --keep-open is passed).
 *
 * Use this when the change touches Electron-specific surfaces (native menus,
 * tray, BrowserView, contextBridge IPC, deep links, window chrome). For
 * everything else, prefer scripts/agent/demo.mjs — the Vite dev target is
 * faster and Playwright MCP can drive it interactively.
 *
 * Requires: `bun run --filter @mcode/desktop build` to have produced
 * apps/desktop/dist/main/main.cjs (and a server bundle for the child process).
 *
 * Prints an instructions block at the end so an agent knows where artifacts
 * landed.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const KEEP_OPEN = process.argv.includes("--keep-open");
const TIMEOUT_MS = Number(process.env.MCODE_DEMO_TIMEOUT_MS ?? 60_000);
const REPO_ROOT = resolve(process.cwd());
const DESKTOP_DIR = join(REPO_ROOT, "apps", "desktop");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");
const SCREENSHOT_DIR = join(
  REPO_ROOT,
  "apps",
  "web",
  "e2e",
  "screenshots",
  "demo-desktop",
);

if (!existsSync(MAIN_BUNDLE)) {
  console.error(`[demo-desktop] missing build: ${MAIN_BUNDLE}`);
  console.error("[demo-desktop] run `cd apps/desktop && bun run build` first");
  process.exit(1);
}

// Playwright is hoisted in the web workspace. Resolve from there so this
// script works from the repo root without an explicit dep entry.
const require = createRequire(join(REPO_ROOT, "apps", "web", "package.json"));
let playwright;
try {
  playwright = require("@playwright/test");
} catch (err) {
  console.error("[demo-desktop] could not load @playwright/test:", err.message);
  console.error("[demo-desktop] run `bun install` first");
  process.exit(1);
}

const { _electron: electron } = playwright;
mkdirSync(SCREENSHOT_DIR, { recursive: true });

console.log(`[demo-desktop] launching Electron from ${DESKTOP_DIR}`);
const app = await electron.launch({
  args: ["."],
  cwd: DESKTOP_DIR,
  timeout: TIMEOUT_MS,
});

const mainConsole = [];
const rendererErrors = [];
app.process().stdout?.on("data", (b) => mainConsole.push(String(b)));
app.process().stderr?.on("data", (b) => mainConsole.push(String(b)));

const win = await app.firstWindow({ timeout: TIMEOUT_MS });
win.on("console", (m) => {
  if (m.type() === "error") rendererErrors.push(m.text());
});

await win.waitForLoadState("domcontentloaded");

const shot = join(SCREENSHOT_DIR, "first-window.png");
await win.screenshot({ path: shot, fullPage: true });

const title = await win.title();
console.log("");
console.log(`[demo-desktop] first window title: ${title}`);
console.log(`[demo-desktop] screenshot: ${shot}`);
console.log(`[demo-desktop] renderer errors: ${rendererErrors.length}`);
for (const err of rendererErrors) console.log(`  - ${err}`);
console.log("");
console.log("[demo-desktop] artifacts dir:", SCREENSHOT_DIR);
console.log(
  "[demo-desktop] further steps: drive `win` programmatically (click, fill,",
);
console.log(
  "  screenshot per step) — see apps/desktop/e2e/electron-smoke.spec.ts.",
);

if (KEEP_OPEN) {
  console.log("[demo-desktop] --keep-open set; leaving Electron running");
  console.log("[demo-desktop] close the window or Ctrl-C to exit");
  await new Promise(() => {});
} else {
  await app.close();
}
