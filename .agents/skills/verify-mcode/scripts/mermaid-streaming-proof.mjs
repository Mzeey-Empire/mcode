#!/usr/bin/env bun
/**
 * Live proof: a mermaid fence inside a still-streaming assistant response
 * renders as an SVG diagram before the turn completes.
 *
 * Drives the owned Electron session (electorn-live-testing start-electron.mjs)
 * and the controlled Codex-protocol fixture (transcript-provider-fixture.mjs,
 * "mermaid streaming" scenario) against .dev/fixture-repo only. Restores the
 * previous Codex CLI setting on every exit path.
 *
 * Usage:
 *   bun .agents/skills/verify-mcode/scripts/mermaid-streaming-proof.mjs
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { assertInsideDevDir, getRuntimePaths, resolveRepoRoot } from "../../../../scripts/agent/runtime-contract.mjs";
import { openDesktopSocket, findFixtureWorkspace } from "./thread-lifecycle.mjs";
import { renderFixtureWrapper } from "./codex-protocol-notices.mjs";
import { connectElectronSession, disconnectElectronSession } from "../../electorn-live-testing/scripts/electron-session.mjs";

const DESKTOP_RUNTIME = ".dev/electron-live-testing/runtime";

/** Reloads the app and expands the workspace thread list until the new thread shows. */
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
 * Asserts both live stages: the open mermaid fence shows a skeleton, then the
 * closed diagram, closed code fence, and open-table skeleton all render inside
 * the still-running turn.
 */
async function assertLiveStages(page, stopButton, note) {
  await stopButton.waitFor({ state: "visible", timeout: 15000 });

  const openDiagram = page.locator(
    '[data-testid="streaming-skeleton"][aria-label="diagram assembling"]',
  );
  await openDiagram.waitFor({ state: "visible", timeout: 8000 });
  note("open-fence-skeleton");

  // The live ThoughtBlock is the text row that contains the open-table
  // skeleton; scoping to it proves the closed constructs render inside the
  // still-running turn rather than in the previous settled message.
  const openTable = page.locator(
    '[data-testid="streaming-skeleton"][aria-label="table assembling"]',
  );
  await openTable.waitFor({ state: "visible", timeout: 15000 });
  const live = page.locator("div.px-2.py-1").filter({ has: openTable });
  await live.getByRole("button", { name: "Open diagram preview" }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  const stillRunning = await stopButton.isVisible();
  const errorCount = await live.getByText("Diagram could not be rendered").count();
  const rawFenceCount = await live.getByText(/```/).count();
  const codeVisible = await live.getByText(/interface Turn/).count();
  note("mid-stream-blocks-rendered", { stillRunning, errorCount, rawFenceCount, codeVisible });
  if (!stillRunning) throw new Error("Turn finished before the mid-stream assertion ran");
  if (errorCount > 0) throw new Error("Mermaid render failed mid-stream");
  if (rawFenceCount > 0) throw new Error("Raw fence syntax still visible in the live stream");
  if (codeVisible === 0) throw new Error("Closed code fence not rendered in the live stream");
}

/** Asserts the settled response keeps the diagram, table, and trailing text. */
async function assertSettled(page, stopButton, response, note) {
  await stopButton.waitFor({ state: "hidden", timeout: 60000 });
  await response.getByRole("button", { name: "Open diagram preview" }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  const finalText = await response.innerText();
  if (!finalText.includes("Streaming continues after the diagram closes.")) {
    throw new Error("Streamed tail text missing after completion");
  }
  const headerCells = await response.locator("th").allTextContents();
  if (!headerCells.includes("A") || !headerCells.includes("B")) {
    throw new Error("Settled table missing after completion");
  }
  note("settled-table-rendered");
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const require = NodeModule.createRequire(NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"));
  const playwright = require("playwright");

  const evidenceDir = NodePath.join(repoRoot, ".dev", "verification", "mermaid-streaming");
  assertInsideDevDir(evidenceDir, getRuntimePaths(repoRoot).devDir);
  NodeFS.mkdirSync(evidenceDir, { recursive: true });

  const receipt = { steps: [], restoredCli: false };
  const note = (step, extra = {}) => {
    receipt.steps.push({ step, at: new Date().toISOString(), ...extra });
    console.log(`[proof] ${step}`);
  };

  let session;
  let socket;
  let originalCli;
  try {
    session = await connectElectronSession({ playwright, repoRoot });
    const page = session.page;
    note("electron-session-connected", { pid: session.pid, url: page.url() });

    socket = await openDesktopSocket(repoRoot, NodePath.join(repoRoot, DESKTOP_RUNTIME));
    note("desktop-socket-open");

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
    const title = `Mermaid streaming proof ${Date.now()}`;
    const thread = await socket.rpc("thread.create", { workspaceId: workspace.id, title, mode: "direct", branch });
    receipt.threadId = thread.id;
    note("thread-created", { threadId: thread.id });

    const send = () => socket.rpc("agent.send", {
      threadId: thread.id,
      content: "mermaid streaming",
      messageId: NodeCrypto.randomUUID(),
      provider: "codex",
      model: "gpt-5.6-luna",
      permissionMode: "full",
    });
    const stopButton = page.getByRole("button", { name: "Stop agent" });
    const latestResponse = () => page.getByTestId("assistant-response-text").last();
    const latestDiagram = () => latestResponse().getByRole("button", { name: "Open diagram preview" });

    // Turn 1 starts before navigation so the thread surfaces in the UI.
    await send();
    note("turn-started");

    // Reload so the renderer refetches the thread list including this thread.
    await openThreadInUi(page, title, workspace.name);
    note("thread-opened-in-ui");

    // Turn 1 settles normally: proves the diagram renders end-to-end and warms
    // the lazy mermaid module before the mid-stream assertion.
    await latestDiagram().waitFor({ state: "visible", timeout: 90000 });
    await stopButton.waitFor({ state: "hidden", timeout: 90000 });
    note("settled-diagram-rendered");
    await page.screenshot({ path: NodePath.join(evidenceDir, "settled-reference.png"), fullPage: false });

    await send();
    note("turn-2-started");

    // Live streams render in a ThoughtBlock inside the narrative timeline, not
    // in `assistant-response-text` (that element only exists for settled
    // assistant messages). Skeletons are scoped page-wide because only a live
    // turn can produce them; rendered constructs are asserted by count, where
    // the second copy must come from the still-running turn.
    await assertLiveStages(page, stopButton, note);
    await page.screenshot({ path: NodePath.join(evidenceDir, "mid-stream.png"), fullPage: false });
    note("mid-stream-screenshot");

    // After completion the diagram, code block, and table must persist through
    // the settled MarkdownContent renderer with the trailing text.
    await assertSettled(page, stopButton, latestResponse(), note);
    await page.screenshot({ path: NodePath.join(evidenceDir, "completed.png"), fullPage: false });
    note("completed-diagram-persisted");

    receipt.ok = true;
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
