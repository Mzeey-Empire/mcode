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
const CONNECTION_LOST_TEXT = "Connection lost. Reconnecting to server...";
const FOCUSED_GATES = [
  { name: "server-turn-diff-review", control: "apps/server focused integration tests", workspace: "apps/server", options: ["--no-file-parallelism", "--testTimeout=30000"], files: ["src/features/agents/turns/__tests__/turn-diff-review.test.ts"], rows: ["empty", "interruption"] },
  { name: "server-approval-review-policy", control: "apps/server focused integration tests", workspace: "apps/server", options: ["--no-file-parallelism"], files: ["src/features/agents/turns/__tests__/approval-review-policy.test.ts"], rows: ["strictManual", "managedRequired"] },
  { name: "server-workspace-invalidation", control: "apps/server focused integration tests", workspace: "apps/server", options: ["--no-file-parallelism"], files: ["src/features/projects/files/__tests__/workspace-invalidation-service.test.ts"], rows: ["invalidation", "staleRetry", "disconnectWatchCleanup"] },
  { name: "codex-protocol", control: "packages/providers focused protocol tests", workspace: "packages/providers", files: ["src/__tests__/codex/codex-notification-validation.test.ts", "src/__tests__/codex/codex-protocol-coverage.test.ts", "src/__tests__/codex/codex-event-mapper.test.ts"], rows: ["warningsReroutes"] },
  { name: "web-composer-and-files", control: "apps/web focused component tests", workspace: "apps/web", files: ["src/features/conversation/composer/controls/__tests__/ComposerAccessControls.test.tsx", "src/features/projects/files/useWorkspaceFileInvalidation.test.tsx", "src/components/diff/__tests__/DiffPanel.files.test.tsx"], rows: ["fullAccess", "fileSurfaces"] },
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
    const evidence = await collectFocusedGateEvidence(repoRoot, gate, runner);
    receipt.focusedGates.push(evidence);
    if (evidence.exitCode !== 0) failures.push(`${gate.name} exited ${evidence.exitCode ?? "without an exit code"}`);
  }
  return failures;
}

async function collectFocusedGateEvidence(repoRoot, gate, runner) {
  const args = ["run", "--cwd", gate.workspace, "test", "--", ...(gate.options ?? []), ...gate.files];
  const result = await runFocusedGateSafely(repoRoot, args, runner);
  return {
    kind: result.exitCode === 0 ? "focused-proof" : "focused-proof-failed",
    name: gate.name,
    control: gate.control,
    command: `bun ${args.join(" ")}`,
    rows: gate.rows,
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    output: redactOutput(result.output),
  };
}

async function runFocusedGateSafely(repoRoot, args, runner) {
  try {
    return await runner({ command: "bun", args, cwd: repoRoot, timeoutMs: FOCUSED_GATE_TIMEOUT_MS });
  } catch (error) {
    return { exitCode: null, output: safeError(error) };
  }
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
  const state = { socket: null, electronSocket: null, web: null, desktop: null, electronOwner: false };
  let failure;
  try {
    const focusedFailures = await prepareProofEnvironment(repoRoot, receipt, dependencies);
    const runs = await openProofClients(repoRoot, receipt, dependencies, state);
    await runProofJourneys(repoRoot, receipt, dependencies, state, runs, io);
    completeProof(receipt, focusedFailures);
  } catch (error) {
    failure = error;
    receipt.failure = { phase: receipt.phase, message: safeError(error), classification: classifyLiveDiffFailure(receipt.phase, error) };
    await captureProofFailure(state, receipt);
  } finally {
    failure = await finalizeProof(repoRoot, receipt, dependencies, state, io, failure);
  }
  if (failure) throw failure;
  return { receipt: receipt.path, journeys: receipt.journeys, matrix: receipt.matrix, electronMatrix: receipt.electron.matrix, cleanup: receipt.cleanup };
}

async function prepareProofEnvironment(repoRoot, receipt, dependencies) {
  receipt.phase = "health";
  receipt.runtime = await (dependencies.health ?? health)(repoRoot);
  receipt.upstreamCodex = (dependencies.resolveUpstreamCodex ?? resolveUpstreamCodex)(repoRoot);
  receipt.phase = "focused-evidence";
  return runFocusedEvidenceGates(repoRoot, receipt, dependencies.runner);
}

async function openProofClients(repoRoot, receipt, dependencies, state) {
  receipt.phase = "clients";
  state.socket = dependencies.socket ?? await openRuntimeVerificationSocket(repoRoot);
  const workspace = await createOwnedFixtureWorkspace(state.socket, repoRoot, receipt);
  receipt.workspace = workspaceIdentity(workspace);
  applyProviderPrerequisites(receipt.matrix, await inspectProviderPrerequisites(state.socket, workspace));
  const ports = readPortsFile(repoRoot);
  const playwright = dependencies.playwright ?? requirePlaywright(repoRoot);
  state.web = dependencies.web ?? await openWeb(playwright, ports, findChromiumPath());
  const desktopResult = await openProofDesktop(repoRoot, playwright, ports, dependencies);
  state.desktop = desktopResult.desktop;
  state.electronOwner = desktopResult.owner;
  assertSeparateClients(state.web, state.desktop);
  await reloadClient(state.web);
  await assertWorkspace(state.web.page, workspace, state.socket);
  return { workspace, ports, playwright };
}

async function openProofDesktop(repoRoot, playwright, ports, dependencies) {
  if (dependencies.desktop) return { desktop: dependencies.desktop, owner: false };
  return openDesktop(repoRoot, playwright, ports, dependencies.electron);
}

async function runProofJourneys(repoRoot, receipt, dependencies, state, runs, io) {
  receipt.phase = "electron-runtime";
  const desktopServerUrl = await getDesktopServerUrl(state.desktop);
  state.electronSocket = dependencies.electronSocket ?? await openVerificationSocketUrl(repoRoot, desktopServerUrl);
  const electronRun = await createSurfaceRunForProof(repoRoot, receipt, state);
  receipt.phase = "provider-journeys";
  receipt.journeys.web = await createProviderJourney("web", state.web, state.socket, runs.workspace, receipt, io, receipt.matrix, dependencies);
  receipt.journeys.electron = await createProviderJourney("electron", state.desktop, state.electronSocket, receipt.electron.workspace, electronRun, io, receipt.electron.matrix, dependencies);
  retainCodexJourneyEvidence(receipt);
}

async function getDesktopServerUrl(desktop) {
  return desktop.page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
}

function workspaceIdentity(workspace) {
  return { id: workspace.id, name: workspace.name, path: workspace.path };
}

