import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { aggregateEvidenceFailures, assertDiskContent, assertLiveObservation, assertObservation, assertPatchAttribution, assertSeparateClients, captureCodexTraceEvidence, captureLiveObservation, captureSettledReviewState, classifyLiveDiffFailure, cleanup, cleanupOwned, closeReview, composerPrompt, createOwnedFixtureWorkspace, createReceipt, inspectClaudeAccountStatus, inspectProviderPrerequisites, openDesktop, openNewThreadForWorkspace, parseArguments, proof, readRenderedReview, readSettledPublicComparison, recordLiveComparisonDiagnostic, recordLiveObservation, resolveUpstreamCodex, reviewRowCount, runFocusedEvidenceGates, waitForExactReview, waitForLiveAgentDiff, waitForNewThread, waitForNewThreadWelcome, writeReceipt } from "./provider-completeness.mjs";

NodeTest.test("requires explicit proof and cleanup confirmations", () => {
  NodeAssert.deepEqual(parseArguments(["health"]), { command: "health" });
  NodeAssert.deepEqual(parseArguments(["proof", "--confirm-cleanup", "--confirm-provider-call"]), { command: "proof" });
  NodeAssert.throws(() => parseArguments(["proof", "--confirm-provider-call"]), /requires health, proof/);
  NodeAssert.throws(() => parseArguments(["cleanup"]), /requires health, proof/);
});

NodeTest.test("writes the receipt to its original path while redacting serialized paths", async () => {
  const path = "C:\\verification\\receipt.json";
  const writes = [];
  await writeReceipt({ writeFile: async (...args) => writes.push(args) }, { path, fixtureFile: "C:\\fixture\\target.txt" });
  NodeAssert.equal(writes[0][0], path);
  NodeAssert.equal(writes[0][2], "utf8");
  NodeAssert.match(writes[0][1], /"path": "\[path\]"/);
  NodeAssert.match(writes[0][1], /"fixtureFile": "\[path\]"/);
});

NodeTest.test("closes Review only when the Review panel is open", async () => {
  let reviewOpen = false;
  let clicks = 0;
  const page = {
    getByTestId: () => ({ isVisible: async () => reviewOpen }),
    getByRole: () => ({ click: async () => { clicks += 1; reviewOpen = false; } }),
  };
  await closeReview(page);
  NodeAssert.equal(clicks, 0);
  reviewOpen = true;
  await closeReview(page);
  NodeAssert.equal(clicks, 1);
});

NodeTest.test("counts Review file rows without matching Last turn toolbar and header text", async () => {
  const review = { locator: (selector) => ({ count: async () => selector === "[data-review-file]" ? 1 : 0 }) };
  const page = { getByTestId: () => review, getByText: () => ({ count: async () => 3 }) };
  NodeAssert.equal(await reviewRowCount(page.getByTestId("review-last-turn")), 1);
  NodeAssert.equal(await page.getByText(/last turn/i).count(), 3);
});

NodeTest.test("waits for the exact Review file with the expected source and fidelity", async () => {
  const result = { file: { path: "target.txt" }, comparison: { turnDiff: { source: "agent", fidelity: "native" } } };
  const review = {
    isVisible: async () => true,
    locator: () => ({ waitFor: async () => {}, innerText: async () => "AGENT_MARKER" }),
    getByTestId: () => ({
      waitFor: async () => {},
      getAttribute: async (name) => name === "data-review-source" ? "agent" : "native",
    }),
  };
  const page = { getByTestId: () => review };
  NodeAssert.equal(await waitForExactReview(page, result), review);
  review.getByTestId = () => ({
    waitFor: async () => {},
    getAttribute: async (name) => name === "data-review-source" ? "stale" : "native",
  });
  await NodeAssert.rejects(waitForExactReview(page, result, 1), /exact Review file or source marker/);
});

NodeTest.test("starts every provider-completeness row with actionable evidence or a specific control gap", () => {
  const matrix = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-matrix-"))).matrix;
  for (const [row, evidence] of Object.entries(matrix)) {
    NodeAssert.ok(evidence.kind, `${row} has an evidence kind`);
    if (evidence.kind === "focused-pending") NodeAssert.ok(evidence.gate, `${row} names its required focused gate`);
    if (evidence.kind === "blocked") NodeAssert.ok(evidence.prerequisite, `${row} names its unavailable control`);
  }
  NodeAssert.equal(matrix.codexNative.kind, "live-proof-required");
  NodeAssert.equal(matrix.electronRightPanel.surface, "Electron");
});

