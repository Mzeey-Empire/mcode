#!/usr/bin/env bun
/** Verifies the Codex Composer and Last turn Review journey in separate web and Electron clients. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { getRuntimePaths, readPortsFile, resolveRepoRoot } from "../../../../scripts/agent/runtime-contract.mjs";
import { assertRuntimeFreshness, deleteLiveWorkspace, openRuntimeVerificationSocket, openVerificationSocketUrl } from "./runtime.mjs";

const MODEL = "gpt-5.6-terra";
const EVIDENCE_DIRECTORY = ".dev/verification/provider-completeness";
const HEALTH_TIMEOUT_MS = 10_000;
const TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 180_000;
const MAX_LIVE_COMPARISON_STATES = 24;
const FOCUSED_GATE_TIMEOUT_MS = 120_000;
const FOCUSED_GATES = [
  { name: "server-turn-diff-review", workspace: "apps/server", options: ["--no-file-parallelism", "--testTimeout=30000"], files: ["src/features/agents/turns/__tests__/turn-diff-review.test.ts"], rows: ["empty", "interruption"] },
  { name: "server-approval-review-policy", workspace: "apps/server", options: ["--no-file-parallelism"], files: ["src/features/agents/turns/__tests__/approval-review-policy.test.ts"], rows: ["strictManual", "managedRequired"] },
  { name: "server-workspace-invalidation", workspace: "apps/server", options: ["--no-file-parallelism"], files: ["src/features/projects/files/__tests__/workspace-invalidation-service.test.ts"], rows: ["invalidation", "staleRetry", "disconnectWatchCleanup"] },
  { name: "codex-protocol", workspace: "packages/providers", files: ["src/__tests__/codex/codex-notification-validation.test.ts", "src/__tests__/codex/codex-protocol-coverage.test.ts", "src/__tests__/codex/codex-event-mapper.test.ts"], rows: ["warningsReroutes"] },
  { name: "web-composer-and-files", workspace: "apps/web", files: ["src/features/conversation/composer/controls/__tests__/ComposerAccessControls.test.tsx", "src/features/projects/files/useWorkspaceFileInvalidation.test.tsx", "src/components/diff/__tests__/DiffPanel.files.test.tsx"], rows: ["fullAccess", "fileSurfaces"] },
];
const HELP = `Verify provider completeness

Usage:
  bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs provider-completeness <health|proof|cleanup> [options]

Commands:
  health
      Check the matching runtime, idle-agent gate, and separate Chromium setup.
  proof --confirm-provider-call --confirm-cleanup
      Drive the normal Codex Composer journey in separate web Chromium and Electron clients.
  cleanup --confirm-cleanup
      Delete only exact resources named in incomplete provider-completeness receipts.`;

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) return console.log(HELP);
    const repoRoot = resolveRepoRoot();
    const result = parsed.command === "health" ? await health(repoRoot) : parsed.command === "cleanup" ? await cleanup(repoRoot) : await proof(repoRoot);
    console.log(JSON.stringify({ ok: true, command: parsed.command, ...result }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, command: parsed?.command ?? null, failure: safeError(error) }, null, 2));
    process.exitCode = 1;
  }
}

export function parseArguments(args) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { help: true };
  const [command, ...options] = args;
  if (command === "health" && options.length === 0) return { command };
  if (command === "proof" && sameOptions(options, ["--confirm-provider-call", "--confirm-cleanup"])) return { command };
  if (command === "cleanup" && sameOptions(options, ["--confirm-cleanup"])) return { command };
  throw new Error("Condition: provider-completeness requires health, proof --confirm-provider-call --confirm-cleanup, or cleanup --confirm-cleanup. Next action: Run provider-completeness --help.");
}

function sameOptions(actual, expected) { return actual.length === expected.length && expected.every((option) => actual.includes(option)); }

async function health(repoRoot) {
  assertRuntimeFreshness(repoRoot);
  const ports = readPortsFile(repoRoot);
  if (!pathsMatch(ports.worktreeIdentity, repoRoot)) throw new Error("Condition: ports.json belongs to another worktree. Next action: start this worktree runtime with bun run --shell system agent:up.");
  const response = await fetch(ports.healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Condition: runtime health returned ${response.status}. Next action: start this worktree runtime with bun run --shell system agent:up.`);
  const payload = await response.json();
  if (payload?.status !== "ok") throw new Error("Condition: runtime health response was invalid. Next action: restart this worktree runtime.");
  if (!Number.isInteger(payload.activeAgents) || payload.activeAgents !== 0) throw new Error("Condition: provider-completeness requires zero active agents. Next action: wait for active turns to settle, then retry.");
  const chromiumPath = findChromiumPath();
  if (!chromiumPath) throw new Error("Condition: no system Chromium executable is available. Next action: install Chrome or Edge, then retry.");
  requirePlaywright(repoRoot);
  return { appUrl: ports.appUrl, worktreeIdentityMatchesRepo: true, playwrightReady: true, chromiumPath: NodePath.basename(chromiumPath) };
}

/** Runs the deterministic issue-owned tests and records their exact evidence once per proof. */
export async function runFocusedEvidenceGates(repoRoot, receipt, runner = runFocusedGate) {
  const failures = [];
  receipt.focusedGates = [];
  for (const gate of FOCUSED_GATES) {
    const args = ["run", "--cwd", gate.workspace, "test", "--", ...(gate.options ?? []), ...gate.files];
    let result;
    try {
      result = await runner({ command: "bun", args, cwd: repoRoot, timeoutMs: FOCUSED_GATE_TIMEOUT_MS });
    } catch (error) {
      result = { exitCode: null, output: safeError(error) };
    }
    const evidence = { name: gate.name, command: `bun ${args.join(" ")}`, rows: gate.rows, exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null, output: redactOutput(result?.output) };
    receipt.focusedGates.push(evidence);
    for (const matrix of [receipt.matrix, receipt.electron.matrix]) {
      for (const row of gate.rows) matrix[row] = { kind: evidence.exitCode === 0 ? "focused-proof" : "focused-proof-failed", gate: gate.name, command: evidence.command, exitCode: evidence.exitCode, output: evidence.output };
    }
    if (evidence.exitCode !== 0) failures.push(`${gate.name} exited ${evidence.exitCode ?? "without an exit code"}`);
  }
  return failures;
}

function focusedEvidenceFailure(failures) {
  return failures.length ? new Error(`Condition: focused evidence gate failed: ${failures.join("; ")}.`) : null;
}

async function runFocusedGate({ command, args, cwd, timeoutMs }) {
  return await new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, { cwd, shell: false, windowsHide: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output = appendBoundedOutput(output, chunk); });
    child.stderr.on("data", (chunk) => { output = appendBoundedOutput(output, chunk); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ exitCode: null, output: safeError(error) }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: timedOut ? null : code, output: timedOut ? `${output}\nTimed out after ${timeoutMs}ms.` : output }); });
  });
}

function appendBoundedOutput(output, chunk) { return `${output}${String(chunk)}`.slice(-8_000); }
function redactOutput(output) { return typeof output === "string" ? output.replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]").replace(/(?:token|authorization|cookie)\s*[:=]\s*\S+/gi, "$&[redacted]").slice(-8_000) : ""; }