async function createSurfaceRunForProof(repoRoot, receipt, state) {
  const electronRun = createSurfaceRun(repoRoot, receipt, "electron");
  const electronWorkspace = await createOwnedFixtureWorkspace(state.electronSocket, repoRoot, electronRun);
  receipt.electron.workspace = workspaceIdentity(electronWorkspace);
  applyProviderPrerequisites(receipt.electron.matrix, await inspectProviderPrerequisites(state.electronSocket, electronWorkspace));
  await reloadClient(state.desktop);
  await assertWorkspace(state.desktop.page, electronWorkspace, state.electronSocket);
  return electronRun;
}

async function createProviderJourney(surface, client, socket, workspace, run, io, matrix, dependencies) {
  return runProviderJourneys({
    surface,
    client,
    socket,
    workspace,
    run,
    io,
    matrix,
    captureLive: dependencies.captureLive ?? captureLive,
    captureReview: dependencies.captureReview ?? captureReview,
    captureEmpty: dependencies.captureEmpty ?? captureEmptyReview,
  });
}

function retainCodexJourneyEvidence(receipt) {
  const codexJourney = receipt.journeys.web.codexNative?.journey;
  retainCodexJourneyStatus(receipt, codexJourney);
  retainCodexJourneyDetails(receipt, codexJourney);
}

function retainCodexJourneyStatus(receipt, codexJourney) {
  receipt.baseline = codexJourney?.baseline ?? "not proven";
  receipt.fetchedPatch = codexJourney?.fetchedPatch ?? "not proven";
  receipt.disk = codexJourney?.disk ?? "not proven";
}

function retainCodexJourneyDetails(receipt, codexJourney) {
  receipt.publicComparison = codexJourney?.comparison?.agentLive ?? "not proven";
  receipt.comparison = codexJourney?.comparison ?? {};
  receipt.observations = codexJourney?.observations ?? {};
}

function completeProof(receipt, focusedFailures) {
  receipt.phase = "aggregate-evidence";
  const failures = aggregateEvidenceFailures(focusedFailures, { web: receipt.matrix, electron: receipt.electron.matrix });
  if (failures.length > 0) throw new Error(`Condition: provider completeness evidence failed: ${failures.join("; ")}.`);
  receipt.phase = "complete";
}

async function captureProofFailure(state, receipt) {
  await captureFailure(state.web?.page, receipt, "web-failure");
  await captureFailure(state.desktop?.page, receipt, "electron-failure");
}

async function finalizeProof(repoRoot, receipt, dependencies, state, io, failure) {
  receipt.diagnostics.codexTrace = (dependencies.captureCodexTraceEvidence ?? captureCodexTraceEvidence)(repoRoot, receipt.run.threadId);
  receipt.phase = "cleanup";
  receipt.cleanup = await cleanupOwned({
    socket: state.socket,
    electronSocket: state.electronSocket,
    web: state.web,
    desktop: state.desktop,
    electronOwner: state.electronOwner,
    io,
    receipt,
    repoRoot,
    reconnectElectronSocket: state.desktop ? () => reconnectProofElectronSocket(repoRoot, state.desktop) : undefined,
  });
  await writeReceipt(io, receipt);
  if (receipt.cleanup.failures.length > 0 && !failure) {
    return new Error(`Condition: cleanup failed: ${receipt.cleanup.failures.join("; ")}. Run provider-completeness cleanup --confirm-cleanup.`);
  }
  return failure;
}

async function reconnectProofElectronSocket(repoRoot, desktop) {
  return openVerificationSocketUrl(repoRoot, await getDesktopServerUrl(desktop));
}