NodeTest.test("runs each focused evidence gate through an injected runner and marks only its rows proven", async () => {
  const receipt = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-gates-")));
  const calls = [];
  const failures = await runFocusedEvidenceGates("root", receipt, async (request) => {
    calls.push(request);
    return { exitCode: 0, output: "all passed" };
  });
  NodeAssert.deepEqual(failures, []);
  NodeAssert.equal(calls.length, 5);
  NodeAssert.deepEqual(calls.slice(0, 3).map((call) => call.args.at(-1)), [
    "src/features/agents/turns/__tests__/turn-diff-review.test.ts",
    "src/features/agents/turns/__tests__/approval-review-policy.test.ts",
    "src/features/projects/files/__tests__/workspace-invalidation-service.test.ts",
  ]);
  NodeAssert.ok(calls[0].args.includes("--testTimeout=30000"));
  NodeAssert.equal(receipt.matrix.invalidation.kind, "focused-proof");
  NodeAssert.equal(receipt.matrix.warningsReroutes.kind, "focused-proof");
  NodeAssert.equal(receipt.matrix.fileSurfaces.kind, "focused-proof");
  NodeAssert.equal(receipt.electron.matrix.fileSurfaces.kind, "focused-proof");
  NodeAssert.deepEqual(receipt.focusedGates.map((gate) => gate.exitCode), [0, 0, 0, 0, 0]);
});

NodeTest.test("retains all focused gate evidence before reporting nonzero gates", async () => {
  const receipt = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-gates-")));
  let calls = 0;
  const failures = await runFocusedEvidenceGates("root", receipt, async () => ({ exitCode: calls++ === 3 ? 1 : 0, output: "failed C:\\secret\\token" }));
  NodeAssert.deepEqual(failures, ["codex-protocol exited 1"]);
  NodeAssert.equal(receipt.focusedGates.length, 5);
  NodeAssert.equal(receipt.matrix.warningsReroutes.kind, "focused-proof-failed");
  NodeAssert.doesNotMatch(receipt.focusedGates[1].output, /C:\\secret/);
});

NodeTest.test("waits for the selected workspace heading after creating a new thread", async () => {
  let query;
  const page = { getByRole: (role, options) => { query = { role, options }; return { waitFor: async () => {} }; } };
  await waitForNewThreadWelcome(page, "Provider completeness");
  NodeAssert.deepEqual(query, { role: "heading", options: { name: "What should we build in Provider completeness?", exact: true } });
});

NodeTest.test("opens a projectless new thread through the sidebar and selects its workspace", async () => {
  const clicks = [];
  const page = {
    getByTestId: (testId) => ({
      isVisible: async () => testId === "new-thread-active-project-picker" ? false : true,
      click: async () => { clicks.push(testId); },
      waitFor: async () => { clicks.push(`${testId}:visible`); },
    }),
    getByRole: (role, options) => ({
      click: async () => { clicks.push(`${role}:${options.name}`); },
      waitFor: async () => { clicks.push(`${role}:${options.name}:visible`); },
    }),
  };
  await openNewThreadForWorkspace(page, "Provider completeness");
  NodeAssert.deepEqual(clicks, ["sidebar-new-thread", "new-thread-welcome:visible", "new-thread-project-picker", "option:Provider completeness", "heading:What should we build in Provider completeness?:visible"]);
});

NodeTest.test("aggregates focused gates and every failed provider surface", () => {
  const failed = aggregateEvidenceFailures(["server-turn-diff-review exited 1"], {
    web: { codexNative: { kind: "live-proof-failed", provider: "codex" }, claudeFallback: { kind: "live-proof-failed", provider: "claude" } },
    electron: { codexNative: { kind: "live-proof-failed", provider: "codex" }, claudeFallback: { kind: "live-proof-failed", provider: "claude" } },
  });
  NodeAssert.deepEqual(failed, ["server-turn-diff-review exited 1", "web/codex", "web/claude", "electron/codex", "electron/claude"]);
});

NodeTest.test("selects only the new exact Codex thread", async () => {
  const socket = { rpc: async () => [
    { id: "old", provider: "codex", model: "gpt-5.6-terra" },
    { id: "new", provider: "codex", model: "gpt-5.6-terra" },
    { id: "other", provider: "cursor", model: "gpt-5.6-terra" },
  ] };
  const thread = await waitForNewThread(socket, "workspace", new Set(["old"]), "codex", "gpt-5.6-terra", { ownedThreadIds: [] }, Date.now() + 10);
  NodeAssert.equal(thread.id, "new");
});

NodeTest.test("retains every ambiguous thread candidate for cleanup", async () => {
  const run = { ownedThreadIds: [] };
  const socket = { rpc: async () => [{ id: "first", provider: "codex", model: "gpt-5.6-terra" }, { id: "second", provider: "codex", model: "gpt-5.6-terra" }] };
  await NodeAssert.rejects(waitForNewThread(socket, "workspace", new Set(), "codex", "gpt-5.6-terra", run, Date.now() + 10), /more than one/);
  NodeAssert.deepEqual(run.ownedThreadIds, ["first", "second"]);
});