export async function proof(repoRoot, dependencies = {}) {
  const receipt = createReceipt(repoRoot);
  receipt.applicationCommit = resolveApplicationCommit(repoRoot);
  const io = dependencies.io ?? NodeFS.promises;
  let socket; let electronSocket; let web; let desktop; let electronOwner; let failure;
  try {
    receipt.phase = "health";
    receipt.runtime = dependencies.health ? await dependencies.health(repoRoot) : await health(repoRoot);
    receipt.upstreamCodex = (dependencies.resolveUpstreamCodex ?? resolveUpstreamCodex)(repoRoot);
    receipt.phase = "focused-evidence";
    const focusedFailures = await runFocusedEvidenceGates(repoRoot, receipt, dependencies.runner);
    receipt.phase = "clients";
    socket = dependencies.socket ?? await openRuntimeVerificationSocket(repoRoot);
    const workspace = await createOwnedFixtureWorkspace(socket, repoRoot, receipt);
    receipt.workspace = { id: workspace.id, name: workspace.name, path: workspace.path };
    receipt.matrix = await inspectProviderPrerequisites(socket, workspace);
    const ports = readPortsFile(repoRoot);
    const playwright = dependencies.playwright ?? requirePlaywright(repoRoot);
    web = dependencies.web ?? await openWeb(playwright, ports, findChromiumPath());
    if (dependencies.desktop) desktop = dependencies.desktop;
    else ({ desktop, owner: electronOwner } = await openDesktop(repoRoot, playwright, ports, dependencies.electron));
    assertSeparateClients(web, desktop);
    await reloadClient(web);
    await assertWorkspace(web.page, workspace, socket);
    receipt.phase = "electron-runtime";
    const desktopServerUrl = await desktop.page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
    electronSocket = dependencies.electronSocket ?? await openVerificationSocketUrl(repoRoot, desktopServerUrl);
    const electronRun = createSurfaceRun(repoRoot, receipt, "electron");
    const electronWorkspace = await createOwnedFixtureWorkspace(electronSocket, repoRoot, electronRun);
    receipt.electron.workspace = { id: electronWorkspace.id, name: electronWorkspace.name, path: electronWorkspace.path };
    receipt.electron.matrix = await inspectProviderPrerequisites(electronSocket, electronWorkspace);
    await reloadClient(desktop);
    await assertWorkspace(desktop.page, electronWorkspace, electronSocket);
    receipt.phase = "provider-journeys";
    receipt.journeys.web = await runProviderJourneys({ surface: "web", client: web, socket, workspace, run: receipt, io, matrix: receipt.matrix, captureLive: dependencies.captureLive ?? captureLive, captureReview: dependencies.captureReview ?? captureReview });
    receipt.journeys.electron = await runProviderJourneys({ surface: "electron", client: desktop, socket: electronSocket, workspace: electronWorkspace, run: electronRun, io, matrix: receipt.electron.matrix, captureLive: dependencies.captureLive ?? captureLive, captureReview: dependencies.captureReview ?? captureReview });
    const codexJourney = receipt.journeys.web.codexNative?.journey;
    receipt.baseline = codexJourney?.baseline ?? "not proven";
    receipt.publicComparison = codexJourney?.comparison?.agentLive ?? "not proven";
    receipt.fetchedPatch = codexJourney?.fetchedPatch ?? "not proven";
    receipt.disk = codexJourney?.disk ?? "not proven";
    receipt.comparison = codexJourney?.comparison ?? {};
    receipt.observations = codexJourney?.observations ?? {};
    receipt.phase = "aggregate-evidence";
    const failures = aggregateEvidenceFailures(focusedFailures, { web: receipt.matrix, electron: receipt.electron.matrix });
    if (failures.length > 0) throw new Error(`Condition: provider completeness evidence failed: ${failures.join("; ")}.`);
    receipt.phase = "complete";
  } catch (error) {
    failure = error; receipt.failure = { phase: receipt.phase, message: safeError(error), classification: classifyLiveDiffFailure(receipt.phase, error) };
    await captureFailure(web?.page, receipt, "web-failure"); await captureFailure(desktop?.page, receipt, "electron-failure");
  } finally {
    receipt.diagnostics.codexTrace = (dependencies.captureCodexTraceEvidence ?? captureCodexTraceEvidence)(repoRoot, receipt.run.threadId);
    receipt.phase = "cleanup";
    receipt.cleanup = await cleanupOwned({ socket, electronSocket, web, desktop, electronOwner, io, receipt, repoRoot, reconnectElectronSocket: desktop ? async () => {
      const serverUrl = await desktop.page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
      return openVerificationSocketUrl(repoRoot, serverUrl);
    } : undefined });
    await writeReceipt(io, receipt);
    if (receipt.cleanup.failures.length > 0 && !failure) failure = new Error(`Condition: cleanup failed: ${receipt.cleanup.failures.join("; ")}. Run provider-completeness cleanup --confirm-cleanup.`);
  }
  if (failure) throw failure;
  return { receipt: receipt.path, journeys: receipt.journeys, matrix: receipt.matrix, electronMatrix: receipt.electron.matrix, cleanup: receipt.cleanup };
}

export function createReceipt(repoRoot) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomUUID()}`;
  const directory = NodePath.join(repoRoot, EVIDENCE_DIRECTORY, runId);
  const fixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${runId}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  return { runId, phase: "initializing", path: NodePath.join(directory, "receipt.json"), directory, fixtureDirectory, fixtureFile: NodePath.join(fixtureDirectory, "target.txt"), applicationCommit: "not reached", upstreamCodex: "not reached", provider: "codex", model: MODEL, baseline: "not reached", publicComparison: "not reached", fetchedPatch: "not reached", disk: "not reached", renderedEvidence: [], run: { ownedWorkspaceId: null, ownedFixtureDirectory: null, ownedFile: null, threadId: null, ownedThreadIds: [] }, electron: { matrix: providerMatrix() }, journeys: {}, screenshots: [], observations: {}, comparison: {}, diagnostics: { liveComparisons: { states: [], omitted: 0 } }, matrix: providerMatrix(), cleanup: { complete: false, failures: [] }, failure: null };
}

function createSurfaceRun(repoRoot, receipt, surface) {
  const fixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}-${surface}`);
  const run = { fixtureDirectory, fixtureFile: NodePath.join(fixtureDirectory, "target.txt"), runId: `${receipt.runId}-${surface}`, directory: receipt.directory, screenshots: receipt.screenshots, renderedEvidence: receipt.renderedEvidence, comparison: {}, run: { ownedWorkspaceId: null, ownedFixtureDirectory: null, ownedFile: null, threadId: null, ownedThreadIds: [] }, diagnostics: { liveComparisons: { states: [], omitted: 0 } } };
  receipt.electron = { ...receipt.electron, ...run };
  return run;
}

/** Creates a unique verifier directory before registration, establishing exclusive ownership. */
export async function createOwnedFixtureWorkspace(socket, repoRoot, receipt) {
  const fixtureRoot = getRuntimePaths(repoRoot).fixtureRepoDir;
  if (!isWithin(receipt.fixtureDirectory, fixtureRoot)) throw new Error("Condition: verifier fixture directory escaped .dev/fixture-repo.");
  NodeFS.mkdirSync(receipt.fixtureDirectory);
  receipt.run.ownedFixtureDirectory = receipt.fixtureDirectory;
  const existing = await socket.rpc("workspace.list", {});
  if (!Array.isArray(existing)) throw new Error("Condition: workspace.list returned an unexpected value.");
  if (existing.some((workspace) => pathsMatch(workspace?.path, receipt.fixtureDirectory))) throw new Error("Condition: a workspace already uses this verifier fixture directory.");
  let workspace;
  try {
    workspace = await socket.rpc("workspace.create", { name: `Provider completeness ${receipt.runId}`, path: receipt.fixtureDirectory });
  } catch (error) {
    workspace = await reconcileOwnedFixtureWorkspace(socket, receipt, error);
    if (!workspace) throw error;
  }
  if (!workspace?.id || !pathsMatch(workspace.path, receipt.fixtureDirectory)) {
    workspace = await reconcileOwnedFixtureWorkspace(socket, receipt, new Error("Condition: workspace.create did not return the exact verifier fixture workspace."));
    if (!workspace) throw new Error("Condition: workspace.create did not return the exact verifier fixture workspace.");
  }
  receipt.run.ownedWorkspaceId = workspace.id;
  return workspace;
}

/** Reconciles an uncertain create result only when one exact owned fixture registration exists. */
export async function reconcileOwnedFixtureWorkspace(socket, receipt, originalError) {
  let workspaces;
  try { workspaces = await socket.rpc("workspace.list", {}); } catch (error) {
    recordWorkspaceCleanupGap(receipt, `workspace.create outcome could not be reconciled: ${safeError(error)}`);
    throw originalError;
  }
  if (!Array.isArray(workspaces)) {
    recordWorkspaceCleanupGap(receipt, "workspace.create outcome could not be reconciled: workspace.list returned an unexpected value.");
    throw originalError;
  }
  const matches = workspaces.filter((candidate) => candidate?.id && pathsMatch(candidate.path, receipt.fixtureDirectory));
  if (matches.length === 1) return matches[0];
  recordWorkspaceCleanupGap(receipt, matches.length === 0
    ? "workspace.create outcome could not be reconciled: no exact verifier fixture workspace was found."
    : "workspace.create outcome could not be reconciled: multiple exact verifier fixture workspaces were found.");
  throw originalError;
}

