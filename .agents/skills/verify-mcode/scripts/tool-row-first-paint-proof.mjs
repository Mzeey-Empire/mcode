#!/usr/bin/env bun
/**
 * Live check: a tool row that appears in the transcript paints at its final height, so the
 * rows below it do not move after its first paint.
 *
 * Drives the owned Electron session and the controlled Codex-protocol fixture
 * (transcript-provider-fixture.mjs, "tool row first paint" scenario) against .dev/fixture-repo
 * only. Samples every transcript row once per animation frame and fails when the row below a new
 * tool row moves more than 1 px, relative to that tool row, after the tool row's first paint.
 * Two cases run: a running tool row mounting mid-turn, and the children of a completed group the
 * user opens. Restores the previous Codex CLI setting on every exit path.
 *
 * Usage:
 *   bun .agents/skills/verify-mcode/scripts/tool-row-first-paint-proof.mjs [--case running|group]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { assertInsideDevDir, getRuntimePaths, resolveRepoRoot } from "../../../../scripts/agent/runtime-contract.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "../../../../scripts/agent/managed-desktop.mjs";
import { openDesktopSocket, findFixtureWorkspace } from "./thread-lifecycle.mjs";
import { renderFixtureWrapper } from "./codex-protocol-notices.mjs";
import { connectElectronSession, disconnectElectronSession } from "../../electorn-live-testing/scripts/electron-session.mjs";

const DESKTOP_RUNTIME = ".dev/electron-agent-runtime/runtime";
const MAX_MOVE_PX = 1;
const SETTLE_MS = 1200;
const MIN_USABLE_SAMPLES = 10;
const SETTLE_COVERAGE_SLACK_MS = 100;
// About six frames at 60 Hz: a longer hole could hide a move that reverses before the next sample.
const MAX_SAMPLE_GAP_MS = 100;
const RUNNING_MARKER = "fixture first paint hold";

/** Reloads the app and expands the workspace thread list until the thread shows, then opens it. */
async function openThreadInUi(page, title, workspaceName) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("thread-list").waitFor({ state: "visible", timeout: 30000 });
  const titleLocator = page.getByTestId("thread-title").filter({ hasText: title });
  const expander = page.getByRole("button", { name: `Toggle threads for ${workspaceName}` });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await titleLocator.isVisible().catch(() => false)) break;
    if ((await expander.getAttribute("aria-expanded").catch(() => null)) !== "true") {
      await expander.click({ timeout: 5000, force: true }).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  await titleLocator.click({ timeout: 15000 });
}

/**
 * Starts a per-frame sampler in the page. Each sample runs in a task queued from the frame
 * callback, so it reads the layout that frame painted rather than the layout before the
 * viewport's own frame callback applied its measurements.
 */
async function startSampler(page) {
  await page.evaluate((runningMarker) => {
    const frames = [];
    window.__firstPaintFrames = frames;
    window.__firstPaintOn = true;
    const sample = () => {
      if (!window.__firstPaintOn) return;
      const rows = [];
      for (const host of document.querySelectorAll("[data-transcript-key]")) {
        if (!host.checkVisibility()) continue;
        const rect = host.getBoundingClientRect();
        const text = host.textContent ?? "";
        const child = host.querySelector('[aria-label^="Tool call "]')?.getAttribute("aria-label") ?? null;
        rows.push({
          key: host.getAttribute("data-transcript-key"),
          top: Math.round(rect.top * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          // The progress indicator below a running tool repeats its command, so match tool rows only.
          running: text.includes(runningMarker) && !child && host.getAttribute("data-transcript-key").includes(":tool:"),
          child,
        });
      }
      rows.sort((a, b) => a.top - b.top);
      frames.push({ t: Math.round(performance.now()), rows });
      requestAnimationFrame(tick);
    };
    const tick = () => setTimeout(sample, 0);
    requestAnimationFrame(tick);
  }, RUNNING_MARKER);
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__firstPaintOn = false;
    return window.__firstPaintFrames;
  });
}

/**
 * Measures how far the row below a new tool row moves, relative to the tool row's own top, from
 * the tool row's first painted frame until SETTLE_MS later. Measuring relative to the tool row
 * ignores tail-follow scrolling, which moves every row together.
 */