NodeTest.test("records public provider prerequisites without hardcoded provider gaps", async () => {
  const calls = [];
  const socket = { rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === "providers.listAvailability") return [
      { id: "codex", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } },
      { id: "cursor", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } },
      { id: "claude", enabled: false, hasAdapter: true, comingSoon: false, cli: { status: "not_found" } },
    ];
    if (method === "provider.listModels") return params.providerId === "codex" ? [{ id: "gpt-5.6-terra" }] : [{ id: "available-model" }];
    if (method === "provider.catalog") return { freshness: "fresh", selectableAgents: [] };
    throw new Error(`unexpected ${method}`);
  } };
  const matrix = await inspectProviderPrerequisites(socket, { id: "workspace" }, () => '{"loggedIn":false}');
  NodeAssert.equal(matrix.codexNative.kind, "required-live-proof");
  NodeAssert.equal(matrix.cursorNative.kind, "required-live-proof");
  NodeAssert.equal(matrix.cursorNative.observedPrerequisites.availability.enabled, true);
  NodeAssert.equal(matrix.claudeFallback.observedPrerequisites.availability.enabled, false);
  NodeAssert.equal(matrix.claudeFallback.observedPrerequisites.account, null);
  NodeAssert.equal(calls.filter(({ method }) => method === "provider.catalog").length, 3);
  NodeAssert.equal(calls.filter(({ method }) => method === "provider.listModels").length, 3);
});

NodeTest.test("marks an available Claude provider as a coverage gap only when its CLI reports no account", async () => {
  const socket = { rpc: async (method, params) => {
    if (method === "providers.listAvailability") return [
      { id: "codex", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } },
      { id: "cursor", enabled: false, hasAdapter: true, comingSoon: false, cli: { status: "unchecked" } },
      { id: "claude", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } },
    ];
    if (method === "provider.listModels") return params.providerId === "codex" ? [{ id: "gpt-5.6-terra" }] : [{ id: "claude-opus-5" }];
    if (method === "provider.catalog") return { freshness: "fresh", selectableAgents: [] };
    throw new Error(`unexpected ${method}`);
  } };
  const matrix = await inspectProviderPrerequisites(socket, { id: "workspace" }, () => '{"loggedIn":false}');
  NodeAssert.equal(matrix.claudeFallback.kind, "coverage-gap");
  NodeAssert.match(matrix.claudeFallback.coverageGap, /no authenticated account/);
  NodeAssert.deepEqual(matrix.claudeFallback.observedPrerequisites.account, { status: "not-authenticated", loggedIn: false });
});

NodeTest.test("parses a Claude CLI unauthenticated status from its nonzero exit output without retaining it", () => {
  const error = Object.assign(new Error("CLI exited"), { stdout: Buffer.from('{"loggedIn":false,"authMethod":"none"}') });
  NodeAssert.deepEqual(inspectClaudeAccountStatus(() => { throw error; }), { status: "not-authenticated", loggedIn: false });
  NodeAssert.deepEqual(inspectClaudeAccountStatus(() => "not JSON"), { status: "unknown", loggedIn: null });
});

NodeTest.test("does not report Codex ready when its public catalog is unavailable", async () => {
  const socket = { rpc: async (method, params) => {
    if (method === "providers.listAvailability") return [{ id: "codex", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } }];
    if (method === "provider.listModels") return [{ id: "gpt-5.6-terra" }];
    if (method === "provider.catalog" && params.providerId === "codex") throw new Error("catalog unavailable");
    return [];
  } };
  const matrix = await inspectProviderPrerequisites(socket, { id: "workspace" }, () => '{"loggedIn":false}');
  NodeAssert.equal(matrix.codexNative.kind, "coverage-gap");
  NodeAssert.match(matrix.codexNative.observedPrerequisites.errors.join("\n"), /catalog unavailable/);
});

NodeTest.test("owns and deletes only a unique verifier fixture workspace", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-workspace-"));
  const fixtureRoot = NodePath.join(repo, ".dev", "fixture-repo");
  NodeFS.mkdirSync(fixtureRoot, { recursive: true });
  const receipt = createReceipt(repo);
  const socket = { rpc: async (method, params) => {
    if (method === "workspace.list") return [];
    if (method === "workspace.create") return { id: "owned", name: params.name, path: params.path };
    throw new Error(`unexpected ${method}`);
  } };
  try {
    const workspace = await createOwnedFixtureWorkspace(socket, repo, receipt);
    NodeAssert.equal(workspace.id, "owned");
    NodeAssert.equal(receipt.run.ownedWorkspaceId, "owned");
    NodeAssert.equal(NodeFS.existsSync(receipt.fixtureDirectory), true);
  } finally { NodeFS.rmSync(repo, { recursive: true, force: true }); }
});