function recordWorkspaceCleanupGap(receipt, gap) {
  receipt.cleanup.failures.push(`workspace: ${gap}`);
  receipt.cleanup.workspaceCleanupGap = gap;
}

/** Records public provider prerequisites before a provider call is considered. */
export async function inspectProviderPrerequisites(socket, workspace, execute = NodeChildProcess.execFileSync) {
  const availabilityResult = await Promise.allSettled([socket.rpc("providers.listAvailability", {})]);
  const availability = availabilityResult[0].status === "fulfilled" && Array.isArray(availabilityResult[0].value)
    ? availabilityResult[0].value
    : [];
  const availabilityError = availabilityResult[0].status === "rejected" ? safeError(availabilityResult[0].reason) : null;
  const matrix = {};
  for (const provider of ["codex", "cursor", "claude"]) {
    const observed = availability.find((candidate) => candidate?.id === provider) ?? null;
    const [models, catalog] = await Promise.allSettled([
      socket.rpc("provider.listModels", { providerId: provider }),
      socket.rpc("provider.catalog", { providerId: provider, workspaceId: workspace.id }),
    ]);
    const available = observed?.enabled === true && observed?.hasAdapter === true && observed?.comingSoon !== true && observed?.cli?.status === "found";
    const modelList = models.status === "fulfilled" && Array.isArray(models.value) ? models.value : [];
    const catalogValue = catalog.status === "fulfilled" ? catalog.value : null;
    const account = provider === "claude" && observed?.cli?.status === "found" ? inspectClaudeAccountStatus(execute) : null;
    const observedPrerequisites = {
      availability: observed ? { enabled: observed.enabled === true, hasAdapter: observed.hasAdapter === true, comingSoon: observed.comingSoon === true, cliStatus: observed.cli?.status ?? null } : null,
      models: modelList.map((model) => model?.id).filter((id) => typeof id === "string").slice(0, 100),
      catalog: catalogValue ? { freshness: catalogValue.freshness ?? null, selectableAgents: Array.isArray(catalogValue.selectableAgents) ? catalogValue.selectableAgents.length : 0 } : null,
      account,
      errors: [availabilityError, models.status === "rejected" ? safeError(models.reason) : null, catalog.status === "rejected" ? safeError(catalog.reason) : null].filter(Boolean),
    };
    const selectableModel = provider === "codex" ? modelList.find((model) => model?.id === MODEL) : modelList[0];
    const unavailableClaudeAccount = account?.status === "not-authenticated";
    matrix[`${provider}${provider === "claude" ? "Fallback" : "Native"}`] = available && models.status === "fulfilled" && catalog.status === "fulfilled" && selectableModel?.id && !unavailableClaudeAccount
      ? { kind: "required-live-proof", provider, model: selectableModel.id, modelName: typeof selectableModel.name === "string" ? selectableModel.name : selectableModel.id, observedPrerequisites }
      : { kind: "coverage-gap", provider, observedPrerequisites, coverageGap: unavailableClaudeAccount ? "Claude CLI reported no authenticated account for the public Composer journey." : "missing provider, account, model, or catalog prerequisite for the required public Composer and Review journey" };
  }
  return matrix;
}

/** Identifies a missing Claude CLI account without retaining command output. */
export function inspectClaudeAccountStatus(execute = NodeChildProcess.execFileSync) {
  let output = "";
  try {
    output = String(execute("claude", ["auth", "status"], { encoding: "utf8", timeout: 10_000, windowsHide: true }) ?? "");
  } catch (error) {
    output = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
  }
  try {
    const status = JSON.parse(output);
    if (status?.loggedIn === false) return { status: "not-authenticated", loggedIn: false };
    if (status?.loggedIn === true) return { status: "authenticated", loggedIn: true };
  } catch { /* A non-JSON CLI response cannot establish account state. */ }
  return { status: "unknown", loggedIn: null };
}

/** Rejects a receipt that silently turns an available provider into a coverage gap. */
export function assertEveryAvailableProviderWasProven(matrix) {
  const unproven = Object.values(matrix)
    .filter((entry) => entry?.kind === "required-live-proof" || entry?.kind === "live-proof-failed")
    .map((entry) => entry.provider);
  if (unproven.length > 0) throw new Error(`Condition: required public Composer and Review proof was not executed for available provider(s): ${unproven.join(", ")}.`);
}

/** Lists focused-gate and provider-journey failures after every surface has run. */
export function aggregateEvidenceFailures(focusedFailures, surfaces) {
  const providerFailures = Object.entries(surfaces).flatMap(([surface, matrix]) => Object.values(matrix)
    .filter((entry) => entry?.kind === "required-live-proof" || entry?.kind === "live-proof-failed")
    .map((entry) => `${surface}/${entry.provider}`));
  return [...focusedFailures, ...providerFailures];
}

export async function waitForNewThread(socket, workspaceId, previousIds, provider, model, run, deadline = Date.now() + 30_000) {
  while (Date.now() < deadline) {
    const threads = await socket.rpc("thread.list", { workspaceId });
    const candidates = Array.isArray(threads) ? threads.filter((thread) => thread?.provider === provider && thread.model === model && !previousIds.has(thread.id)) : [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      run.ownedThreadIds = [...new Set([...(run.ownedThreadIds ?? []), ...candidates.map((thread) => thread.id)])];
      throw new Error("Condition: Composer created more than one matching new thread.");
    }
    await delay(200);
  }
  throw new Error(`Condition: Composer did not create an exact new ${provider} thread.`);
}

async function listThreadIds(socket, workspaceId) { const threads = await socket.rpc("thread.list", { workspaceId }); if (!Array.isArray(threads)) throw new Error("Condition: thread.list returned an unexpected value."); return new Set(threads.map((thread) => thread?.id).filter(Boolean)); }

export async function runProviderJourneys({ surface, client, socket, workspace, run, io, matrix, captureLive, captureReview }) {
  const journeys = {};
  for (const [row, evidence] of Object.entries(matrix).filter(([, entry]) => entry?.kind === "required-live-proof")) {
    try {
      const journey = await runComposerReviewJourney({ surface, client, socket, workspace, run, io, provider: evidence.provider, model: evidence.model, modelName: evidence.modelName ?? evidence.model, captureLive, captureReview });
      journeys[row] = { status: "passed", provider: evidence.provider, model: evidence.model, journey };
      matrix[row] = { ...evidence, kind: "live-proof", journey };
    } catch (error) {
      const message = safeError(error);
      const classification = classifyProviderJourneyFailure(evidence.provider, message);
      journeys[row] = { status: "failed", provider: evidence.provider, model: evidence.model, failure: { message, classification } };
      matrix[row] = { ...evidence, kind: "live-proof-failed", failure: journeys[row].failure };
      await captureFailure(client.page, run, `${surface}-${evidence.provider}-failure`);
    }
  }
  return journeys;
}

