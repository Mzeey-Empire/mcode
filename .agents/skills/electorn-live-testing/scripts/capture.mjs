#!/usr/bin/env node
/**
 * Screenshots the owned Electron app as it stands, optionally at a window size, with the pointer
 * over one element, and with fixture usage. It never reloads the app, so drive the app to the
 * screen first, then capture. Creates the output folder.
 *
 *   node .agents/skills/electorn-live-testing/scripts/capture.mjs --out <file.png>
 *     [--width <px> --height <px>] [--hover <selector>] [--usage-fixture <providerId>]
 *
 * `--hover` takes a Playwright selector that matches one element, such as
 * `role=button[name="Settings"]` or `[data-testid="thread-overview-card"]`.
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { connectElectronSession, disconnectElectronSession } from "./electron-session.mjs";
import { applyUsageCaptureFixture, restoreUsageCaptureFixture, USAGE_CAPTURE_FIXTURE_SUFFIX } from "./usage-fixture.mjs";
import { setElectronWindowSize } from "./window-state.mjs";

const REPO_ROOT = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));

// App.tsx opens tooltips 400 ms after the pointer arrives; transitions start after that.
const TOOLTIP_OPEN_DELAY_MS = 400;
const SETTLE_TIMEOUT_MS = 5_000;

/** Parses capture arguments and resolves the output path against `cwd`. */
export function parseCaptureArguments(argv, cwd = process.cwd()) {
  const { values } = NodeUtil.parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      hover: { type: "string" },
      "usage-fixture": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.out?.toLowerCase().endsWith(".png")) throw new Error("Pass --out <file.png>");
  if ((values.width === undefined) !== (values.height === undefined)) {
    throw new Error("Pass --width and --height together");
  }
  if (values.hover !== undefined && values.hover.trim() === "") throw new Error("--hover needs a selector");
  const usageFixtureProviderId = values["usage-fixture"] ?? null;
  return {
    outPath: markUsageFixture(NodePath.resolve(cwd, values.out), usageFixtureProviderId !== null),
    size: values.width === undefined ? null : { width: parsePixels("width", values.width), height: parsePixels("height", values.height) },
    hover: values.hover ?? null,
    usageFixtureProviderId,
  };
}

function parsePixels(name, text) {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive whole number of pixels; received ${text}`);
  }
  return value;
}

// A capture that shows invented usage must not pass for a live one.
function markUsageFixture(outPath, usesFixture) {
  if (!usesFixture || outPath.toLowerCase().endsWith(`${USAGE_CAPTURE_FIXTURE_SUFFIX}.png`)) return outPath;
  return `${outPath.slice(0, -".png".length)}${USAGE_CAPTURE_FIXTURE_SUFFIX}.png`;
}

/** Captures the connected app page as described by {@link parseCaptureArguments}. */
export async function capture(page, { outPath, size, hover, usageFixtureProviderId }) {
  await restoreUsageCaptureFixture(page);
  if (size) await setElectronWindowSize(page, size);
  if (usageFixtureProviderId) await applyUsageCaptureFixture(page, { providerId: usageFixtureProviderId });
  try {
    if (hover) {
      await page.locator(hover).hover();
      await page.waitForTimeout(TOOLTIP_OPEN_DELAY_MS);
    }
    await waitForFiniteAnimations(page);
    NodeFS.mkdirSync(NodePath.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    return outPath;
  } finally {
    await restoreUsageCaptureFixture(page);
  }
}

// Hover backgrounds and tooltips fade in. Infinite animations, such as spinners, never finish.
async function waitForFiniteAnimations(page) {
  await page.evaluate(async (timeoutMs) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, SETTLE_TIMEOUT_MS);
}

function loadPlaywright() {
  const scratchPackage = NodePath.join(REPO_ROOT, ".dev", "playwright-scratch", "package.json");
  if (!NodeFS.existsSync(scratchPackage)) {
    throw new Error("Playwright is missing. Run bun .agents/skills/electorn-live-testing/scripts/ensure-playwright.mjs first.");
  }
  return NodeModule.createRequire(scratchPackage)("playwright");
}

// Node before 22.18 and 24.2 leaves import.meta.main undefined; without the fallback the
// command would exit without a capture or an error.
function isEntryPoint() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  const invoked = NodePath.resolve(process.argv[1]);
  const self = NodeURL.fileURLToPath(import.meta.url);
  return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isEntryPoint()) {
  const options = parseCaptureArguments(process.argv.slice(2));
  const session = await connectElectronSession({ playwright: loadPlaywright(), repoRoot: REPO_ROOT });
  try {
    const outPath = await capture(session.page, options);
    console.log(JSON.stringify({ outPath, usageFixture: options.usageFixtureProviderId !== null }));
  } finally {
    await disconnectElectronSession(session);
  }
}