function measure(frames, isTarget, isLastOfTarget = isTarget) {
  const first = firstPaintIndex(frames, isTarget);
  const following = rowBelowTarget(frames[first].rows, isLastOfTarget);
  const offsetAt = (frame) => {
    const target = frame.rows.find(isTarget);
    const below = frame.rows.find((row) => row.key === following.key);
    return target && below ? below.top - target.top : null;
  };
  const firstOffset = offsetAt(frames[first]);
  const trail = [];
  let maxMove = 0;
  for (const frame of frames.slice(first)) {
    if (frame.t - frames[first].t > SETTLE_MS) break;
    const offset = offsetAt(frame);
    if (offset === null) continue;
    const move = Math.round(Math.abs(offset - firstOffset) * 10) / 10;
    maxMove = Math.max(maxMove, move);
    const target = frame.rows.find(isTarget);
    trail.push({ t: frame.t - frames[first].t, targetHeight: target.height, offset: Math.round(offset * 10) / 10, move });
  }
  assertSettleCoverage(trail);
  return { followingKey: following.key, firstOffset: Math.round(firstOffset * 10) / 10, maxMove, trail };
}

function firstPaintIndex(frames, isTarget) {
  const first = frames.findIndex((frame) => frame.rows.some(isTarget));
  if (first < 0) throw new Error("The new tool row never painted while the sampler ran");
  if (first === 0) throw new Error("The new tool row was already on screen when sampling began");
  return first;
}

function rowBelowTarget(rows, isLastOfTarget) {
  const lastOfTarget = rows.findIndex(isLastOfTarget);
  if (lastOfTarget < 0) throw new Error("The new tool row's last row was not painted on its first frame");
  const following = rows[lastOfTarget + 1];
  if (!following) throw new Error("No row painted below the new tool row on its first frame");
  return following;
}

/** A pass needs both rows measured through the whole settle window, or a vanished row reads as still. */
function assertSettleCoverage(trail) {
  const lastT = trail.at(-1)?.t ?? 0;
  if (trail.length < MIN_USABLE_SAMPLES || lastT < SETTLE_MS - SETTLE_COVERAGE_SLACK_MS) {
    throw new Error(`Only ${trail.length} usable samples, the last at ${lastT} ms of ${SETTLE_MS} ms`);
  }
  const gapIndex = trail.findIndex((step, index) => index > 0 && step.t - trail[index - 1].t > MAX_SAMPLE_GAP_MS);
  if (gapIndex > 0) {
    throw new Error(`No usable sample between ${trail[gapIndex - 1].t} ms and ${trail[gapIndex].t} ms`);
  }
}

function compactTrail(trail) {
  const kept = [];
  for (const step of trail) {
    if (kept.at(-1)?.offset !== step.offset || kept.at(-1)?.targetHeight !== step.targetHeight) kept.push(step);
  }
  return kept;
}

async function runRunningCase(page, send, stopButton, note) {
  await startSampler(page);
  await send("tool row first paint");
  await page.getByText(RUNNING_MARKER).first().waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(SETTLE_MS + 300);
  const frames = await stopSampler(page);
  const result = measure(frames, (row) => row.running);
  note("running-row-measured", { maxMove: result.maxMove, followingKey: result.followingKey });
  await stopButton.waitFor({ state: "hidden", timeout: 60000 });
  return { ...result, trail: compactTrail(result.trail) };
}

async function runGroupCase(page, note) {
  // A completed turn folds its work under "Worked for", so the group shows once that opens.
  const fold = page.getByRole("button", { name: /Worked for/ }).last();
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  const summary = page.getByRole("button", { name: /Ran \d+ commands/ }).last();
  await summary.waitFor({ state: "visible", timeout: 20000 });
  if ((await summary.getAttribute("aria-expanded")) === "true") {
    await summary.click();
    await page.waitForTimeout(800);
  }
  await startSampler(page);
  await page.waitForTimeout(100);
  await summary.click();
  await page.waitForTimeout(SETTLE_MS + 300);
  const frames = await stopSampler(page);
  const result = measure(
    frames,
    (row) => row.child?.startsWith("Tool call 1 of ") === true,
    (row) => row.child !== null && /^Tool call (\d+) of \1$/.test(row.child),
  );
  note("group-children-measured", { maxMove: result.maxMove, followingKey: result.followingKey });
  return { ...result, trail: compactTrail(result.trail) };
}