export async function runComposerReviewJourney({ surface, client, socket, workspace, run, io, provider, model, modelName, captureLive: captureLiveState, captureReview: captureReviewState }) {
  const fileName = `target-${provider}.txt`;
  const fixtureFile = NodePath.join(run.fixtureDirectory, fileName);
  const result = { provider, model, baseline: "BASELINE_MARKER", observations: {}, comparison: {}, fetchedPatch: null, disk: null };
  await io.writeFile(fixtureFile, "BASELINE_MARKER\n", "utf8");
  run.run.ownedFile ??= fixtureFile;
  run.run.ownedFiles = [...new Set([...(run.run.ownedFiles ?? []), fixtureFile])];
  const beforeThreads = await listThreadIds(socket, workspace.id);
  await driveComposer(client.page, workspace.name, fileName, provider, modelName);
  const thread = await waitForNewThread(socket, workspace.id, beforeThreads, provider, model, run.run);
  run.run.threadId ??= thread.id;
  run.run.ownedThreadIds = [...new Set([...(run.run.ownedThreadIds ?? []), thread.id])];
  run.workspace = { id: workspace.id, name: workspace.name, path: workspace.path, selectionEvidence: { source: "thread.list scoped request", requestedWorkspaceId: workspace.id, threadId: thread.id } };
  if (provider === "codex") {
    run.phase = "agent-live-diff";
    const agentComparison = await waitForLiveAgentDiff(socket, thread.id, fileName, undefined, run.diagnostics.liveComparisons);
    assertPatchAttribution(agentComparison.patch, "AGENT_MARKER", "EXTERNAL_MARKER");
    result.comparison.agentLive = summarizeComparison(agentComparison.comparison, agentComparison.patch);
    result.fetchedPatch = agentComparison.patch;
    result.observations.live = await captureLiveObservation(client.page, run, agentComparison, captureLiveState, `${surface}-${provider}-live`);
    await io.appendFile(fixtureFile, "EXTERNAL_MARKER\n", "utf8");
  }
  const settled = await waitForSettledComparison(socket, thread.id, fileName);
  assertPatchAttribution(settled.patch, "AGENT_MARKER", "EXTERNAL_MARKER");
  result.comparison.settled = summarizeComparison(settled.comparison, settled.patch);
  result.observations.settled = await captureSettledReviewState(socket, thread.id, fileName, client.page, run, `${surface}-${provider}-settled`, captureReviewState);
  if (provider === "codex") {
    await closeReview(client.page);
    result.observations.reopened = await captureSettledReviewState(socket, thread.id, fileName, client.page, run, `${surface}-${provider}-reopened`, captureReviewState);
    await reloadClient(client);
    result.observations.reloaded = await captureSettledReviewState(socket, thread.id, fileName, client.page, run, `${surface}-${provider}-reloaded`, captureReviewState);
  }
  const disk = await io.readFile(fixtureFile, "utf8");
  result.disk = provider === "codex" ? assertDiskContent(disk, "AGENT_MARKER", "EXTERNAL_MARKER") : (disk.includes("AGENT_MARKER") ? "agent marker retained" : (() => { throw new Error("Condition: disk did not retain the agent marker."); })());
  return result;
}

function classifyProviderJourneyFailure(provider, message) {
  return provider === "codex" ? classifyLiveDiffFailure("agent-live-diff", new Error(message)) : "provider journey failed before normalized public Review evidence was complete";
}

export async function waitForLiveAgentDiff(socket, threadId, fileName, deadline = Date.now() + LIVE_TIMEOUT_MS, diagnostics = { states: [], omitted: 0 }) {
  while (Date.now() < deadline) {
    const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
    recordLiveComparisonDiagnostic(diagnostics, comparison);
    const file = comparison?.files?.find((candidate) => fileMatches(candidate, fileName));
    if (comparison?.turnDiff?.phase === "live" && file && comparison.turnDiff.id) {
      const patch = await socket.rpc("turnDiff.getFileDiff", { threadId, comparisonId: comparison.turnDiff.id, filePath: file.path });
      if (typeof patch === "string" && patch.includes("AGENT_MARKER")) return { comparison, file, patch };
    }
    await delay(500);
  }
  throw new Error("Condition: exact file never appeared in a Live agent diff with AGENT_MARKER.");
}

/** Retains a bounded, redacted summary of distinct public comparison states. */
export function recordLiveComparisonDiagnostic(diagnostics, comparison) {
  const state = summarizeLiveComparison(comparison);
  const key = JSON.stringify(state);
  if (diagnostics.states.some((candidate) => JSON.stringify(candidate) === key)) return;
  if (diagnostics.states.length >= MAX_LIVE_COMPARISON_STATES) { diagnostics.omitted += 1; return; }
  diagnostics.states.push(state);
}

function summarizeLiveComparison(comparison) {
  const turnDiff = comparison?.turnDiff;
  if (!comparison || typeof comparison !== "object") return { state: "null", phase: null, source: null, fidelity: null, revision: null, files: [] };
  return {
    state: "comparison",
    phase: typeof turnDiff?.phase === "string" ? turnDiff.phase : null,
    source: typeof turnDiff?.source === "string" ? turnDiff.source : null,
    fidelity: typeof turnDiff?.fidelity === "string" ? turnDiff.fidelity : null,
    revision: Number.isInteger(turnDiff?.revision) ? turnDiff.revision : null,
    files: Array.isArray(comparison.files) ? comparison.files.slice(0, 12).map((file) => typeof file?.path === "string" ? NodePath.basename(file.path) : null).filter(Boolean) : [],
  };
}

export function classifyLiveDiffFailure(phase, error) {
  return phase === "agent-live-diff" && safeError(error) === "Condition: exact file never appeared in a Live agent diff with AGENT_MARKER."
    ? "current Codex provider/product gap: no turn/diff/updated reached the public comparison during the held turn"
    : undefined;
}

/** Captures only correlation IDs and notification kinds from the opt-in server trace. */
export function captureCodexTraceEvidence(repoRoot, mcodeThreadId, dependencies = {}) {
  const readFile = dependencies.readFile ?? NodeFS.readFileSync;
  const execute = dependencies.execute ?? NodeChildProcess.execFileSync;
  let installedVersion = "unavailable";
  try { installedVersion = execute("codex", ["--version"], { encoding: "utf8" }).trim(); } catch (error) { installedVersion = `unavailable: ${safeError(error)}`; }
  const evidence = { installedVersion, traceLog: ".dev/logs/server.log", mcodeThreadId: mcodeThreadId ?? null, methods: [], nativeThreadIds: [], nativeTurnIds: [], fileChangeSeen: false, turnStartedSeen: false, turnCompletedSeen: false, turnDiffUpdatedSeen: false, emitCodexTurnDiff: "not evaluated: trace contained no turn/diff/updated notification" };
  if (!mcodeThreadId) return evidence;
  try {
    const lines = String(readFile(NodePath.join(repoRoot, ".dev", "logs", "server.log"), "utf8")).split(/\r?\n/);
    for (const line of lines) {
      const payload = parseCodexTraceLine(line);
      if (!payload || payload.threadId !== mcodeThreadId) continue;
      const method = typeof payload.method === "string" ? payload.method : undefined;
      if (method && evidence.methods.length < 48 && !evidence.methods.includes(method)) evidence.methods.push(method);
      if (method === "turn/started") evidence.turnStartedSeen = true;
      if (method === "turn/completed") evidence.turnCompletedSeen = true;
      if (method === "turn/diff/updated") evidence.turnDiffUpdatedSeen = true;
      const raw = payload.raw && typeof payload.raw === "object" ? payload.raw : {};
      if (raw.itemType === "fileChange") evidence.fileChangeSeen = true;
      const rawThreadId = typeof raw.threadId === "string" ? raw.threadId : undefined;
      const rawTurnId = typeof raw.turnId === "string" ? raw.turnId : undefined;
      if (rawThreadId && evidence.nativeThreadIds.length < 8 && !evidence.nativeThreadIds.includes(rawThreadId)) evidence.nativeThreadIds.push(rawThreadId);
      if (rawTurnId && evidence.nativeTurnIds.length < 8 && !evidence.nativeTurnIds.includes(rawTurnId)) evidence.nativeTurnIds.push(rawTurnId);
    }
    if (evidence.turnDiffUpdatedSeen) evidence.emitCodexTurnDiff = "notification arrived; inspect native turn and execution routing in the trace and provider logs";
  } catch (error) { evidence.traceReadError = safeError(error); }
  return evidence;
}

function parseCodexTraceLine(line) {
  const start = line.indexOf("Codex trace ingest ");
  if (start < 0) return undefined;
  try { return JSON.parse(line.slice(start + "Codex trace ingest ".length)); } catch { return undefined; }
}

async function waitForSettledComparison(socket, threadId, fileName, deadline = Date.now() + TIMEOUT_MS) {
  while (Date.now() < deadline) {
    const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
    const file = comparison?.files?.find((candidate) => fileMatches(candidate, fileName));
    if (comparison?.turnDiff?.phase === "settled" && file && comparison.turnDiff.id) {
      const patch = await socket.rpc("turnDiff.getFileDiff", { threadId, comparisonId: comparison.turnDiff.id, filePath: file.path });
      if (typeof patch === "string") return { comparison, file, patch };
    }
    await delay(500);
  }
  throw new Error("Condition: exact thread comparison did not settle.");
}