export function createReceipt(repoRoot) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomUUID()}`;
  const directory = NodePath.join(repoRoot, EVIDENCE_DIRECTORY, runId);
  const fixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${runId}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  return { runId, phase: "initializing", path: NodePath.join(directory, "receipt.json"), directory, fixtureDirectory, fixtureFile: NodePath.join(fixtureDirectory, "target.txt"), applicationCommit: "not reached", upstreamCodex: "not reached", provider: "codex", model: MODEL, baseline: "not reached", publicComparison: "not reached", fetchedPatch: "not reached", disk: "not reached", renderedEvidence: [], run: { ownedWorkspaceId: null, ownedFixtureDirectory: null, ownedFile: null, threadId: null, ownedThreadIds: [] }, electron: { matrix: providerMatrix("electron") }, journeys: {}, screenshots: [], observations: {}, comparison: {}, diagnostics: { liveComparisons: { states: [], omitted: 0 } }, focusedGates: focusedGateMatrix(), matrix: providerMatrix("web"), cleanup: { complete: false, failures: [] }, failure: null };
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
  const availability = await fetchProviderAvailability(socket);
  const matrix = {};
  for (const provider of ["codex", "cursor", "claude"]) {
    matrix[providerMatrixKey(provider)] = await inspectProviderPrerequisite(socket, workspace, provider, availability, execute);
  }
  return matrix;
}

async function fetchProviderAvailability(socket) {
  const [result] = await Promise.allSettled([socket.rpc("providers.listAvailability", {})]);
  return {
    values: result.status === "fulfilled" && Array.isArray(result.value) ? result.value : [],
    error: result.status === "rejected" ? safeError(result.reason) : null,
  };
}

async function inspectProviderPrerequisite(socket, workspace, provider, availability, execute) {
  const observed = availability.values.find((candidate) => candidate?.id === provider) ?? null;
  const [models, catalog] = await providerPrerequisiteRequests(socket, workspace, provider);
  const modelList = fulfilledArray(models);
  const catalogValue = fulfilledValue(catalog);
  const account = claudeAccountStatus(provider, observed, execute);
  const observedPrerequisites = createObservedPrerequisites(availability.error, observed, modelList, catalogValue, account, models, catalog);
  return providerEvidence(provider, observed, models, catalog, modelList, account, observedPrerequisites);
}

function providerMatrixKey(provider) {
  return `${provider}${provider === "claude" ? "Fallback" : "Native"}`;
}

function providerPrerequisiteRequests(socket, workspace, provider) {
  return Promise.allSettled([
    socket.rpc("provider.listModels", { providerId: provider }),
    socket.rpc("provider.catalog", { providerId: provider, workspaceId: workspace.id }),
  ]);
}

function fulfilledArray(result) {
  return result.status === "fulfilled" && Array.isArray(result.value) ? result.value : [];
}

function fulfilledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function claudeAccountStatus(provider, observed, execute) {
  return provider === "claude" && observed?.cli?.status === "found" ? inspectClaudeAccountStatus(execute) : null;
}

function createObservedPrerequisites(availabilityError, observed, modelList, catalogValue, account, models, catalog) {
  return {
    availability: summarizeProviderAvailability(observed),
    models: modelList.map((model) => model?.id).filter((id) => typeof id === "string").slice(0, 100),
    catalog: summarizeProviderCatalog(catalogValue),
    account,
    errors: prerequisiteErrors(availabilityError, models, catalog),
  };
}

function summarizeProviderAvailability(observed) {
  if (!observed) return null;
  return {
    enabled: observed.enabled === true,
    hasAdapter: observed.hasAdapter === true,
    comingSoon: observed.comingSoon === true,
    cliStatus: observed.cli?.status ?? null,
  };
}

function summarizeProviderCatalog(catalog) {
  if (!catalog) return null;
  return {
    freshness: catalog.freshness ?? null,
    selectableAgents: Array.isArray(catalog.selectableAgents) ? catalog.selectableAgents.length : 0,
  };
}

function prerequisiteErrors(availabilityError, models, catalog) {
  return [
    availabilityError,
    models.status === "rejected" ? safeError(models.reason) : null,
    catalog.status === "rejected" ? safeError(catalog.reason) : null,
  ].filter(Boolean);
}

function providerEvidence(provider, observed, models, catalog, modelList, account, observedPrerequisites) {
  const selectableModel = selectableProviderModel(provider, modelList);
  const unavailableClaudeAccount = account?.status === "not-authenticated";
  if (providerReady(observed, models, catalog, selectableModel, unavailableClaudeAccount)) {
    return {
      kind: "required-live-proof",
      provider,
      model: selectableModel.id,
      modelName: typeof selectableModel.name === "string" ? selectableModel.name : selectableModel.id,
      observedPrerequisites,
    };
  }
  return { kind: "coverage-gap", provider, observedPrerequisites, coverageGap: coverageGapMessage(unavailableClaudeAccount) };
}

function selectableProviderModel(provider, modelList) {
  return provider === "codex" ? modelList.find((model) => model?.id === MODEL) : modelList[0];
}

function providerReady(observed, models, catalog, model, unavailableClaudeAccount) {
  return providerAvailable(observed)
    && models.status === "fulfilled"
    && catalog.status === "fulfilled"
    && Boolean(model?.id)
    && !unavailableClaudeAccount;
}

function providerAvailable(observed) {
  return observed?.enabled === true
    && observed?.hasAdapter === true
    && observed?.comingSoon !== true
    && observed?.cli?.status === "found";
}

function coverageGapMessage(unavailableClaudeAccount) {
  return unavailableClaudeAccount
    ? "Claude CLI reported no authenticated account for the public Composer journey."
    : "missing provider, account, model, or catalog prerequisite for the required public Composer and Review journey";
}

/** Identifies a missing Claude CLI account without retaining command output. */
export function inspectClaudeAccountStatus(execute = NodeChildProcess.execFileSync) {
  const output = readClaudeAccountStatus(execute);
  try {
    const status = JSON.parse(output);
    if (status?.loggedIn === false) return { status: "not-authenticated", loggedIn: false };
    if (status?.loggedIn === true) return { status: "authenticated", loggedIn: true };
  } catch { /* A non-JSON CLI response cannot establish account state. */ }
  return { status: "unknown", loggedIn: null };
}

function readClaudeAccountStatus(execute) {
  try {
    return String(execute("claude", ["auth", "status"], { encoding: "utf8", timeout: 10_000, windowsHide: true }) ?? "");
  } catch (error) {
    return error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
  }
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
    .filter((entry) => entry?.kind === "required-live-proof" || entry?.kind === "live-proof-failed" || entry?.kind === "empty-proof-failed")
    .map((entry) => entry.kind === "empty-proof-failed" ? `${surface}/empty` : `${surface}/${entry.provider}`));
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

export async function runProviderJourneys({ surface, client, socket, workspace, run, io, matrix, captureLive, captureReview, captureEmpty }) {
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
  const codex = matrix.codexNative;
  if (codex?.provider === "codex" && codex.model && codex.modelName) {
    try {
      const journey = await runEmptyDiffJourney({ surface, client, socket, workspace, run, provider: codex.provider, model: codex.model, modelName: codex.modelName, captureEmpty });
      journeys.empty = { status: "passed", provider: codex.provider, model: codex.model, journey };
      matrix.empty = { kind: "empty-proof", control: `${surface} Composer, public turn comparison, and Review`, provider: codex.provider, model: codex.model, journey };
    } catch (error) {
      const message = safeError(error);
      journeys.empty = { status: "failed", provider: codex.provider, model: codex.model, failure: { message, classification: "empty public Composer journey failed before completed no-change evidence" } };
      matrix.empty = { kind: "empty-proof-failed", control: `${surface} Composer, public turn comparison, and Review`, provider: codex.provider, model: codex.model, failure: journeys.empty.failure };
      await captureFailure(client.page, run, `${surface}-empty-failure`);
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
  await driveComposer(client.page, workspace.name, provider, modelName, composerPrompt(fileName));
  const thread = await waitForNewThread(socket, workspace.id, beforeThreads, provider, model, run.run);
  run.run.threadId ??= thread.id;
  run.run.ownedThreadIds = [...new Set([...(run.run.ownedThreadIds ?? []), thread.id])];
  run.workspace = { id: workspace.id, name: workspace.name, path: workspace.path, selectionEvidence: { source: "thread.list scoped request", requestedWorkspaceId: workspace.id, threadId: thread.id } };
  if (provider === "codex") {
    run.phase = "agent-live-diff";
    const initialAgentComparison = await waitForLiveAgentDiff(socket, thread.id, fileName, undefined, run.diagnostics.liveComparisons);
    assertPatchAttribution(initialAgentComparison.patch, "AGENT_MARKER", "EXTERNAL_MARKER");
    await io.appendFile(fixtureFile, "EXTERNAL_MARKER\n", "utf8");
    const agentComparison = await waitForLiveAgentDiff(socket, thread.id, fileName, undefined, run.diagnostics.liveComparisons);
    assertPatchAttribution(agentComparison.patch, "AGENT_MARKER", "EXTERNAL_MARKER");
    result.comparison.agentLive = summarizeComparison(agentComparison.comparison, agentComparison.patch);
    result.fetchedPatch = agentComparison.patch;
    result.observations.live = await captureLiveObservation(client.page, run, agentComparison, captureLiveState, `${surface}-${provider}-live`);
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
    await reconnectOwningClient(client);
    result.observations.reconnected = await captureSettledReviewState(socket, thread.id, fileName, client.page, run, `${surface}-${provider}-reconnected`, captureReviewState);
  }
  const disk = await io.readFile(fixtureFile, "utf8");
  result.disk = provider === "codex" ? assertDiskContent(disk, "AGENT_MARKER", "EXTERNAL_MARKER") : (disk.includes("AGENT_MARKER") ? "agent marker retained" : (() => { throw new Error("Condition: disk did not retain the agent marker."); })());
  return result;
}

/** Drives a completed Composer turn that must have no public file effects. */
export async function runEmptyDiffJourney({ surface, client, socket, workspace, run, provider, model, modelName, captureEmpty: captureEmptyState = captureEmptyReview }) {
  const result = { provider, model, observations: {}, comparison: null };
  const beforeThreads = await listThreadIds(socket, workspace.id);
  await driveComposer(client.page, workspace.name, provider, modelName, emptyComposerPrompt());
  const thread = await waitForNewThread(socket, workspace.id, beforeThreads, provider, model, run.run);
  run.run.threadId ??= thread.id;
  run.run.ownedThreadIds = [...new Set([...(run.run.ownedThreadIds ?? []), thread.id])];
  run.phase = "empty-diff";
  const comparison = await waitForEmptySettledComparison(socket, thread.id);
  result.comparison = summarizeComparison(comparison, null);
  run.comparison[`${surface}-empty`] = result.comparison;
  result.observations.completed = await captureEmptyState(client.page, run, `${surface}-empty`, comparison);
  return result;
}

function classifyProviderJourneyFailure(provider, message) {
  return provider === "codex" ? classifyLiveDiffFailure("agent-live-diff", new Error(message)) : "provider journey failed before normalized public Review evidence was complete";
}

export async function waitForLiveAgentDiff(socket, threadId, fileName, deadline = Date.now() + LIVE_TIMEOUT_MS, diagnostics = { states: [], omitted: 0 }) {
  while (Date.now() < deadline) {
    const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
    recordLiveComparisonDiagnostic(diagnostics, comparison);
    const result = await readLiveAgentDiff(socket, threadId, fileName, comparison);
    if (result) return result;
    await delay(500);
  }
  throw new Error("Condition: exact file never appeared in a Live agent diff with AGENT_MARKER.");
}

async function readLiveAgentDiff(socket, threadId, fileName, comparison) {
  const file = comparison?.files?.find((candidate) => fileMatches(candidate, fileName));
  const turnDiff = comparison?.turnDiff;
  if (turnDiff?.phase !== "live" || !file || !turnDiff.id) return null;
  const patch = await socket.rpc("turnDiff.getFileDiff", { threadId, comparisonId: turnDiff.id, filePath: file.path });
  return typeof patch === "string" && patch.includes("AGENT_MARKER") ? { comparison, file, patch } : null;
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
  if (!comparison || typeof comparison !== "object") return emptyLiveComparison();
  const turnDiff = comparison.turnDiff;
  return {
    state: "comparison",
    ...summarizeLiveTurnDiff(turnDiff),
    files: summarizeLiveFiles(comparison.files),
  };
}

function emptyLiveComparison() {
  return { state: "null", phase: null, source: null, fidelity: null, revision: null, files: [] };
}

function summarizeLiveTurnDiff(turnDiff) {
  return {
    phase: typeof turnDiff?.phase === "string" ? turnDiff.phase : null,
    source: typeof turnDiff?.source === "string" ? turnDiff.source : null,
    fidelity: typeof turnDiff?.fidelity === "string" ? turnDiff.fidelity : null,
    revision: Number.isInteger(turnDiff?.revision) ? turnDiff.revision : null,
  };
}

function summarizeLiveFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 12)
    .map((file) => typeof file?.path === "string" ? NodePath.basename(file.path) : null)
    .filter(Boolean);
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
  const evidence = createCodexTraceEvidence(mcodeThreadId, execute);
  if (!mcodeThreadId) return evidence;
  try {
    const lines = String(readFile(NodePath.join(repoRoot, ".dev", "logs", "server.log"), "utf8")).split(/\r?\n/);
    captureTraceLines(lines, mcodeThreadId, evidence);
  } catch (error) { evidence.traceReadError = safeError(error); }
  updateCodexTraceSummary(evidence);
  return evidence;
}

function createCodexTraceEvidence(mcodeThreadId, execute) {
  return {
    installedVersion: installedCodexVersion(execute),
    traceLog: ".dev/logs/server.log",
    mcodeThreadId: mcodeThreadId ?? null,
    methods: [],
    nativeThreadIds: [],
    nativeTurnIds: [],
    fileChangeSeen: false,
    turnStartedSeen: false,
    turnCompletedSeen: false,
    turnDiffUpdatedSeen: false,
    emitCodexTurnDiff: "not evaluated: trace contained no turn/diff/updated notification",
  };
}

function installedCodexVersion(execute) {
  try {
    return execute("codex", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable: ${safeError(error)}`;
  }
}