NodeTest.test("reconciles a lost create response to one exact owned fixture workspace", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-workspace-"));
  const fixtureRoot = NodePath.join(repo, ".dev", "fixture-repo");
  NodeFS.mkdirSync(fixtureRoot, { recursive: true });
  const receipt = createReceipt(repo);
  let listed = 0;
  const socket = { rpc: async (method) => {
    if (method === "workspace.list") return listed++ === 0 ? [] : [{ id: "recovered", path: receipt.fixtureDirectory }];
    if (method === "workspace.create") throw new Error("connection closed after create");
    throw new Error(`unexpected ${method}`);
  } };
  try {
    const workspace = await createOwnedFixtureWorkspace(socket, repo, receipt);
    NodeAssert.equal(workspace.id, "recovered");
    NodeAssert.equal(receipt.run.ownedWorkspaceId, "recovered");
    NodeAssert.deepEqual(receipt.cleanup.failures, []);
  } finally { NodeFS.rmSync(repo, { recursive: true, force: true }); }
});

NodeTest.test("retains a cleanup failure when fixture create reconciliation is ambiguous", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-workspace-"));
  const fixtureRoot = NodePath.join(repo, ".dev", "fixture-repo");
  NodeFS.mkdirSync(fixtureRoot, { recursive: true });
  const receipt = createReceipt(repo);
  const socket = { rpc: async (method) => {
    if (method === "workspace.list") return [];
    if (method === "workspace.create") return { id: "wrong", path: repo };
    throw new Error(`unexpected ${method}`);
  } };
  try {
    await NodeAssert.rejects(createOwnedFixtureWorkspace(socket, repo, receipt), /did not return the exact verifier fixture workspace/);
    NodeAssert.match(receipt.cleanup.workspaceCleanupGap, /could not be reconciled/);
  } finally { NodeFS.rmSync(repo, { recursive: true, force: true }); }
});

NodeTest.test("waits for an exact Live agent file before an external edit may follow", async () => {
  let calls = 0;
  const socket = { rpc: async () => {
    calls += 1;
    return calls === 1
      ? { turnDiff: { phase: "live", id: "first" }, files: [{ path: "other.txt" }] }
      : calls === 2 ? { turnDiff: { phase: "live", id: "second" }, files: [{ path: "target.txt" }] }
      : "AGENT_MARKER";
  } };
  const comparison = await waitForLiveAgentDiff(socket, "thread", "target.txt", Date.now() + 2_000);
  NodeAssert.equal(comparison.file.path, "target.txt");
  NodeAssert.equal(comparison.patch, "AGENT_MARKER");
  NodeAssert.equal(calls, 3);
});

NodeTest.test("uses an explicit Windows-safe hold after the exact agent write", () => {
  const prompt = composerPrompt("target.txt");
  NodeAssert.match(prompt, /Edit target\.txt/);
  NodeAssert.match(prompt, /AGENT_MARKER/);
  NodeAssert.match(prompt, /apply_patch tool/);
  NodeAssert.match(prompt, /powershell\.exe -NoProfile -Command "Start-Sleep -Seconds 30"/);
  NodeAssert.doesNotMatch(prompt, /EXTERNAL_MARKER/);
});

NodeTest.test("retains bounded, distinct Live comparison diagnostics", () => {
  const diagnostics = { states: [], omitted: 0 };
  recordLiveComparisonDiagnostic(diagnostics, null);
  recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision: 1 }, files: [{ path: "nested/target.txt" }] });
  recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision: 1 }, files: [{ path: "nested/target.txt" }] });
  for (let revision = 2; revision <= 30; revision += 1) recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision }, files: [] });
  NodeAssert.deepEqual(diagnostics.states[0], { state: "null", phase: null, source: null, fidelity: null, revision: null, files: [] });
  NodeAssert.deepEqual(diagnostics.states[1], { state: "comparison", phase: "live", source: "provider", fidelity: "agent", revision: 1, files: ["target.txt"] });
  NodeAssert.equal(diagnostics.states.length, 24);
  NodeAssert.equal(diagnostics.omitted, 7);
});

NodeTest.test("classifies only an exhausted held Live window as a Codex provider/product gap", () => {
  const failure = new Error("Condition: exact file never appeared in a Live agent diff with AGENT_MARKER.");
  NodeAssert.match(classifyLiveDiffFailure("agent-live-diff", failure), /Codex provider\/product gap/);
  NodeAssert.equal(classifyLiveDiffFailure("agent-live-diff", new Error("socket closed")), undefined);
  NodeAssert.equal(classifyLiveDiffFailure("settled", failure), undefined);
});