export async function readSettledPublicComparison(socket, threadId, fileName) {
  const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
  const file = comparison?.files?.find((candidate) => fileMatches(candidate, fileName));
  if (comparison?.turnDiff?.phase !== "settled" || !comparison.turnDiff.id || !comparison.turnDiff.source || !comparison.turnDiff.fidelity || !file) throw new Error("Condition: public settled comparison lacked the exact file, source, or fidelity.");
  const patch = await socket.rpc("turnDiff.getFileDiff", { threadId, comparisonId: comparison.turnDiff.id, filePath: file.path });
  assertPatchAttribution(patch, "AGENT_MARKER", "EXTERNAL_MARKER");
  return { comparison, file, patch };
}

export async function captureSettledReviewState(socket, threadId, fileName, page, receipt, name, capture = captureReview) {
  const result = await readSettledPublicComparison(socket, threadId, fileName);
  receipt.comparison[name] = summarizeComparison(result.comparison, result.patch);
  return assertObservation(await capture(page, receipt, name, result), result, "settled");
}

export function assertPatchAttribution(patch, agentMarker, externalMarker) { if (typeof patch !== "string" || !patch.includes(agentMarker) || patch.includes(externalMarker)) throw new Error("Condition: the public agent patch did not exclusively attribute the agent marker."); }
function fileMatches(file, fileName) { return file?.path === fileName || file?.path?.endsWith(`/${fileName}`); }

async function driveComposer(page, workspaceName, fileName, provider, modelName) {
  await openNewThreadForWorkspace(page, workspaceName);
  const chooserDialog = page.getByRole("dialog", { name: "Choose model and provider" });
  if (!await chooserDialog.isVisible().catch(() => false)) await page.getByRole("button", { name: /GPT|Claude|Cursor/i }).last().click();
  await chooserDialog.getByTestId(`model-group-${provider}`).click();
  await chooserDialog.getByRole("textbox", { name: "Filter models by name or id. Use multiple words to narrow results." }).fill(modelName);
  await chooserDialog.getByText(modelName, { exact: true }).click({ timeout: 15_000 });
  const editor = page.getByRole("textbox", { name: "Message Mcode" });
  await editor.fill(composerPrompt(fileName)); await editor.press("Enter");
}

/** Opens a new thread and selects the workspace before interacting with Composer. */
export async function openNewThreadForWorkspace(page, workspaceName) {
  const newThread = page.getByTestId("sidebar-new-thread");
  await newThread.click();
  await page.getByTestId("new-thread-welcome").waitFor({ state: "visible", timeout: 15_000 });
  await selectWorkspaceForNewThread(page, workspaceName);
  await waitForNewThreadWelcome(page, workspaceName);
}

/** Selects the workspace from either empty-thread project picker state. */
export async function selectWorkspaceForNewThread(page, workspaceName) {
  const activeProjectPicker = page.getByTestId("new-thread-active-project-picker");
  const projectPicker = await activeProjectPicker.isVisible().catch(() => false)
    ? activeProjectPicker
    : page.getByTestId("new-thread-project-picker");
  await projectPicker.click();
  await page.getByRole("option", { name: workspaceName, exact: true }).click();
}