function captureTraceLines(lines, mcodeThreadId, evidence) {
  for (const line of lines) {
    const payload = parseCodexTraceLine(line);
    if (payload?.threadId === mcodeThreadId) recordCodexTracePayload(evidence, payload);
  }
}

function recordCodexTracePayload(evidence, payload) {
  const method = typeof payload.method === "string" ? payload.method : undefined;
  recordTraceMethod(evidence, method);
  recordTraceStatus(evidence, method);
  const raw = payload.raw && typeof payload.raw === "object" ? payload.raw : {};
  if (raw.itemType === "fileChange") evidence.fileChangeSeen = true;
  recordTraceId(evidence.nativeThreadIds, raw.threadId);
  recordTraceId(evidence.nativeTurnIds, raw.turnId);
}

function recordTraceMethod(evidence, method) {
  if (method && evidence.methods.length < 48 && !evidence.methods.includes(method)) evidence.methods.push(method);
}

function recordTraceStatus(evidence, method) {
  if (method === "turn/started") evidence.turnStartedSeen = true;
  if (method === "turn/completed") evidence.turnCompletedSeen = true;
  if (method === "turn/diff/updated") evidence.turnDiffUpdatedSeen = true;
}

function recordTraceId(ids, value) {
  if (typeof value === "string" && ids.length < 8 && !ids.includes(value)) ids.push(value);
}

function updateCodexTraceSummary(evidence) {
  if (evidence.turnDiffUpdatedSeen) {
    evidence.emitCodexTurnDiff = "notification arrived; inspect native turn and execution routing in the trace and provider logs";
  }
}

function parseCodexTraceLine(line) {
  const start = line.indexOf("Codex trace ingest ");
  if (start < 0) return undefined;
  try { return JSON.parse(line.slice(start + "Codex trace ingest ".length)); } catch { return undefined; }
}

async function waitForSettledComparison(socket, threadId, fileName, deadline = Date.now() + TIMEOUT_MS) {
  while (Date.now() < deadline) {
    const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
    const result = await readSettledComparison(socket, threadId, fileName, comparison);
    if (result) return result;
    await delay(500);
  }
  throw new Error("Condition: exact thread comparison did not settle.");
}

export async function waitForEmptySettledComparison(socket, threadId, deadline = Date.now() + TIMEOUT_MS) {
  while (Date.now() < deadline) {
    const comparison = await socket.rpc("turnDiff.getComparison", { threadId, includeLive: true });
    if (comparison?.turnDiff?.phase === "settled" && comparison.turnDiff.id && Array.isArray(comparison.files) && comparison.files.length === 0) return comparison;
    await delay(500);
  }
  throw new Error("Condition: completed public comparison did not report an empty file list.");
}