NodeTest.test("records installed Codex trace evidence and distinguishes an absent diff notification", () => {
  const threadId = "mcode-thread";
  const log = [
    `info: Codex trace ingest {"method":"turn/started","raw":{"threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
    `info: Codex trace ingest {"method":"item/started","raw":{"itemType":"fileChange","threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
    `info: Codex trace ingest {"method":"turn/completed","raw":{"threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
  ].join("\n");
  const trace = captureCodexTraceEvidence("root", threadId, { readFile: () => log, execute: () => "codex-cli 0.153.4\n" });
  NodeAssert.equal(trace.installedVersion, "codex-cli 0.153.4");
  NodeAssert.deepEqual(trace.nativeThreadIds, ["native-thread"]);
  NodeAssert.deepEqual(trace.nativeTurnIds, ["native-turn"]);
  NodeAssert.equal(trace.fileChangeSeen, true);
  NodeAssert.equal(trace.turnDiffUpdatedSeen, false);
  NodeAssert.match(trace.emitCodexTurnDiff, /not evaluated/);
});

NodeTest.test("rejects external-marker attribution in the public agent patch", () => {
  NodeAssert.doesNotThrow(() => assertPatchAttribution("AGENT_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"));
  NodeAssert.throws(() => assertPatchAttribution("AGENT_MARKER\nEXTERNAL_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"), /exclusively attribute/);
});

NodeTest.test("rejects incomplete Review and disk evidence", () => {
  const result = { comparison: { turnDiff: { id: "comparison", phase: "settled", source: "native", fidelity: "agent" } }, file: { path: "target.txt" }, patch: "AGENT_MARKER\nEXTERNAL_MARKER" };
  const rendered = { rows: 1, spinners: 0, screenshot: "proof.png", filePath: "target.txt", fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  NodeAssert.doesNotThrow(() => assertObservation(rendered, result, "settled"));
  NodeAssert.throws(() => assertObservation({ ...rendered, rows: 2 }, result, "settled"), /incomplete/);
  NodeAssert.throws(() => assertObservation({ ...rendered, spinners: 1 }, result, "settled"), /incomplete/);
  NodeAssert.throws(() => assertObservation(rendered, { ...result, comparison: { turnDiff: { phase: "settled" } } }, "settled"), /incomplete/);
  NodeAssert.throws(() => assertObservation({ ...rendered, patch: null }, result, "settled"), /incomplete/);
  NodeAssert.throws(() => assertObservation({ ...rendered, fileText: "AGENT_MARKER\nEXTERNAL_MARKER" }, result, "settled"), /incomplete/);
  NodeAssert.throws(() => assertObservation({ ...rendered, sourceLabel: null }, result, "settled"), /incomplete/);
  NodeAssert.doesNotThrow(() => assertDiskContent("AGENT_MARKER\nEXTERNAL_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"));
  NodeAssert.throws(() => assertDiskContent("AGENT_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"), /disk did not retain/);
});

NodeTest.test("records valid Live Review observations without settled Review invariants", async () => {
  const receipt = { renderedEvidence: [] };
  const result = { comparison: { turnDiff: { id: "live", phase: "live", source: "native", fidelity: "agent" } }, file: { path: "target.txt" }, patch: "AGENT_MARKER" };
  const rendered = { stopVisible: true, screenshot: "live.png", filePath: "target.txt", fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  await captureLiveObservation({}, receipt, result, async () => rendered);
  NodeAssert.equal(receipt.renderedEvidence[0].state, "live");
  await NodeAssert.rejects(captureLiveObservation({}, { renderedEvidence: [] }, result, async () => ({ ...rendered, stopVisible: false })), /Live Review evidence was incomplete/);
  NodeAssert.throws(() => assertLiveObservation({ ...rendered, stopVisible: false }, result), /Live Review evidence was incomplete/);
  NodeAssert.throws(() => assertLiveObservation({ ...rendered, patch: null }, result), /Live Review evidence was incomplete/);
});

NodeTest.test("reads only the exact Review file and source label", async () => {
  const page = reviewPage({ filePath: "target.txt", fileText: "target.txt AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssert.deepEqual(await readRenderedReview(page, "target.txt"), { filePath: "target.txt", fileText: "target.txt AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  const wrongPatchPage = reviewPage({ filePath: "target.txt", fileText: "target.txt", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssert.equal((await readRenderedReview(wrongPatchPage, "target.txt")).patch, null);
  const missingLabelPage = reviewPage({ filePath: "target.txt", fileText: "target.txt AGENT_MARKER", sourceLabel: null, source: null, fidelity: null });
  NodeAssert.equal((await readRenderedReview(missingLabelPage, "target.txt")).sourceLabel, null);
  const transcriptOnlyMarker = reviewPage({ filePath: "other.txt", fileText: "other.txt", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssert.deepEqual(await readRenderedReview(transcriptOnlyMarker, "target.txt"), { filePath: null, fileText: null, patch: null, sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
});

NodeTest.test("fetches a fresh public comparison and exact file diff for every post-settlement Review state", async () => {
  const calls = [];
  const socket = { rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === "turnDiff.getComparison") return { turnDiff: { id: `comparison-${calls.length}`, phase: "settled", source: "native", fidelity: "agent" }, files: [{ path: "target.txt" }] };
    return "AGENT_MARKER";
  } };
  const receipt = { comparison: {} };
  const rendered = { rows: 1, spinners: 0, filePath: "target.txt", fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  for (const state of ["electron-settled", "web-settled", "web-reopened", "web-reloaded", "electron-reconnected"]) {
    await captureSettledReviewState(socket, "thread", "target.txt", {}, receipt, state, async () => rendered);
  }
  NodeAssert.deepEqual(Object.keys(receipt.comparison), ["electron-settled", "web-settled", "web-reopened", "web-reloaded", "electron-reconnected"]);
  NodeAssert.equal(calls.filter(({ method }) => method === "turnDiff.getComparison").length, 5);
  NodeAssert.equal(calls.filter(({ method }) => method === "turnDiff.getFileDiff").length, 5);
});

NodeTest.test("rejects a mixed-marker settled public patch", async () => {
  const socket = { rpc: async (method) => method === "turnDiff.getComparison"
    ? { turnDiff: { id: "comparison", phase: "settled", source: "native", fidelity: "agent" }, files: [{ path: "target.txt" }] }
    : "AGENT_MARKER\nEXTERNAL_MARKER" };
  await NodeAssert.rejects(readSettledPublicComparison(socket, "thread", "target.txt"), /exclusively attribute/);
});

function reviewPage({ filePath, fileText, sourceLabel, source, fidelity }) {
  const sourceLocator = {
    count: async () => sourceLabel === null ? 0 : 1,
    innerText: async () => sourceLabel,
    getAttribute: async (name) => name === "data-review-source" ? source : fidelity,
  };
  const review = {
    locator: (selector) => ({
      count: async () => selector.includes(filePath) ? 1 : 0,
      innerText: async () => fileText,
    }),
    getByTestId: () => sourceLocator,
  };
  return { getByTestId: () => review };
}

NodeTest.test("records the resolver commit or exact no-commit audit blocker", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-opensrc-"));
  const codex = NodePath.join(root, "cached-codex");
  NodeFS.mkdirSync(NodePath.join(codex, "codex-rs", "app-server"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(codex, "codex-rs", "app-server-protocol"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, ".opensrc"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, ".opensrc", "sources.json"), JSON.stringify({ repos: [{ path: "../cached-codex", version: "main", fetchedAt: "2026-09-07T00:00:00Z" }] }));
  try {
    const calls = [];
    const execute = (command, args, options) => { calls.push({ command, args, options }); return command === "bun.exe" ? "cached-codex\n" : "abc123\n"; };
    NodeFS.mkdirSync(NodePath.join(codex, ".git"));
    const resolved = resolveUpstreamCodex(root, execute, "bun.exe");
    NodeAssert.equal(resolved.commit, "abc123");
    NodeAssert.equal(resolved.command, "bunx --no-install opensrc path openai/codex");
    NodeAssert.deepEqual(calls[0].args, ["x", "--no-install", "opensrc", "path", "openai/codex"]);
    NodeAssert.equal(calls[0].options.env.OPENSRC_HOME, NodePath.join(root, ".opensrc"));
    NodeFS.rmSync(NodePath.join(root, ".opensrc", "sources.json"));
    const noCommitCalls = [];
    const noCommit = resolveUpstreamCodex(root, (command, args) => { noCommitCalls.push({ command, args }); if (command === "bun.exe") return "cached-codex\n"; if (args.includes("rev-parse")) throw new Error("cache metadata unavailable"); if (args[0] === "ls-remote") return "0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n"; throw new Error("unexpected command"); }, "bun.exe", () => "2026-09-08T12:00:00.000Z");
    NodeAssert.equal(noCommit.resolverOutput, "cached-codex");
    NodeAssert.equal(noCommit.commit, "0123456789abcdef0123456789abcdef01234567");
    NodeAssert.equal(noCommit.cacheCommit, null);
    NodeAssert.equal(noCommit.commitProvenance, "git ls-remote https://github.com/openai/codex.git refs/heads/main");
    NodeAssert.equal(noCommit.commitResolvedAt, "2026-09-08T12:00:00.000Z");
    NodeAssert.equal(noCommit.sourceVersion, null);
    NodeAssert.equal(noCommit.auditBlocker, undefined);
    NodeAssert.deepEqual(noCommitCalls.map(({ command }) => command), ["bun.exe", "git", "git"]);
    const blocked = resolveUpstreamCodex(root, (command, args) => {
      if (command === "bun.exe") return "cached-codex\n";
      if (args.includes("rev-parse")) throw new Error("cache metadata unavailable");
      throw new Error("remote lookup unavailable");
    }, "bun.exe");
    NodeAssert.equal(blocked.commit, null);
    NodeAssert.match(blocked.auditBlocker, /cache metadata unavailable/);
    NodeAssert.match(blocked.auditBlocker, /remote lookup unavailable/);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("requires separate web and Electron browser objects", () => {
  const browser = {};
  NodeAssert.throws(() => assertSeparateClients({ browser, context: {} }, { session: { browser, context: {} } }), /separate browser clients/);
  NodeAssert.doesNotThrow(() => assertSeparateClients({ browser: {}, context: {} }, { session: { browser: {}, context: {} } }));
});

NodeTest.test("reports cleanup failures while deleting only recorded resources", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-"));
  const file = NodePath.join(root, "owned.txt");
  NodeFS.writeFileSync(file, "owned");
  const calls = [];
  try {
    const result = await cleanupOwned({
      socket: { rpc: async (method, params) => { calls.push({ method, params }); if (method === "thread.delete") return true; throw new Error("unexpected"); }, close: async () => { throw new Error("close failed"); } },
      io: NodeFS.promises,
      receipt: { run: { threadId: "only-thread", ownedWorkspaceId: null, ownedFile: file } },
      repoRoot: root,
    });
    NodeAssert.deepEqual(calls, [{ method: "thread.delete", params: { threadId: "only-thread", cleanupWorktree: false } }]);
    NodeAssert.equal(NodeFS.existsSync(file), false);
    NodeAssert.match(result.failures.join("\n"), /socket: close failed/);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("releases browser clients before deleting the owned fixture", async () => {
  const calls = [];
  const receipt = { run: { threadId: null, ownedWorkspaceId: "workspace", ownedFile: "fixture/target.txt", ownedFixtureDirectory: "fixture" } };
  const result = await cleanupOwned({
    socket: { rpc: async () => true, close: async () => { calls.push("socket"); } },
    web: { browser: { close: async () => { calls.push("web"); } } },
    desktop: { session: {}, sessionHelper: { disconnectElectronSession: async () => { calls.push("desktop"); } } },
    io: { rm: async (path) => { calls.push(`rm:${path}`); } },
    receipt,
    repoRoot: process.cwd(),
    deleteWorkspace: async ({ report }) => { calls.push("workspace"); report.cleanup.workspaceDeleted = true; },
  });
  NodeAssert.deepEqual(calls, ["web", "desktop", "workspace", "rm:fixture/target.txt", "rm:fixture", "socket"]);
  NodeAssert.deepEqual(result.failures, []);
});

NodeTest.test("cleans each runtime only through its own socket", async () => {
  const calls = [];
  const receipt = {
    run: { threadId: "web-thread", ownedThreadIds: ["web-thread"], ownedWorkspaceId: "web-workspace", ownedFile: null, ownedFixtureDirectory: null },
    electron: { run: { threadId: "electron-thread", ownedThreadIds: ["electron-thread"], ownedWorkspaceId: "electron-workspace", ownedFile: null, ownedFixtureDirectory: null } },
  };
  const socket = (name) => ({ rpc: async (method, params) => { calls.push(`${name}:${method}:${params.threadId ?? params.id}`); return true; }, close: async () => {} });
  const result = await cleanupOwned({
    socket: socket("web"),
    electronSocket: socket("electron"),
    io: NodeFS.promises,
    receipt,
    repoRoot: process.cwd(),
    deleteWorkspace: async ({ ownedWorkspaceId, socket: runSocket, report }) => { calls.push(`workspace:${ownedWorkspaceId}:${runSocket === undefined ? "missing" : "present"}`); report.cleanup.workspaceDeleted = true; },
  });
  NodeAssert.deepEqual(calls, ["web:thread.list:undefined", "web:thread.delete:web-thread", "electron:thread.list:undefined", "electron:thread.delete:electron-thread", "electron:workspace.list:undefined", "workspace:electron-workspace:present", "web:workspace.list:undefined", "workspace:web-workspace:present"]);
  NodeAssert.deepEqual(result.failures, []);
});

NodeTest.test("stops an owned partial Electron session but preserves a reused session", async () => {
  let stopped = 0;
  const deps = { startElectron: async () => {}, stopElectron: () => { stopped += 1; }, sessionHelper: { connectElectronSession: async () => { throw new Error("connect failed"); } } };
  await NodeAssert.rejects(openDesktop("root", {}, {}, { ...deps, sessionExists: () => false }), /connect failed/);
  NodeAssert.equal(stopped, 1);
  await NodeAssert.rejects(openDesktop("root", {}, {}, { ...deps, sessionExists: () => true }), /connect failed/);
  NodeAssert.equal(stopped, 1);
});

NodeTest.test("propagates false and failed workspace cleanup", async () => {
  const receipt = { run: { ownedWorkspaceId: "workspace", threadId: null, ownedFile: null } };
  const base = { socket: { close: async () => {} }, io: NodeFS.promises, receipt, repoRoot: process.cwd() };
  const falseResult = await cleanupOwned({ ...base, deleteWorkspace: async ({ report }) => { report.cleanup.workspaceDeleted = false; } });
  NodeAssert.match(falseResult.failures.join("\n"), /workspace deletion was not confirmed/);
  const errorResult = await cleanupOwned({ ...base, deleteWorkspace: async ({ report }) => { report.cleanup.workspaceDeleted = false; report.cleanup.failure = "rpc failed"; } });
  NodeAssert.match(errorResult.failures.join("\n"), /workspace: rpc failed/);
});

NodeTest.test("manual cleanup skips an already-complete owned receipt", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-cleanup-"));
  try {
    const runId = "done";
    const directory = NodePath.join(root, ".dev", "verification", "provider-completeness", runId);
    NodeFS.mkdirSync(directory, { recursive: true });
    const fixtureFile = NodePath.join(root, ".dev", "fixture-repo", `provider-completeness-${runId}.txt`);
    const path = NodePath.join(directory, "receipt.json");
    NodeFS.writeFileSync(path, JSON.stringify({ runId, path, directory, fixtureFile, run: {}, cleanup: { complete: true, failures: [] } }));
    let calls = 0;
    await cleanup(root, { socket: { rpc: async () => { calls += 1; }, close: async () => {} } });
    NodeAssert.equal(calls, 0);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("manual cleanup does not open a stopped runtime when no receipt is pending", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-cleanup-"));
  try {
    const runId = "done";
    const directory = NodePath.join(root, ".dev", "verification", "provider-completeness", runId);
    const path = NodePath.join(directory, "receipt.json");
    const fixtureFile = NodePath.join(root, ".dev", "fixture-repo", `provider-completeness-${runId}.txt`);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(path, JSON.stringify({ runId, path, directory, fixtureFile, run: {}, cleanup: { complete: true, failures: [] } }));
    const result = await cleanup(root, { openSocket: async () => { throw new Error("runtime is stopped"); } });
    NodeAssert.deepEqual(result, { receipts: 1, cleanup: "complete" });
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("manual cleanup rewrites a redacted receipt at its run path", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-cleanup-"));
  try {
    const runId = "redacted";
    const directory = NodePath.join(root, ".dev", "verification", "provider-completeness", runId);
    const path = NodePath.join(directory, "receipt.json");
    const fixtureDirectory = NodePath.join(root, ".dev", "fixture-repo", `provider-completeness-${runId}`);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.mkdirSync(fixtureDirectory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(fixtureDirectory, "target.txt"), "owned");
    NodeFS.writeFileSync(path, JSON.stringify({ runId, path: "[path]", directory: "[path]", fixtureDirectory: "[path]", fixtureFile: "[path]", run: { ownedFixtureDirectory: "[path]" }, cleanup: { complete: false, failures: [] } }));
    await cleanup(root);
    NodeAssert.equal(NodeFS.existsSync(path), true);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(root, "[path]")), false);
    NodeAssert.equal(NodeFS.existsSync(fixtureDirectory), false);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("manual cleanup ignores a receipt that names resources outside its exact run directory", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-cleanup-"));
  const outside = NodePath.join(root, "outside.txt");
  try {
    const runId = "hostile";
    const directory = NodePath.join(root, ".dev", "verification", "provider-completeness", runId);
    const path = NodePath.join(directory, "receipt.json");
    const fixtureFile = NodePath.join(root, ".dev", "fixture-repo", `provider-completeness-${runId}.txt`);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(outside, "preserve");
    NodeFS.writeFileSync(path, JSON.stringify({ runId, path, directory, fixtureFile, run: { ownedFile: outside, threadId: "thread" }, cleanup: { complete: false, failures: [] } }));
    let calls = 0;
    await cleanup(root, { socket: { rpc: async () => { calls += 1; }, close: async () => {} } });
    NodeAssert.equal(calls, 0);
    NodeAssert.equal(NodeFS.existsSync(outside), true);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("writes a redacted receipt when orchestration fails before dispatch", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-receipt-"));
  try {
    await NodeAssert.rejects(proof(root, { health: async () => { throw new Error("health failed"); } }), /health failed/);
    const receipt = NodeFS.readdirSync(NodePath.join(root, ".dev", "verification", "provider-completeness"), { recursive: true }).find((path) => path.endsWith("receipt.json"));
    NodeAssert.ok(receipt);
    const contents = NodeFS.readFileSync(NodePath.join(root, ".dev", "verification", "provider-completeness", receipt), "utf8");
    NodeAssert.match(contents, /"phase": "cleanup"/);
    NodeAssert.match(contents, /"phase": "health"/);
    NodeAssert.match(contents, /"complete": true/);
    NodeAssert.doesNotMatch(contents, /[A-Za-z]:\\\\/);
    for (const field of ["applicationCommit", "upstreamCodex", "provider", "model", "baseline", "publicComparison", "fetchedPatch", "renderedEvidence", "disk", "cleanup"]) NodeAssert.match(contents, new RegExp(`"${field}"`));
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});