/** Waits for the selected workspace's empty-thread heading after creating a new thread. */
export async function waitForNewThreadWelcome(page, workspaceName) {
  await page.getByRole("heading", { name: `What should we build in ${workspaceName}?`, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
}

/** Creates the deterministic write-then-hold prompt used for Live diff capture. */
export function composerPrompt(fileName) {
  return `Edit ${fileName} with the apply_patch tool. Preserve BASELINE_MARKER and add AGENT_MARKER on the next line. Do not edit another file. After apply_patch reports success, run powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30" and do not reply until it completes.`;
}

async function assertWorkspace(page, workspace, socket) {
  const workspaces = await socket.rpc("workspace.list", {});
  if (!Array.isArray(workspaces) || !workspaces.some((candidate) => candidate.id === workspace.id && pathsMatch(candidate.path, workspace.path))) throw new Error("Condition: selected workspace identity is absent from the public workspace state.");
  const chooser = page.getByRole("button", { name: "Choose project" });
  if (await chooser.isVisible().catch(() => false)) {
    await chooser.click();
    await page.getByRole("option", { name: workspace.name, exact: true }).click();
  }
  const visibleProject = page.getByText(workspace.name, { exact: true }).first();
  await visibleProject.waitFor({ state: "visible", timeout: 15_000 });
}

export function assertSeparateClients(web, desktop) { if (!web?.browser || !desktop?.session?.browser || web.browser === desktop.session.browser || web.context === desktop.session.context) throw new Error("Condition: web and Electron must use separate browser clients."); }
async function openWeb(playwright, ports, executablePath) { const browser = await playwright.chromium.launch({ headless: true, executablePath }); const context = await browser.newContext(); await context.addCookies([{ name: ports.seedLogin.cookieName, value: ports.seedLogin.token, url: ports.appUrl }]); const page = await context.newPage(); await page.goto(ports.appUrl, { waitUntil: "domcontentloaded" }); return { browser, context, page }; }
export async function openDesktop(repoRoot, playwright, ports, dependencies = {}) {
  const root = NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts");
  const { startElectron } = dependencies.startElectron ? dependencies : await import(NodeURL.pathToFileURL(NodePath.join(root, "start-electron.mjs")).href);
  const sessionHelper = dependencies.sessionHelper ?? await import(NodeURL.pathToFileURL(NodePath.join(root, "electron-session.mjs")).href);
  const stopElectron = dependencies.stopElectron ?? (await import(NodeURL.pathToFileURL(NodePath.join(root, "stop-electron.mjs")).href)).stopElectron;
  const sessionPath = NodePath.join(repoRoot, ".dev", "electron-live-testing.json");
  const owner = !(dependencies.sessionExists ?? NodeFS.existsSync)(sessionPath);
  await startElectron(repoRoot);
  try {
  const session = await sessionHelper.connectElectronSession({ playwright, repoRoot });
  await session.page.evaluate((token) => localStorage.setItem("mcode-auth-token", token), ports.seedLogin.token);
  const page = await sessionHelper.reloadElectronAppPage(session.context, session.page, ports.appUrl);
  await page.getByText("Connecting to server...").waitFor({ state: "hidden", timeout: 30_000 });
  return { desktop: { page, session, sessionHelper }, owner };
  } catch (error) { if (owner) stopElectron(repoRoot); throw error; }
}
async function reloadClient(client) { if (client.session?.context) client.page = await client.sessionHelper.reloadElectronAppPage(client.session.context, client.page, client.session.appUrl); else await client.page.reload({ waitUntil: "domcontentloaded" }); }
export async function closeReview(page) { const review = page.getByTestId("review-last-turn"); if (await review.isVisible().catch(() => false)) await page.getByRole("button", { name: /Changes/ }).click(); }
export async function captureReview(page, receipt, name, result) { const review = await waitForExactReview(page, result); const rendered = await readRenderedReview(page, result.file.path); const screenshot = NodePath.join(receipt.directory, `${name}.png`); await page.screenshot({ path: screenshot }); receipt.screenshots.push(screenshot); receipt.renderedEvidence.push(screenshot); const spinners = await page.locator('[role="progressbar"], [data-testid*="spinner"]').count(); const rows = await reviewRowCount(review); return { screenshot, rows, spinners, ...rendered }; }
export async function waitForExactReview(page, result, timeout = 15_000) {
  const review = page.getByTestId("review-last-turn");
  if (!await review.isVisible().catch(() => false)) await page.getByRole("button", { name: /Changes/ }).click();
  const file = review.locator(`[data-review-file="${escapeAttributeValue(result.file.path)}"]`);
  const source = review.getByTestId("review-turn-source");
  await Promise.all([file.waitFor({ state: "visible", timeout }), source.waitFor({ state: "visible", timeout })]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [sourceValue, fidelityValue, fileText] = await Promise.all([source.getAttribute("data-review-source"), source.getAttribute("data-review-fidelity"), file.innerText()]);
    if (sourceValue === result.comparison.turnDiff.source && fidelityValue === result.comparison.turnDiff.fidelity && hasAgentOnlyMarker(fileText)) return review;
    await delay(100);
  }
  throw new Error("Condition: exact Review file or source marker did not settle.");
}
export async function reviewRowCount(review) { return review.locator("[data-review-file]").count(); }
async function captureLive(page, receipt, name, result) { await page.getByRole("button", { name: /stop/i }).waitFor({ state: "visible", timeout: 15_000 }); await page.getByText(/last turn/i).first().waitFor({ state: "visible", timeout: 15_000 }); const rendered = await readRenderedReview(page, result.file.path); const screenshot = NodePath.join(receipt.directory, `${name}.png`); await page.screenshot({ path: screenshot }); receipt.screenshots.push(screenshot); receipt.renderedEvidence.push(screenshot); return { screenshot, stopVisible: true, ...rendered }; }
export async function readRenderedReview(page, filePath) {
  const review = page.getByTestId("review-last-turn");
  const file = review.locator(`[data-review-file="${escapeAttributeValue(filePath)}"]`);
  const source = review.getByTestId("review-turn-source");
  const [fileCount, sourceCount] = await Promise.all([file.count(), source.count()]);
  const fileText = fileCount === 1 ? await file.innerText() : "";
  const [sourceLabel, sourceValue, fidelityValue] = sourceCount === 1
    ? await Promise.all([source.innerText(), source.getAttribute("data-review-source"), source.getAttribute("data-review-fidelity")])
    : [null, null, null];
  return { filePath: fileCount === 1 ? filePath : null, fileText: fileCount === 1 ? fileText : null, patch: fileText.includes("AGENT_MARKER") ? "AGENT_MARKER" : null, sourceLabel, source: sourceValue, fidelity: fidelityValue };
}

function escapeAttributeValue(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
async function captureFailure(page, receipt, name) { if (!page) return; const screenshot = NodePath.join(receipt.directory, `${name}.png`); try { await page.screenshot({ path: screenshot }); receipt.screenshots.push(screenshot); receipt.renderedEvidence.push(screenshot); } catch (error) { receipt.cleanup.failures.push(`screenshot ${name}: ${safeError(error)}`); } }

export async function cleanupOwned({ socket, electronSocket = null, web, desktop, electronOwner = false, io, receipt, repoRoot, deleteWorkspace = deleteLiveWorkspace, closeSockets = true, closeClients = true, reconnectElectronSocket }) {
  const failures = [];
  let activeElectronSocket = electronSocket;
  const ownedRuns = () => [{ label: "web", socket, run: receipt.run }, ...(activeElectronSocket ? [{ label: "electron", socket: activeElectronSocket, run: receipt.electron?.run }] : [])].filter(({ run }) => run);
  for (const { label, socket: runSocket, run } of ownedRuns()) {
    const threadIds = [...new Set([run.threadId, ...(run.ownedThreadIds ?? [])].filter((id) => typeof id === "string"))];
    for (const threadId of threadIds) if (runSocket) { try { await removeOwnedThread(runSocket, run.ownedWorkspaceId, threadId); } catch (error) { failures.push(`${label} thread ${threadId}: ${safeError(error)}`); } }
  }
  if (closeClients && web) { try { await withinCleanupLimit(web.browser.close()); } catch (error) { failures.push(`web: ${safeError(error)}`); } }
  for (const { label, socket: runSocket, run } of ownedRuns()) if (label === "electron" && run.ownedWorkspaceId && runSocket) {
    try { await removeOwnedWorkspace(deleteWorkspace, runSocket, run.ownedWorkspaceId); } catch (error) { failures.push(`${label} workspace: ${safeError(error)}`); }
  }
  if (failures.some((failure) => failure.startsWith("electron ")) && reconnectElectronSocket) {
    try {
      activeElectronSocket = await reconnectElectronSocket();
      const electronRun = receipt.electron?.run;
      if (electronRun) {
        const threadIds = [...new Set([electronRun.threadId, ...(electronRun.ownedThreadIds ?? [])].filter((id) => typeof id === "string"))];
        for (const threadId of threadIds) await removeOwnedThread(activeElectronSocket, electronRun.ownedWorkspaceId, threadId);
        if (electronRun.ownedWorkspaceId) await removeOwnedWorkspace(deleteWorkspace, activeElectronSocket, electronRun.ownedWorkspaceId);
      }
      for (let index = failures.length - 1; index >= 0; index -= 1) if (failures[index].startsWith("electron ")) failures.splice(index, 1);
    } catch (error) { failures.push(`electron reconnect cleanup: ${safeError(error)}`); }
  }
  if (closeClients && desktop) {
    try { await withinCleanupLimit(desktop.sessionHelper.disconnectElectronSession(desktop.session)); } catch (error) { failures.push(`electron disconnect: ${safeError(error)}`); }
    if (electronOwner) try { const { stopElectron } = await import(NodeURL.pathToFileURL(NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs")).href); stopElectron(repoRoot); } catch (error) { failures.push(`electron stop: ${safeError(error)}`); }
  }
  for (const { label, socket: runSocket, run } of ownedRuns()) {
    if (label !== "electron" && run.ownedWorkspaceId && runSocket) { try { await removeOwnedWorkspace(deleteWorkspace, runSocket, run.ownedWorkspaceId); } catch (error) { failures.push(`${label} workspace: ${safeError(error)}`); } }
    for (const file of [...new Set([run.ownedFile, ...(run.ownedFiles ?? [])].filter((value) => typeof value === "string"))]) { try { await withinCleanupLimit(io.rm(file, { force: true })); } catch (error) { failures.push(`${label} file: ${safeError(error)}`); } }
    if (run.ownedFixtureDirectory) { try { await withinCleanupLimit(io.rm(run.ownedFixtureDirectory, { recursive: true, force: true })); if (NodeFS.existsSync(run.ownedFixtureDirectory)) failures.push(`${label} fixture directory still exists after deletion`); } catch (error) { failures.push(`${label} fixture directory: ${safeError(error)}`); } }
  }
  if (closeSockets && socket) { try { await withinCleanupLimit(socket.close()); } catch (error) { failures.push(`socket: ${safeError(error)}`); } }
  if (closeSockets && activeElectronSocket) { try { await withinCleanupLimit(activeElectronSocket.close()); } catch (error) { failures.push(`electron socket: ${safeError(error)}`); } }
  return { complete: failures.length === 0, failures };
}

function withinCleanupLimit(operation) {
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("cleanup timed out after 10 seconds")), 10_000); });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timeout));
}

async function removeOwnedWorkspace(deleteWorkspace, socket, ownedWorkspaceId) {
  const before = typeof socket.rpc === "function" ? await withinCleanupLimit(socket.rpc("workspace.list", {})) : null;
  if (Array.isArray(before) && !before.some((workspace) => workspace?.id === ownedWorkspaceId)) return;
  const report = { cleanup: {} };
  await withinCleanupLimit(deleteWorkspace({ ownedWorkspaceId, socket, report }, false));
  if (report.cleanup.workspaceDeleted === true && !report.cleanup.failure) return;
  const after = typeof socket.rpc === "function" ? await withinCleanupLimit(socket.rpc("workspace.list", {})) : null;
  if (Array.isArray(after) && !after.some((workspace) => workspace?.id === ownedWorkspaceId)) return;
  throw new Error(report.cleanup.failure ?? "workspace deletion was not confirmed");
}

async function removeOwnedThread(socket, workspaceId, threadId) {
  const isGone = async () => {
    if (typeof socket.rpc !== "function" || !workspaceId) return false;
    const threads = await withinCleanupLimit(socket.rpc("thread.list", { workspaceId }));
    return Array.isArray(threads) && !threads.some((thread) => thread?.id === threadId);
  };
  if (await isGone()) return;
  if (await withinCleanupLimit(socket.rpc("thread.delete", { threadId, cleanupWorktree: false })) === true) return;
  if (await isGone()) return;
  throw new Error("thread.delete did not confirm removal");
}