async function readSettledComparison(socket, threadId, fileName, comparison) {
  const file = comparison?.files?.find((candidate) => fileMatches(candidate, fileName));
  const turnDiff = comparison?.turnDiff;
  if (turnDiff?.phase !== "settled" || !file || !turnDiff.id) return null;
  const patch = await socket.rpc("turnDiff.getFileDiff", { threadId, comparisonId: turnDiff.id, filePath: file.path });
  return typeof patch === "string" ? { comparison, file, patch } : null;
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

async function driveComposer(page, workspaceName, provider, modelName, message) {
  await openNewThreadForWorkspace(page, workspaceName);
  const chooserDialog = page.getByRole("dialog", { name: "Choose model and provider" });
  if (!await chooserDialog.isVisible().catch(() => false)) await page.getByRole("button", { name: /GPT|Claude|Cursor/i }).last().click();
  await chooserDialog.getByTestId(`model-group-${provider}`).click();
  await chooserDialog.getByRole("textbox", { name: "Filter models by name or id. Use multiple words to narrow results." }).fill(modelName);
  await chooserDialog.getByText(modelName, { exact: true }).click({ timeout: 15_000 });
  const editor = page.getByRole("textbox", { name: "Message Mcode" });
  await editor.fill(message); await editor.press("Enter");
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

/** Creates a deterministic completed turn that must not create a file effect. */
export function emptyComposerPrompt() {
  return "Reply with exactly EMPTY_DIFF_MARKER. Do not use tools or modify files.";
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
async function reconnectOwningClient(client) {
  const connectionLost = client.page.getByText(CONNECTION_LOST_TEXT, { exact: true });
  const context = client.page.context();
  await context.setOffline(true);
  try {
    await connectionLost.waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await context.setOffline(false);
  }
  await connectionLost.waitFor({ state: "hidden", timeout: 30_000 });
}
export async function closeReview(page) { const review = page.getByTestId("review-last-turn"); if (await review.isVisible().catch(() => false)) await page.getByRole("button", { name: /Changes/ }).click(); }
export async function captureReview(page, receipt, name, result) { const review = await waitForExactReview(page, result); const rendered = await readRenderedReview(page, result.file.path); const screenshot = NodePath.join(receipt.directory, `${name}.png`); await page.screenshot({ path: screenshot }); receipt.screenshots.push(screenshot); receipt.renderedEvidence.push(screenshot); const spinners = await page.locator('[role="progressbar"], [data-testid*="spinner"]').count(); const rows = await reviewRowCount(review); return { screenshot, rows, spinners, ...rendered }; }
export async function captureEmptyReview(page, receipt, name, comparison) {
  const review = page.getByTestId("review-last-turn");
  if (!await review.isVisible().catch(() => false)) await page.getByRole("button", { name: /Changes/ }).click();
  await page.getByText("No changes yet", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  const reviewVisible = await review.isVisible().catch(() => false);
  const rows = reviewVisible ? await reviewRowCount(review) : 0;
  if (reviewVisible || rows !== 0) throw new Error("Condition: completed empty comparison rendered a Review file.");
  const screenshot = NodePath.join(receipt.directory, `${name}.png`);
  await page.screenshot({ path: screenshot });
  receipt.screenshots.push(screenshot);
  receipt.renderedEvidence.push(screenshot);
  return { screenshot, noChanges: true, reviewVisible, rows, comparisonId: comparison.turnDiff.id };
}
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
  await cleanupOwnedThreads(ownedRuns(socket, activeElectronSocket, receipt), failures);
  await closeOwnedWebClient(web, closeClients, failures);
  await cleanupElectronWorkspaces(ownedRuns(socket, activeElectronSocket, receipt), deleteWorkspace, failures);
  activeElectronSocket = await retryElectronCleanup(activeElectronSocket, receipt, deleteWorkspace, reconnectElectronSocket, failures);
  await closeOwnedDesktopClient(desktop, electronOwner, closeClients, repoRoot, failures);
  await cleanupOwnedArtifacts(ownedRuns(socket, activeElectronSocket, receipt), deleteWorkspace, io, failures);
  await closeOwnedSockets(socket, activeElectronSocket, closeSockets, failures);
  return { complete: failures.length === 0, failures };
}

function ownedRuns(socket, electronSocket, receipt) {
  const runs = [{ label: "web", socket, run: receipt.run }];
  if (electronSocket) runs.push({ label: "electron", socket: electronSocket, run: receipt.electron?.run });
  return runs.filter(({ run }) => run);
}

async function cleanupOwnedThreads(runs, failures) {
  for (const run of runs) await cleanupRunThreads(run, failures);
}

async function cleanupRunThreads({ label, socket, run }, failures) {
  if (!socket) return;
  for (const threadId of ownedThreadIds(run)) {
    try {
      await removeOwnedThread(socket, run.ownedWorkspaceId, threadId);
    } catch (error) {
      failures.push(`${label} thread ${threadId}: ${safeError(error)}`);
    }
  }
}

function ownedThreadIds(run) {
  return new Set([run.threadId, ...(run.ownedThreadIds ?? [])].filter((id) => typeof id === "string"));
}

async function closeOwnedWebClient(web, closeClients, failures) {
  if (!closeClients || !web) return;
  try {
    await withinCleanupLimit(web.browser.close());
  } catch (error) {
    failures.push(`web: ${safeError(error)}`);
  }
}

async function cleanupElectronWorkspaces(runs, deleteWorkspace, failures) {
  for (const run of runs) {
    if (run.label === "electron") await cleanupRunWorkspace(run, deleteWorkspace, failures);
  }
}

async function retryElectronCleanup(activeElectronSocket, receipt, deleteWorkspace, reconnectElectronSocket, failures) {
  if (!hasElectronCleanupFailure(failures) || !reconnectElectronSocket) return activeElectronSocket;
  try {
    const reconnected = await reconnectElectronSocket();
    const electronRun = receipt.electron?.run;
    if (electronRun) await removeElectronResources(reconnected, electronRun, deleteWorkspace);
    removeElectronFailures(failures);
    return reconnected;
  } catch (error) {
    failures.push(`electron reconnect cleanup: ${safeError(error)}`);
    return activeElectronSocket;
  }
}

function hasElectronCleanupFailure(failures) {
  return failures.some((failure) => failure.startsWith("electron "));
}

async function removeElectronResources(socket, run, deleteWorkspace) {
  for (const threadId of ownedThreadIds(run)) await removeOwnedThread(socket, run.ownedWorkspaceId, threadId);
  if (run.ownedWorkspaceId) await removeOwnedWorkspace(deleteWorkspace, socket, run.ownedWorkspaceId);
}

function removeElectronFailures(failures) {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    if (failures[index].startsWith("electron ")) failures.splice(index, 1);
  }
}

async function closeOwnedDesktopClient(desktop, electronOwner, closeClients, repoRoot, failures) {
  if (!closeClients || !desktop) return;
  await disconnectOwnedDesktop(desktop, failures);
  if (electronOwner) await stopOwnedElectron(repoRoot, failures);
}

async function disconnectOwnedDesktop(desktop, failures) {
  try {
    await withinCleanupLimit(desktop.sessionHelper.disconnectElectronSession(desktop.session));
  } catch (error) {
    failures.push(`electron disconnect: ${safeError(error)}`);
  }
}

async function stopOwnedElectron(repoRoot, failures) {
  try {
    const path = NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs");
    const { stopElectron } = await import(NodeURL.pathToFileURL(path).href);
    stopElectron(repoRoot);
  } catch (error) {
    failures.push(`electron stop: ${safeError(error)}`);
  }
}

async function cleanupOwnedArtifacts(runs, deleteWorkspace, io, failures) {
  for (const run of runs) await cleanupRunArtifacts(run, deleteWorkspace, io, failures);
}

async function cleanupRunArtifacts({ label, socket, run }, deleteWorkspace, io, failures) {
  if (label !== "electron") await cleanupRunWorkspace({ label, socket, run }, deleteWorkspace, failures);
  await deleteOwnedFiles(label, run, io, failures);
  await deleteOwnedFixtureDirectory(label, run, io, failures);
}

async function cleanupRunWorkspace({ label, socket, run }, deleteWorkspace, failures) {
  if (!run.ownedWorkspaceId || !socket) return;
  try {
    await removeOwnedWorkspace(deleteWorkspace, socket, run.ownedWorkspaceId);
  } catch (error) {
    failures.push(`${label} workspace: ${safeError(error)}`);
  }
}

async function deleteOwnedFiles(label, run, io, failures) {
  for (const file of ownedFiles(run)) {
    try {
      await withinCleanupLimit(io.rm(file, { force: true }));
    } catch (error) {
      failures.push(`${label} file: ${safeError(error)}`);
    }
  }
}

function ownedFiles(run) {
  return new Set([run.ownedFile, ...(run.ownedFiles ?? [])].filter((value) => typeof value === "string"));
}

async function deleteOwnedFixtureDirectory(label, run, io, failures) {
  if (!run.ownedFixtureDirectory) return;
  try {
    await withinCleanupLimit(io.rm(run.ownedFixtureDirectory, { recursive: true, force: true }));
    if (NodeFS.existsSync(run.ownedFixtureDirectory)) failures.push(`${label} fixture directory still exists after deletion`);
  } catch (error) {
    failures.push(`${label} fixture directory: ${safeError(error)}`);
  }
}

async function closeOwnedSockets(socket, electronSocket, closeSockets, failures) {
  if (!closeSockets) return;
  await closeOwnedSocket("socket", socket, failures);
  await closeOwnedSocket("electron socket", electronSocket, failures);
}

async function closeOwnedSocket(label, socket, failures) {
  if (!socket) return;
  try {
    await withinCleanupLimit(socket.close());
  } catch (error) {
    failures.push(`${label}: ${safeError(error)}`);
  }
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
  const receipts = collectPendingReceipts(repoRoot);
  if (!receipts.rootExists) return { receipts: 0, cleanup: "nothing to clean" };
  const { receiptPaths, pending } = receipts;
  if (pending.length === 0) return { receipts: receiptPaths.length, cleanup: "complete" };
  const connections = await openCleanupConnections(repoRoot, pending, dependencies);
  const failures = [];
  try {
    await cleanPendingReceipts(repoRoot, pending, connections, failures);
  } finally {
    await closeCleanupConnections(repoRoot, connections);
  }
  if (failures.length) throw new Error(`Condition: provider-completeness cleanup failed: ${failures.join("; ")}`);
  return { receipts: receiptPaths.length, cleanup: "complete" };
}

function collectPendingReceipts(repoRoot) {
  const root = NodePath.join(repoRoot, EVIDENCE_DIRECTORY);
  if (!NodeFS.existsSync(root)) return { rootExists: false, receiptPaths: [], pending: [] };
  const receiptPaths = NodeFS.readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith("receipt.json"))
    .map((file) => NodePath.join(root, file));
  return { rootExists: true, receiptPaths, pending: receiptPaths.map((path) => readPendingReceipt(path, repoRoot)).filter(Boolean) };
}

function readPendingReceipt(path, repoRoot) {
  const receipt = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (!isOwnedReceipt(receipt, repoRoot, path) || receipt.cleanup?.complete) return null;
  return { path, receipt: hydrateOwnedReceipt(receipt, repoRoot) };
}

async function openCleanupConnections(repoRoot, pending, dependencies) {
  const socket = await openCleanupSocket(repoRoot, pending, dependencies);
  const electron = await openCleanupElectronSocket(repoRoot, pending, dependencies);
  return { socket, ...electron };
}

async function openCleanupSocket(repoRoot, pending, dependencies) {
  if (!pending.some(({ receipt }) => runNeedsSocket(receipt.run))) return undefined;
  return dependencies.socket ?? (dependencies.openSocket ?? openRuntimeVerificationSocket)(repoRoot);
}

function runNeedsSocket(run) {
  if (!run) return false;
  return Boolean(run.threadId || run.ownedWorkspaceId || run.ownedThreadIds?.length);
}

async function openCleanupElectronSocket(repoRoot, pending, dependencies) {
  if (!pending.some(({ receipt }) => runNeedsSocket(receipt.electron?.run))) {
    return { electronSocket: undefined, desktop: undefined, electronOwner: false };
  }
  if (dependencies.electronSocket) return { electronSocket: dependencies.electronSocket, desktop: undefined, electronOwner: false };
  const opened = await openDesktop(repoRoot, requirePlaywright(repoRoot), readPortsFile(repoRoot), dependencies.electron);
  const electronSocket = await openVerificationSocketUrl(repoRoot, await getDesktopServerUrl(opened.desktop));
  return { electronSocket, desktop: opened.desktop, electronOwner: opened.owner };
}

async function cleanPendingReceipts(repoRoot, pending, connections, failures) {
  for (const pendingReceipt of pending) await cleanPendingReceipt(repoRoot, pendingReceipt, connections, failures);
}

async function cleanPendingReceipt(repoRoot, { path, receipt }, connections, failures) {
  const result = await cleanupOwned({
    socket: connections.socket,
    electronSocket: connections.electronSocket,
    desktop: connections.desktop,
    electronOwner: connections.electronOwner,
    io: NodeFS.promises,
    receipt,
    repoRoot,
    closeSockets: false,
    closeClients: false,
    reconnectElectronSocket: connections.desktop ? () => reconnectProofElectronSocket(repoRoot, connections.desktop) : undefined,
  });
  failures.push(...result.failures.map((failure) => `${NodePath.basename(NodePath.dirname(path))}: ${failure}`));
  receipt.cleanup = result;
  await writeReceipt(NodeFS.promises, receipt);
}

async function closeCleanupConnections(repoRoot, connections) {
  if (connections.desktop) {
    await connections.desktop.sessionHelper.disconnectElectronSession(connections.desktop.session);
    if (connections.electronOwner) await stopCleanupElectron(repoRoot);
  }
  if (connections.socket) await connections.socket.close();
  if (connections.electronSocket) await connections.electronSocket.close();
}

async function stopCleanupElectron(repoRoot) {
  const path = NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs");
  const { stopElectron } = await import(NodeURL.pathToFileURL(path).href);
  stopElectron(repoRoot);
}

function isOwnedReceipt(receipt, repoRoot, receiptPath) {
  if (!hasOwnedReceiptShape(receipt)) return false;
  const root = NodePath.resolve(repoRoot, EVIDENCE_DIRECTORY);
  const expectedDirectory = NodePath.join(root, receipt.runId);
  const expectedReceipt = NodePath.join(expectedDirectory, "receipt.json");
  const expectedFixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}`);
  const expectedFixture = NodePath.join(expectedFixtureDirectory, "target.txt");
  const electronFixtureDirectory = NodePath.join(getRuntimePaths(repoRoot).fixtureRepoDir, `provider-completeness-${receipt.runId}-electron`);
  return receiptPathsAreOwned(receipt, expectedDirectory, expectedReceipt, expectedFixtureDirectory, expectedFixture, root, repoRoot, receiptPath)
    && runOwnershipIsSafe(receipt.run, expectedFixtureDirectory)
    && electronOwnershipIsSafe(receipt.electron?.run, electronFixtureDirectory);
}

function hasOwnedReceiptShape(receipt) {
  return typeof receipt?.runId === "string"
    && receipt.runId.length > 0
    && typeof receipt.fixtureFile === "string"
    && typeof receipt.fixtureDirectory === "string"
    && Boolean(receipt.run)
    && typeof receipt.run === "object";
}

function receiptPathsAreOwned(receipt, expectedDirectory, expectedReceipt, expectedFixtureDirectory, expectedFixture, root, repoRoot, receiptPath) {
  return isExactOrRedacted(receipt.fixtureFile, expectedFixture)
    && isExactOrRedacted(receipt.fixtureDirectory, expectedFixtureDirectory)
    && isExactOrRedacted(receipt.path, expectedReceipt)
    && isExactOrRedacted(receipt.directory, expectedDirectory)
    && receiptPath === expectedReceipt
    && isWithin(expectedDirectory, root)
    && isWithin(expectedReceipt, root)
    && isWithin(expectedFixture, getRuntimePaths(repoRoot).fixtureRepoDir);
}

function runOwnershipIsSafe(run, fixtureDirectory) {
  return ownedFileIsSafe(run.ownedFile, fixtureDirectory)
    && ownedFilesAreSafe(run.ownedFiles, fixtureDirectory)
    && ownedFixtureDirectoryIsSafe(run.ownedFixtureDirectory, fixtureDirectory)
    && optionalString(run.threadId)
    && optionalStrings(run.ownedThreadIds)
    && optionalString(run.ownedWorkspaceId);
}

function electronOwnershipIsSafe(electron, fixtureDirectory) {
  if (!electron) return true;
  return typeof electron === "object" && runOwnershipIsSafe(electron, fixtureDirectory);
}

function ownedFileIsSafe(value, fixtureDirectory) {
  return value == null || isOwnedFixtureFile(value, fixtureDirectory);
}

function ownedFilesAreSafe(values, fixtureDirectory) {
  return !Array.isArray(values) || values.every((file) => isOwnedFixtureFile(file, fixtureDirectory));
}

function ownedFixtureDirectoryIsSafe(value, fixtureDirectory) {
  return value == null || isExactOrRedacted(value, fixtureDirectory);
}

function optionalString(value) {
  return value == null || typeof value === "string";
}

function optionalStrings(values) {
  return !Array.isArray(values) || values.every((value) => typeof value === "string");
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
/** Applies provider prerequisite evidence without replacing surface-specific coverage. */
export function applyProviderPrerequisites(matrix, prerequisites) { Object.assign(matrix, prerequisites); }

function providerMatrix(surface) { return {
  codexNative: { kind: "live-proof-required", control: `${surface} Composer, Review, and public turn comparison`, fields: ["provider", "model", "observations.live", "observations.settled", "observations.reopened", "observations.reloaded", "observations.reconnected", "comparison", "disk"] },
  cursorNative: { kind: "pending-observation", control: "providers.listAvailability, provider.listModels, and provider.catalog" },
  claudeFallback: { kind: "pending-observation", control: "providers.listAvailability, provider.listModels, and provider.catalog" },
  ...(surface === "web"
    ? {
      reviewApproved: { kind: "blocked", prerequisite: "native automatic-review approval terminal event", surface: "public Composer, conversation, and Review" },
      reviewDenied: { kind: "blocked", prerequisite: "native automatic-review denial terminal event", surface: "public Composer, conversation, and Review" },
      permissionHandoff: { kind: "blocked", prerequisite: "native provider PermissionRequest after strict-review routing", surface: "public Composer permission control" },
    }
    : { electronRightPanel: { kind: "blocked", prerequisite: "a completed Electron Review journey", surface: "Electron", reason: "the proof starts Electron, but the native Codex Live diff did not reach public comparison" } }),
}; }

function focusedGateMatrix() { return FOCUSED_GATES.map(({ name, control, rows }) => ({ kind: "focused-pending", name, control, rows })); }
function requirePlaywright(repoRoot) { const pkg = NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"); if (!NodeFS.existsSync(pkg)) throw new Error("Condition: isolated Playwright is missing. Next action: run ensure-playwright.mjs."); return NodeModule.createRequire(pkg)("playwright"); }
function findChromiumPath() { return ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((path) => NodeFS.existsSync(path)); }
function summarizeComparison(comparison, patch) {
  return {
    comparison: {
      turnDiff: summarizeComparisonTurnDiff(comparison?.turnDiff),
      files: summarizeComparisonFiles(comparison?.files),
    },
    patch: redactPatch(patch),
  };
}

function summarizeComparisonTurnDiff(turnDiff) {
  return {
    phase: turnDiff?.phase ?? null,
    source: turnDiff?.source ?? null,
    fidelity: turnDiff?.fidelity ?? null,
    revision: Number.isInteger(turnDiff?.revision) ? turnDiff.revision : null,
  };
}

function summarizeComparisonFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({
    path: typeof file?.path === "string" ? NodePath.basename(file.path) : null,
    status: typeof file?.status === "string" ? file.status : null,
  }));
}

function redactPatch(patch) {
  return typeof patch === "string"
    ? patch.replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]").replace(/(?:token|authorization|cookie)\s*[:=]\s*\S+/gi, "$&[redacted]")
    : null;
}
export function recordLiveObservation(receipt, rendered, result) { const observation = assertLiveObservation(rendered, result); receipt.renderedEvidence.push({ state: "live", filePath: observation.filePath, patch: observation.renderedPatch, sourceLabel: observation.sourceLabel }); return observation; }
export async function captureLiveObservation(page, receipt, result, capture = captureLive, name = "web-live") { return recordLiveObservation(receipt, await capture(page, receipt, name, result), result); }
export function assertLiveObservation(rendered, result) {
  if (!rendered?.stopVisible || !hasCompleteRenderedEvidence(rendered, result, "live")) {
    throw new Error("Condition: rendered Live Review evidence was incomplete.");
  }
  return completeObservation(rendered, result, "live");
}

export function assertObservation(rendered, result, phase) {
  if (!renderedReviewIsComplete(rendered) || !hasCompleteRenderedEvidence(rendered, result, phase)) {
    throw new Error("Condition: rendered Review or exact comparison evidence was incomplete.");
  }
  return completeObservation(rendered, result, phase);
}

function renderedReviewIsComplete(rendered) {
  return rendered?.rows === 1 && rendered.spinners === 0;
}

function hasCompleteRenderedEvidence(rendered, result, phase) {
  return completeComparisonHasPhase(result, phase)
    && hasAgentPatch(result)
    && renderedFileMatches(rendered, result)
    && renderedPatchIsAgentOnly(rendered)
    && renderedSourceMatches(rendered, result);
}

function completeComparisonHasPhase(result, phase) {
  const turnDiff = result?.comparison?.turnDiff;
  return turnDiff?.phase === phase && Boolean(turnDiff.source) && Boolean(turnDiff.fidelity) && Boolean(result?.file?.path);
}

function hasAgentPatch(result) {
  return typeof result?.patch === "string";
}

function renderedFileMatches(rendered, result) {
  return rendered?.filePath === result?.file?.path && hasAgentOnlyMarker(rendered?.fileText);
}

function renderedPatchIsAgentOnly(rendered) {
  return rendered?.patch === "AGENT_MARKER" && rendered.sourceLabel != null;
}

function renderedSourceMatches(rendered, result) {
  return rendered?.source === result?.comparison?.turnDiff?.source
    && rendered?.fidelity === result?.comparison?.turnDiff?.fidelity;
}

function completeObservation(rendered, result, phase) {
  const turnDiff = result.comparison.turnDiff;
  return {
    ...rendered,
    comparisonId: turnDiff.id,
    phase,
    source: turnDiff.source,
    fidelity: turnDiff.fidelity,
    filePath: result.file.path,
    renderedPatch: rendered.patch,
    patch: result.patch,
  };
}
function hasAgentOnlyMarker(fileText) { return typeof fileText === "string" && fileText.includes("AGENT_MARKER") && !fileText.includes("EXTERNAL_MARKER"); }
export function assertDiskContent(disk, agentMarker, externalMarker) { if (typeof disk !== "string" || !disk.includes(agentMarker) || !disk.includes(externalMarker)) throw new Error("Condition: disk did not retain both same-file markers."); return "both markers retained"; }
export function resolveUpstreamCodex(repoRoot, execute = NodeChildProcess.execFileSync, bunExecutable = process.execPath, now = () => new Date().toISOString()) {
  const source = resolveOpenSrcCodex(repoRoot, execute, bunExecutable);
  const local = resolveCachedCodexCommit(source.base, source.resolvedPath, execute, now);
  if (local.evidence) return local.evidence;
  return resolveRemoteCodexCommit(source.base, execute, now, local.failure);
}

function resolveOpenSrcCodex(repoRoot, execute, bunExecutable) {
  const opensrcHome = NodePath.join(repoRoot, ".opensrc");
  const resolverArgs = ["x", "--no-install", "opensrc", "path", "openai/codex"];
  const resolverOutput = execute(bunExecutable, resolverArgs, { cwd: repoRoot, env: { ...process.env, OPENSRC_HOME: opensrcHome }, encoding: "utf8" }).trim();
  const resolvedPath = NodePath.resolve(repoRoot, resolverOutput);
  assertCodexSourceLayout(resolvedPath);
  const source = readOpenSrcSource(opensrcHome, resolvedPath);
  return {
    resolvedPath,
    base: {
      command: "bunx --no-install opensrc path openai/codex",
      resolverOutput,
      resolvedPath,
      appServer: true,
      protocol: true,
      sourceVersion: source?.version ?? null,
      sourceFetchedAt: source?.fetchedAt ?? null,
    },
  };
}

function assertCodexSourceLayout(resolvedPath) {
  const appServer = NodePath.join(resolvedPath, "codex-rs", "app-server");
  const protocol = NodePath.join(resolvedPath, "codex-rs", "app-server-protocol");
  if (!NodeFS.existsSync(appServer) || !NodeFS.existsSync(protocol)) {
    throw new Error("Condition: OpenSrc Codex cache lacks codex-rs/app-server or app-server-protocol.");
  }
}

function resolveCachedCodexCommit(base, resolvedPath, execute, now) {
  if (!NodeFS.existsSync(NodePath.join(resolvedPath, ".git"))) {
    return { evidence: null, failure: "OpenSrc cache has no repository .git metadata" };
  }
  try {
    const commit = execute("git", ["-C", resolvedPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!commit) throw new Error("git rev-parse HEAD returned no commit");
    return { evidence: { ...base, commit, cacheCommit: commit, commitProvenance: "OpenSrc cache git rev-parse HEAD", commitResolvedAt: now() } };
  } catch (error) {
    return { evidence: null, failure: `OpenSrc cache git rev-parse HEAD failed: ${safeError(error)}` };
  }
}

function resolveRemoteCodexCommit(base, execute, now, localFailure) {
  try {
    const remoteOutput = execute("git", ["ls-remote", "https://github.com/openai/codex.git", "refs/heads/main"], { encoding: "utf8" }).trim();
    const commit = remoteOutput.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/m)?.[1];
    if (!commit) throw new Error("git ls-remote did not return refs/heads/main");
    return { ...base, commit, cacheCommit: null, commitProvenance: "git ls-remote https://github.com/openai/codex.git refs/heads/main", commitResolvedAt: now() };
  } catch (error) {
    return { ...base, commit: null, cacheCommit: null, auditBlocker: `${localFailure}; git ls-remote refs/heads/main failed: ${safeError(error)}` };
  }
}
function readOpenSrcSource(opensrcHome, resolvedPath) { try { return JSON.parse(NodeFS.readFileSync(NodePath.join(opensrcHome, "sources.json"), "utf8")).repos?.find((candidate) => NodePath.resolve(opensrcHome, candidate.path) === resolvedPath); } catch { return null; } }
function resolveApplicationCommit(repoRoot) { try { return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); } catch { return "blocked: git rev-parse HEAD failed"; } }
function pathsMatch(a, b) { return typeof a === "string" && typeof b === "string" && NodePath.resolve(a).toLowerCase() === NodePath.resolve(b).toLowerCase(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) { return error instanceof Error ? error.message.replace(/[A-Za-z]:\\[^\n]+/g, "[path]") : String(error); }
if (import.meta.main) await main();