function parseCases(argv) {
  const index = argv.indexOf("--case");
  if (index < 0) return ["running", "group"];
  const value = argv[index + 1];
  if (value !== "running" && value !== "group") throw new Error("--case must be running or group");
  return [value];
}

async function main() {
  const cases = parseCases(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const require = NodeModule.createRequire(NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"));
  const playwright = require("playwright");

  const evidenceDir = NodePath.join(repoRoot, ".dev", "verification", "tool-row-first-paint");
  assertInsideDevDir(evidenceDir, getRuntimePaths(repoRoot).devDir);
  NodeFS.mkdirSync(evidenceDir, { recursive: true });

  const receipt = { maxMovePx: MAX_MOVE_PX, results: {}, steps: [], restoredCli: false };
  const note = (step, extra = {}) => {
    receipt.steps.push({ step, at: new Date().toISOString(), ...extra });
    console.log(`[check] ${step}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`);
  };

  let session;
  let socket;
  let originalCli;
  try {
    session = await connectElectronSession({ playwright, repoRoot, sessionFileName: MANAGED_DESKTOP_SESSION_FILE });
    const page = session.page;
    socket = await openDesktopSocket(repoRoot, NodePath.join(repoRoot, DESKTOP_RUNTIME));

    const wrapperDir = NodePath.join(evidenceDir, "fixture-cli");
    NodeFS.mkdirSync(wrapperDir, { recursive: true });
    const cliPath = NodePath.join(wrapperDir, "provider.cmd");
    NodeFS.writeFileSync(
      cliPath,
      renderFixtureWrapper(process.execPath, NodePath.join(import.meta.dirname, "transcript-provider-fixture.mjs")),
    );
    originalCli = (await socket.rpc("settings.get", {})).provider.cli.codex;
    await socket.rpc("settings.update", { provider: { cli: { codex: cliPath } } });
    note("fixture-cli-installed");

    const workspace = await findFixtureWorkspace(socket, getRuntimePaths(repoRoot).fixtureRepoDir);
    const branch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], {
      cwd: workspace.path, encoding: "utf8", windowsHide: true,
    }).trim();
    const title = `Tool row first paint ${Date.now()}`;
    const thread = await socket.rpc("thread.create", { workspaceId: workspace.id, title, mode: "direct", branch });
    receipt.threadId = thread.id;

    const send = (content) => socket.rpc("agent.send", {
      threadId: thread.id,
      content,
      messageId: NodeCrypto.randomUUID(),
      provider: "codex",
      model: "gpt-5.6-luna",
      permissionMode: "full",
    });
    const stopButton = page.getByRole("button", { name: "Stop agent" });

    // A short warm-up turn makes the thread visible in the UI, so the sampler starts before the
    // measured turn mounts anything.
    await send("warm up");
    await openThreadInUi(page, title, workspace.name);
    await stopButton.waitFor({ state: "hidden", timeout: 60000 });
    await page.waitForTimeout(500);
    note("thread-open");

    const running = await runRunningCase(page, send, stopButton, note);
    if (cases.includes("running")) receipt.results.running = running;
    if (cases.includes("group")) receipt.results.group = await runGroupCase(page, note);
    await page.screenshot({ path: NodePath.join(evidenceDir, "end.png") });

    const failed = Object.entries(receipt.results).filter(([, result]) => result.maxMove > MAX_MOVE_PX);
    receipt.ok = failed.length === 0;
    for (const [name, result] of Object.entries(receipt.results)) {
      console.log(`${name}: the row below moved ${result.maxMove}px after first paint (limit ${MAX_MOVE_PX}px)`);
      for (const step of result.trail.slice(0, 16)) console.log(`  ${JSON.stringify(step)}`);
    }
  } finally {
    if (socket && originalCli !== undefined) {
      await socket.rpc("settings.update", { provider: { cli: { codex: originalCli } } });
      receipt.restoredCli = true;
    }
    if (socket) await socket.close();
    if (session) await disconnectElectronSession(session);
    NodeFS.writeFileSync(NodePath.join(evidenceDir, "receipt.json"), JSON.stringify(receipt, null, 2));
  }
  console.log(JSON.stringify({ ok: receipt.ok === true, evidenceDir }, null, 2));
  if (receipt.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