export async function writeReceipt(io, receipt) {
  const receiptPath = receipt.path;
  await io.writeFile(receiptPath, `${JSON.stringify(redactReceipt(receipt), null, 2)}\n`, "utf8");
}
function redactReceipt(receipt) {
  return JSON.parse(JSON.stringify(receipt)
    .replaceAll(/[A-Za-z]:\\\\[^"\r\n]*/g, "[path]")
    .replaceAll(/("(?:token|authorization|cookie)"\s*:\s*")[^"]+/gi, "$1[redacted]"));
}
export async function cleanup(repoRoot, dependencies = {}) {
  const root = NodePath.join(repoRoot, EVIDENCE_DIRECTORY);
  if (!NodeFS.existsSync(root)) return { receipts: 0, cleanup: "nothing to clean" };
  const receiptPaths = NodeFS.readdirSync(root, { recursive: true }).filter((file) => file.endsWith("receipt.json")).map((file) => NodePath.join(root, file));
  const pending = receiptPaths.map((path) => ({ path, receipt: JSON.parse(NodeFS.readFileSync(path, "utf8")) }))
    .filter(({ path, receipt }) => isOwnedReceipt(receipt, repoRoot, path) && !receipt.cleanup?.complete)
    .map(({ path, receipt }) => ({ path, receipt: hydrateOwnedReceipt(receipt, repoRoot) }));
  if (pending.length === 0) return { receipts: receiptPaths.length, cleanup: "complete" };
  const needsSocket = pending.some(({ receipt }) => receipt.run.threadId || receipt.run.ownedWorkspaceId || receipt.run.ownedThreadIds?.length);
  const needsElectronSocket = pending.some(({ receipt }) => receipt.electron?.run?.threadId || receipt.electron?.run?.ownedWorkspaceId || receipt.electron?.run?.ownedThreadIds?.length);
  const socket = needsSocket ? dependencies.socket ?? await (dependencies.openSocket ?? openRuntimeVerificationSocket)(repoRoot) : undefined;
  let electronSocket; let desktop; let electronOwner = false;
  if (needsElectronSocket) {
    if (dependencies.electronSocket) electronSocket = dependencies.electronSocket;
    else {
      const ports = readPortsFile(repoRoot);
      const opened = await openDesktop(repoRoot, requirePlaywright(repoRoot), ports, dependencies.electron);
      desktop = opened.desktop;
      electronOwner = opened.owner;
      const serverUrl = await desktop.page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
      electronSocket = await openVerificationSocketUrl(repoRoot, serverUrl);
    }
  }
  const failures = [];
  try {
    for (const { path, receipt } of pending) {
      const result = await cleanupOwned({ socket, electronSocket, desktop, electronOwner, io: NodeFS.promises, receipt, repoRoot, closeSockets: false, closeClients: false, reconnectElectronSocket: desktop ? async () => {
        const serverUrl = await desktop.page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
        return openVerificationSocketUrl(repoRoot, serverUrl);
      } : undefined });
      failures.push(...result.failures.map((failure) => `${NodePath.basename(NodePath.dirname(path))}: ${failure}`));
      receipt.cleanup = result;
      await writeReceipt(NodeFS.promises, receipt);
    }
  } finally {
    if (desktop) {
      await desktop.sessionHelper.disconnectElectronSession(desktop.session);
      if (electronOwner) {
        const { stopElectron } = await import(NodeURL.pathToFileURL(NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs")).href);
        stopElectron(repoRoot);
      }
    }
    if (socket) await socket.close();
    if (electronSocket) await electronSocket.close();
  }
  if (failures.length) throw new Error(`Condition: provider-completeness cleanup failed: ${failures.join("; ")}`);
  return { receipts: receiptPaths.length, cleanup: "complete" };
}

function isOwnedReceipt(receipt, repoRoot, receiptPath) {
  if (typeof receipt?.runId !== "string" || receipt.runId.length === 0 || typeof receipt?.fixtureFile !== "string" || typeof receipt?.fixtureDirectory !== "string" || !receipt.run || typeof receipt.run !== "object") return false;
  const root = NodePath.resolve(repoRoot, EVIDENCE_DIRECTORY);
  const expectedDirectory = NodePath.join(root, receipt.runId);
  const expectedReceipt = NodePath.join(expectedDirectory, "receipt.json");
  const expectedFixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}`);
  const expectedFixture = NodePath.join(expectedFixtureDirectory, "target.txt");
  const electronFixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}-electron`);
  const electronFixture = NodePath.join(electronFixtureDirectory, "target.txt");
  const electron = receipt.electron?.run;
  return isExactOrRedacted(receipt.fixtureFile, expectedFixture)
    && isExactOrRedacted(receipt.fixtureDirectory, expectedFixtureDirectory)
    && (receipt.run.ownedFile == null || isOwnedFixtureFile(receipt.run.ownedFile, expectedFixtureDirectory))
    && (!Array.isArray(receipt.run.ownedFiles) || receipt.run.ownedFiles.every((file) => isOwnedFixtureFile(file, expectedFixtureDirectory)))
    && (receipt.run.ownedFixtureDirectory == null || isExactOrRedacted(receipt.run.ownedFixtureDirectory, expectedFixtureDirectory))
    && isExactOrRedacted(receipt.path, expectedReceipt)
    && isExactOrRedacted(receipt.directory, expectedDirectory)
    && receiptPath === expectedReceipt
    && isWithin(expectedDirectory, root)
    && isWithin(expectedReceipt, root)
    && isWithin(expectedFixture, getRuntimePaths(repoRoot).fixtureRepoDir)
    && (receipt.run.threadId == null || typeof receipt.run.threadId === "string")
    && (!Array.isArray(receipt.run.ownedThreadIds) || receipt.run.ownedThreadIds.every((id) => typeof id === "string"))
    && (receipt.run.ownedWorkspaceId == null || typeof receipt.run.ownedWorkspaceId === "string")
    && (!electron || (typeof electron === "object"
      && (electron.ownedFile == null || isOwnedFixtureFile(electron.ownedFile, electronFixtureDirectory))
      && (!Array.isArray(electron.ownedFiles) || electron.ownedFiles.every((file) => isOwnedFixtureFile(file, electronFixtureDirectory)))
      && (electron.ownedFixtureDirectory == null || isExactOrRedacted(electron.ownedFixtureDirectory, electronFixtureDirectory))
      && (electron.threadId == null || typeof electron.threadId === "string")
      && (!Array.isArray(electron.ownedThreadIds) || electron.ownedThreadIds.every((id) => typeof id === "string"))
      && (electron.ownedWorkspaceId == null || typeof electron.ownedWorkspaceId === "string")));
}

function isExactOrRedacted(value, expected) { return value === expected || value === "[path]"; }
function isOwnedFixtureFile(value, directory) { return value === "[path]" || (typeof value === "string" && isWithin(value, directory) && /^target(?:-(?:codex|cursor|claude))?\.txt$/i.test(NodePath.basename(value))); }

function hydrateOwnedReceipt(receipt, repoRoot) {
  const fixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}`);
  const hydrateRun = (run, directory) => run && {
    ...run,
    ownedFile: run.ownedFile === "[path]" ? NodePath.join(directory, "target.txt") : run.ownedFile,
    ownedFiles: Array.isArray(run.ownedFiles) ? run.ownedFiles.map((file) => file === "[path]" ? NodePath.join(directory, "target.txt") : file) : run.ownedFiles,
    ownedFixtureDirectory: run.ownedFixtureDirectory === "[path]" ? directory : run.ownedFixtureDirectory,
  };
  const electronDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}-electron`);
  return {
    ...receipt,
    path: NodePath.join(repoRoot, EVIDENCE_DIRECTORY, receipt.runId, "receipt.json"),
    directory: NodePath.join(repoRoot, EVIDENCE_DIRECTORY, receipt.runId),
    fixtureDirectory,
    fixtureFile: NodePath.join(fixtureDirectory, "target.txt"),
    run: hydrateRun(receipt.run, fixtureDirectory),
    electron: receipt.electron?.run ? { ...receipt.electron, run: hydrateRun(receipt.electron.run, electronDirectory) } : receipt.electron,
  };
}

function isWithin(path, parent) { const relative = NodePath.relative(parent, path); return relative !== "" && !relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative); }
function providerMatrix() { return {
  codexNative: { kind: "live-proof-required", control: "public web Composer, Review, and public turn comparison", fields: ["provider", "model", "observations.live", "observations.settled", "observations.reopened", "observations.reloaded", "observations.reconnected", "comparison", "disk"] },
  cursorNative: { kind: "pending-observation", control: "providers.listAvailability, provider.listModels, and provider.catalog" },
  claudeFallback: { kind: "pending-observation", control: "providers.listAvailability, provider.listModels, and provider.catalog" },
  empty: focusedGate("server-turn-diff-review"),
  invalidation: focusedGate("server-workspace-invalidation"),
  interruption: focusedGate("server-turn-diff-review"),
  warningsReroutes: focusedGate("codex-protocol"),
  reviewApproved: { kind: "blocked", prerequisite: "native automatic-review approval terminal event", surface: "public Composer, conversation, and Review" },
  reviewDenied: { kind: "blocked", prerequisite: "native automatic-review denial terminal event", surface: "public Composer, conversation, and Review" },
  strictManual: focusedGate("server-approval-review-policy"),
  managedRequired: focusedGate("server-approval-review-policy"),
  fullAccess: focusedGate("web-composer-and-files"),
  permissionHandoff: { kind: "blocked", prerequisite: "native provider PermissionRequest after strict-review routing", surface: "public Composer permission control" },
  staleRetry: focusedGate("server-workspace-invalidation"),
  fileSurfaces: focusedGate("web-composer-and-files"),
  disconnectWatchCleanup: focusedGate("server-workspace-invalidation"),
  electronRightPanel: { kind: "blocked", prerequisite: "a completed Electron Review journey", surface: "Electron", reason: "the proof starts Electron, but the native Codex Live diff did not reach public comparison" },
}; }
function focusedGate(gate) { return { kind: "focused-pending", gate }; }
function requirePlaywright(repoRoot) { const pkg = NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"); if (!NodeFS.existsSync(pkg)) throw new Error("Condition: isolated Playwright is missing. Next action: run ensure-playwright.mjs."); return NodeModule.createRequire(pkg)("playwright"); }
function findChromiumPath() { return ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((path) => NodeFS.existsSync(path)); }
function summarizeComparison(comparison, patch) {
  return {
    comparison: {
      turnDiff: {
        phase: comparison?.turnDiff?.phase ?? null,
        source: comparison?.turnDiff?.source ?? null,
        fidelity: comparison?.turnDiff?.fidelity ?? null,
        revision: Number.isInteger(comparison?.turnDiff?.revision) ? comparison.turnDiff.revision : null,
      },
      files: Array.isArray(comparison?.files) ? comparison.files.map((file) => ({ path: typeof file?.path === "string" ? NodePath.basename(file.path) : null, status: typeof file?.status === "string" ? file.status : null })) : [],
    },
    patch: redactPatch(patch),
  };
}

function redactPatch(patch) {
  return typeof patch === "string"
    ? patch.replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]").replace(/(?:token|authorization|cookie)\s*[:=]\s*\S+/gi, "$&[redacted]")
    : null;
}
export function recordLiveObservation(receipt, rendered, result) { const observation = assertLiveObservation(rendered, result); receipt.renderedEvidence.push({ state: "live", filePath: observation.filePath, patch: observation.renderedPatch, sourceLabel: observation.sourceLabel }); return observation; }
export async function captureLiveObservation(page, receipt, result, capture = captureLive, name = "web-live") { return recordLiveObservation(receipt, await capture(page, receipt, name, result), result); }
export function assertLiveObservation(rendered, result) { const comparison = result?.comparison; if (!rendered?.stopVisible || comparison?.turnDiff?.phase !== "live" || !comparison?.turnDiff?.source || !comparison?.turnDiff?.fidelity || !result?.file?.path || typeof result?.patch !== "string" || rendered.filePath !== result.file.path || !hasAgentOnlyMarker(rendered.fileText) || rendered.patch !== "AGENT_MARKER" || rendered.sourceLabel == null || rendered.source !== comparison.turnDiff.source || rendered.fidelity !== comparison.turnDiff.fidelity) throw new Error("Condition: rendered Live Review evidence was incomplete."); return { ...rendered, comparisonId: comparison.turnDiff.id, phase: "live", source: comparison.turnDiff.source, fidelity: comparison.turnDiff.fidelity, filePath: result.file.path, renderedPatch: rendered.patch, patch: result.patch }; }
export function assertObservation(rendered, result, phase) { const comparison = result?.comparison; if (rendered?.rows !== 1 || rendered?.spinners !== 0 || comparison?.turnDiff?.phase !== phase || !comparison?.turnDiff?.source || !comparison?.turnDiff?.fidelity || !result?.file?.path || typeof result?.patch !== "string" || rendered.filePath !== result.file.path || !hasAgentOnlyMarker(rendered.fileText) || rendered.patch !== "AGENT_MARKER" || rendered.sourceLabel == null || rendered.source !== comparison.turnDiff.source || rendered.fidelity !== comparison.turnDiff.fidelity) throw new Error("Condition: rendered Review or exact comparison evidence was incomplete."); return { ...rendered, comparisonId: comparison.turnDiff.id, phase, source: comparison.turnDiff.source, fidelity: comparison.turnDiff.fidelity, filePath: result.file.path, renderedPatch: rendered.patch, patch: result.patch }; }
function hasAgentOnlyMarker(fileText) { return typeof fileText === "string" && fileText.includes("AGENT_MARKER") && !fileText.includes("EXTERNAL_MARKER"); }
export function assertDiskContent(disk, agentMarker, externalMarker) { if (typeof disk !== "string" || !disk.includes(agentMarker) || !disk.includes(externalMarker)) throw new Error("Condition: disk did not retain both same-file markers."); return "both markers retained"; }
export function resolveUpstreamCodex(repoRoot, execute = NodeChildProcess.execFileSync, bunExecutable = process.execPath, now = () => new Date().toISOString()) { const opensrcHome = NodePath.join(repoRoot, ".opensrc"); const command = "bunx --no-install opensrc path openai/codex"; const resolverArgs = ["x", "--no-install", "opensrc", "path", "openai/codex"]; const resolverOutput = execute(bunExecutable, resolverArgs, { cwd: repoRoot, env: { ...process.env, OPENSRC_HOME: opensrcHome }, encoding: "utf8" }).trim(); const resolvedPath = NodePath.resolve(repoRoot, resolverOutput); const appServer = NodePath.join(resolvedPath, "codex-rs", "app-server"); const protocol = NodePath.join(resolvedPath, "codex-rs", "app-server-protocol"); if (!NodeFS.existsSync(appServer) || !NodeFS.existsSync(protocol)) throw new Error("Condition: OpenSrc Codex cache lacks codex-rs/app-server or app-server-protocol."); const source = readOpenSrcSource(opensrcHome, resolvedPath); const base = { command, resolverOutput, resolvedPath, appServer: true, protocol: true, sourceVersion: source?.version ?? null, sourceFetchedAt: source?.fetchedAt ?? null }; let localFailure = "OpenSrc cache has no repository .git metadata"; if (NodeFS.existsSync(NodePath.join(resolvedPath, ".git"))) { try { const commit = execute("git", ["-C", resolvedPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); if (!commit) throw new Error("git rev-parse HEAD returned no commit"); return { ...base, commit, cacheCommit: commit, commitProvenance: "OpenSrc cache git rev-parse HEAD", commitResolvedAt: now() }; } catch (error) { localFailure = `OpenSrc cache git rev-parse HEAD failed: ${safeError(error)}`; } } try { const remoteOutput = execute("git", ["ls-remote", "https://github.com/openai/codex.git", "refs/heads/main"], { encoding: "utf8" }).trim(); const commit = remoteOutput.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/m)?.[1]; if (!commit) throw new Error("git ls-remote did not return refs/heads/main"); return { ...base, commit, cacheCommit: null, commitProvenance: "git ls-remote https://github.com/openai/codex.git refs/heads/main", commitResolvedAt: now() }; } catch (error) { return { ...base, commit: null, cacheCommit: null, auditBlocker: `${localFailure}; git ls-remote refs/heads/main failed: ${safeError(error)}` }; } }
function readOpenSrcSource(opensrcHome, resolvedPath) { try { return JSON.parse(NodeFS.readFileSync(NodePath.join(opensrcHome, "sources.json"), "utf8")).repos?.find((candidate) => NodePath.resolve(opensrcHome, candidate.path) === resolvedPath); } catch { return null; } }
function resolveApplicationCommit(repoRoot) { try { return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); } catch { return "blocked: git rev-parse HEAD failed"; } }
function pathsMatch(a, b) { return typeof a === "string" && typeof b === "string" && NodePath.resolve(a).toLowerCase() === NodePath.resolve(b).toLowerCase(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) { return error instanceof Error ? error.message.replace(/[A-Za-z]:\\[^\n]+/g, "[path]") : String(error); }
if (import.meta.main) await main();
