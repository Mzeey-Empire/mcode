import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { aggregateEvidenceFailures, assertDiskContent, assertLiveObservation, assertObservation, assertPatchAttribution, assertSeparateClients, captureCodexTraceEvidence, captureLiveObservation, captureSettledReviewState, classifyLiveDiffFailure, cleanup, cleanupOwned, closeReview, composerPrompt, createOwnedFixtureWorkspace, createReceipt, inspectClaudeAccountStatus, inspectProviderPrerequisites, openDesktop, openNewThreadForWorkspace, parseArguments, proof, readRenderedReview, readSettledPublicComparison, recordLiveComparisonDiagnostic, resolveUpstreamCodex, reviewRowCount, runComposerReviewJourney, runFocusedEvidenceGates, waitForExactReview, waitForLiveAgentDiff, waitForNewThread, waitForNewThreadWelcome, writeReceipt } from "./provider-completeness.mjs";

NodeTest.test("requires explicit proof and cleanup confirmations", () => {
  NodeAssertStrict.deepEqual(parseArguments(["health"]), { command: "health" });
  NodeAssertStrict.deepEqual(parseArguments(["proof", "--confirm-cleanup", "--confirm-provider-call"]), { command: "proof" });
  NodeAssertStrict.throws(() => parseArguments(["proof", "--confirm-provider-call"]), /requires health, proof/);
  NodeAssertStrict.throws(() => parseArguments(["cleanup"]), /requires health, proof/);
});

NodeTest.test("writes the receipt to its original path while redacting serialized paths", async () => {
  const path = "C:\\verification\\receipt.json";
  const writes = [];
  await writeReceipt({ writeFile: async (...args) => writes.push(args) }, { path, fixtureFile: "C:\\fixture\\target.txt" });
  NodeAssertStrict.equal(writes[0][0], path);
  NodeAssertStrict.equal(writes[0][2], "utf8");
  NodeAssertStrict.match(writes[0][1], /"path": "\[path\]"/);
  NodeAssertStrict.match(writes[0][1], /"fixtureFile": "\[path\]"/);
});

NodeTest.test("closes Review only when the Review panel is open", async () => {
  let reviewOpen = false;
  let clicks = 0;
  const page = {
    getByTestId: () => ({ isVisible: async () => reviewOpen }),
    getByRole: () => ({ click: async () => { clicks += 1; reviewOpen = false; } }),
  };
  await closeReview(page);
  NodeAssertStrict.equal(clicks, 0);
  reviewOpen = true;
  await closeReview(page);
  NodeAssertStrict.equal(clicks, 1);
});

NodeTest.test("counts Review file rows without matching Last turn toolbar and header text", async () => {
  const review = { locator: (selector) => ({ count: async () => selector === "[data-review-file]" ? 1 : 0 }) };
  const page = { getByTestId: () => review, getByText: () => ({ count: async () => 3 }) };
  NodeAssertStrict.equal(await reviewRowCount(page.getByTestId("review-last-turn")), 1);
  NodeAssertStrict.equal(await page.getByText(/last turn/i).count(), 3);
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
  NodeAssertStrict.equal(await waitForExactReview(page, result), review);
  review.getByTestId = () => ({
    waitFor: async () => {},
    getAttribute: async (name) => name === "data-review-source" ? "stale" : "native",
  });
  await NodeAssertStrict.rejects(waitForExactReview(page, result, 1), /exact Review file or source marker/);
});

NodeTest.test("starts every provider-completeness row with actionable evidence or a specific control gap", () => {
  const matrix = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-matrix-"))).matrix;
  for (const [row, evidence] of Object.entries(matrix)) {
    NodeAssertStrict.ok(evidence.kind, `${row} has an evidence kind`);
    if (evidence.kind === "focused-pending") NodeAssertStrict.ok(evidence.gate, `${row} names its required focused gate`);
    if (evidence.kind === "blocked") NodeAssertStrict.ok(evidence.prerequisite, `${row} names its unavailable control`);
  }
  NodeAssertStrict.equal(matrix.codexNative.kind, "live-proof-required");
  NodeAssertStrict.equal(matrix.electronRightPanel.surface, "Electron");
});

NodeTest.test("runs each focused evidence gate through an injected runner and marks only its rows proven", async () => {
  const receipt = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-gates-")));
  const calls = [];
  const failures = await runFocusedEvidenceGates("root", receipt, async (request) => {
    calls.push(request);
    return { exitCode: 0, output: "all passed" };
  });
  NodeAssertStrict.deepEqual(failures, []);
  NodeAssertStrict.equal(calls.length, 5);
  NodeAssertStrict.deepEqual(calls.slice(0, 3).map((call) => call.args.at(-1)), [
    "src/features/agents/turns/__tests__/turn-diff-review.test.ts",
    "src/features/agents/turns/__tests__/approval-review-policy.test.ts",
    "src/features/projects/files/__tests__/workspace-invalidation-service.test.ts",
  ]);
  NodeAssertStrict.ok(calls[0].args.includes("--testTimeout=30000"));
  NodeAssertStrict.equal(receipt.matrix.invalidation.kind, "focused-proof");
  NodeAssertStrict.equal(receipt.matrix.warningsReroutes.kind, "focused-proof");
  NodeAssertStrict.equal(receipt.matrix.fileSurfaces.kind, "focused-proof");
  NodeAssertStrict.equal(receipt.electron.matrix.fileSurfaces.kind, "focused-proof");
  NodeAssertStrict.deepEqual(receipt.focusedGates.map((gate) => gate.exitCode), [0, 0, 0, 0, 0]);
});

NodeTest.test("retains all focused gate evidence before reporting nonzero gates", async () => {
  const receipt = createReceipt(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-gates-")));
  let calls = 0;
  const failures = await runFocusedEvidenceGates("root", receipt, async () => ({ exitCode: calls++ === 3 ? 1 : 0, output: "failed C:\\secret\\token" }));
  NodeAssertStrict.deepEqual(failures, ["codex-protocol exited 1"]);
  NodeAssertStrict.equal(receipt.focusedGates.length, 5);
  NodeAssertStrict.equal(receipt.matrix.warningsReroutes.kind, "focused-proof-failed");
  NodeAssertStrict.doesNotMatch(receipt.focusedGates[1].output, /C:\\secret/);
});

NodeTest.test("waits for the selected workspace heading after creating a new thread", async () => {
  let query;
  const page = { getByRole: (role, options) => { query = { role, options }; return { waitFor: async () => {} }; } };
  await waitForNewThreadWelcome(page, "Provider completeness");
  NodeAssertStrict.deepEqual(query, { role: "heading", options: { name: "What should we build in Provider completeness?", exact: true } });
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
  NodeAssertStrict.deepEqual(clicks, ["sidebar-new-thread", "new-thread-welcome:visible", "new-thread-project-picker", "option:Provider completeness", "heading:What should we build in Provider completeness?:visible"]);
});

NodeTest.test("aggregates focused gates and every failed provider surface", () => {
  const failed = aggregateEvidenceFailures(["server-turn-diff-review exited 1"], {
    web: { codexNative: { kind: "live-proof-failed", provider: "codex" }, claudeFallback: { kind: "live-proof-failed", provider: "claude" } },
    electron: { codexNative: { kind: "live-proof-failed", provider: "codex" }, claudeFallback: { kind: "live-proof-failed", provider: "claude" } },
  });
  NodeAssertStrict.deepEqual(failed, ["server-turn-diff-review exited 1", "web/codex", "web/claude", "electron/codex", "electron/claude"]);
});

NodeTest.test("selects only the new exact Codex thread", async () => {
  const socket = { rpc: async () => [
    { id: "old", provider: "codex", model: "gpt-5.6-terra" },
    { id: "new", provider: "codex", model: "gpt-5.6-terra" },
    { id: "other", provider: "cursor", model: "gpt-5.6-terra" },
  ] };
  const thread = await waitForNewThread(socket, "workspace", new Set(["old"]), "codex", "gpt-5.6-terra", { ownedThreadIds: [] }, Date.now() + 10);
  NodeAssertStrict.equal(thread.id, "new");
});

NodeTest.test("retains every ambiguous thread candidate for cleanup", async () => {
  const run = { ownedThreadIds: [] };
  const socket = { rpc: async () => [{ id: "first", provider: "codex", model: "gpt-5.6-terra" }, { id: "second", provider: "codex", model: "gpt-5.6-terra" }] };
  await NodeAssertStrict.rejects(waitForNewThread(socket, "workspace", new Set(), "codex", "gpt-5.6-terra", run, Date.now() + 10), /more than one/);
  NodeAssertStrict.deepEqual(run.ownedThreadIds, ["first", "second"]);
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
  NodeAssertStrict.equal(matrix.codexNative.kind, "required-live-proof");
  NodeAssertStrict.equal(matrix.cursorNative.kind, "required-live-proof");
  NodeAssertStrict.equal(matrix.cursorNative.observedPrerequisites.availability.enabled, true);
  NodeAssertStrict.equal(matrix.claudeFallback.observedPrerequisites.availability.enabled, false);
  NodeAssertStrict.equal(matrix.claudeFallback.observedPrerequisites.account, null);
  NodeAssertStrict.equal(calls.filter(({ method }) => method === "provider.catalog").length, 3);
  NodeAssertStrict.equal(calls.filter(({ method }) => method === "provider.listModels").length, 3);
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
  NodeAssertStrict.equal(matrix.claudeFallback.kind, "coverage-gap");
  NodeAssertStrict.match(matrix.claudeFallback.coverageGap, /no authenticated account/);
  NodeAssertStrict.deepEqual(matrix.claudeFallback.observedPrerequisites.account, { status: "not-authenticated", loggedIn: false });
});

NodeTest.test("parses a Claude CLI unauthenticated status from its nonzero exit output without retaining it", () => {
  const error = Object.assign(new Error("CLI exited"), { stdout: Buffer.from('{"loggedIn":false,"authMethod":"none"}') });
  NodeAssertStrict.deepEqual(inspectClaudeAccountStatus(() => { throw error; }), { status: "not-authenticated", loggedIn: false });
  NodeAssertStrict.deepEqual(inspectClaudeAccountStatus(() => "not JSON"), { status: "unknown", loggedIn: null });
});

NodeTest.test("does not report Codex ready when its public catalog is unavailable", async () => {
  const socket = { rpc: async (method, params) => {
    if (method === "providers.listAvailability") return [{ id: "codex", enabled: true, hasAdapter: true, comingSoon: false, cli: { status: "found" } }];
    if (method === "provider.listModels") return [{ id: "gpt-5.6-terra" }];
    if (method === "provider.catalog" && params.providerId === "codex") throw new Error("catalog unavailable");
    return [];
  } };
  const matrix = await inspectProviderPrerequisites(socket, { id: "workspace" }, () => '{"loggedIn":false}');
  NodeAssertStrict.equal(matrix.codexNative.kind, "coverage-gap");
  NodeAssertStrict.match(matrix.codexNative.observedPrerequisites.errors.join("\n"), /catalog unavailable/);
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
    NodeAssertStrict.equal(workspace.id, "owned");
    NodeAssertStrict.equal(receipt.run.ownedWorkspaceId, "owned");
    NodeAssertStrict.equal(NodeFS.existsSync(receipt.fixtureDirectory), true);
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
    NodeAssertStrict.equal(workspace.id, "recovered");
    NodeAssertStrict.equal(receipt.run.ownedWorkspaceId, "recovered");
    NodeAssertStrict.deepEqual(receipt.cleanup.failures, []);
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
    await NodeAssertStrict.rejects(createOwnedFixtureWorkspace(socket, repo, receipt), /did not return the exact verifier fixture workspace/);
    NodeAssertStrict.match(receipt.cleanup.workspaceCleanupGap, /could not be reconciled/);
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
  NodeAssertStrict.equal(comparison.file.path, "target.txt");
  NodeAssertStrict.equal(comparison.patch, "AGENT_MARKER");
  NodeAssertStrict.equal(calls, 3);
});

NodeTest.test("captures Codex Live proof after the same-file external edit and reconnects the owning client before post-reconnect proof", async () => {
  const events = [];
  let externalEditApplied = false;
  let threadListCalls = 0;
  let comparisonCalls = 0;
  const socket = { rpc: async (method, params) => {
    if (method === "thread.list") {
      threadListCalls += 1;
      return threadListCalls === 1 ? [] : [{ id: "thread", provider: "codex", model: "model" }];
    }
    if (method === "turnDiff.getComparison") {
      comparisonCalls += 1;
      const phase = comparisonCalls < 3 ? "live" : "settled";
      const id = phase === "live"
        ? (externalEditApplied ? "live-after-external-edit" : "live-before-external-edit")
        : ["settled", "settled-observed", "settled-reopened", "settled-reloaded", "settled-after-reconnect"][comparisonCalls - 3];
      events.push(`comparison:${id}`);
      return { turnDiff: { id, phase, source: "native", fidelity: "agent" }, files: [{ path: "target-codex.txt" }] };
    }
    if (method === "turnDiff.getFileDiff") {
      events.push(`patch:${params.comparisonId}`);
      return "AGENT_MARKER";
    }
    throw new Error(`unexpected ${method}`);
  } };
  const run = { fixtureDirectory: "fixture", run: {}, diagnostics: { liveComparisons: { states: [], omitted: 0 } }, renderedEvidence: [], comparison: {} };
  const io = {
    writeFile: async () => {},
    appendFile: async () => { externalEditApplied = true; events.push("external-edit"); },
    readFile: async () => "BASELINE_MARKER\nAGENT_MARKER\nEXTERNAL_MARKER\n",
  };
  const liveCapture = async (_page, _receipt, _name, result) => {
    NodeAssertStrict.equal(externalEditApplied, true, "the external edit must precede the accepted Live capture");
    NodeAssertStrict.equal(result.comparison.turnDiff.id, "live-after-external-edit", "the accepted Live capture must use a refreshed public comparison");
    events.push("rendered-live");
    return { stopVisible: true, screenshot: "live.png", filePath: result.file.path, fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  };
  const reviewCapture = async (_page, _receipt, name, result) => {
    if (name.endsWith("reconnected")) events.push("rendered-reconnected");
    return { rows: 1, spinners: 0, screenshot: "settled.png", filePath: result.file.path, fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  };

  const page = composerJourneyPage(events);
  const result = await runComposerReviewJourney({ surface: "web", client: { page }, socket, workspace: { id: "workspace", name: "Fixture", path: "fixture" }, run, io, provider: "codex", model: "model", modelName: "Model", captureLive: liveCapture, captureReview: reviewCapture });

  NodeAssertStrict.equal(result.observations.live.comparisonId, "live-after-external-edit");
  NodeAssertStrict.equal(result.fetchedPatch, "AGENT_MARKER");
  NodeAssertStrict.equal(result.disk, "both markers retained");
  NodeAssertStrict.deepEqual(events.slice(0, 5), ["comparison:live-before-external-edit", "patch:live-before-external-edit", "external-edit", "comparison:live-after-external-edit", "patch:live-after-external-edit"]);
  NodeAssertStrict.ok(events.indexOf("rendered-live") > events.indexOf("comparison:live-after-external-edit"));
  NodeAssertStrict.equal(result.observations.reloaded.comparisonId, "settled-reloaded");
  NodeAssertStrict.equal(result.observations.reconnected.comparisonId, "settled-after-reconnect");
  const reloaded = events.indexOf("reload");
  const offline = events.indexOf("network:offline");
  const reconnected = events.indexOf("network:online");
  const publicState = events.lastIndexOf("comparison:settled-after-reconnect");
  NodeAssertStrict.ok(reloaded >= 0);
  NodeAssertStrict.ok(events.indexOf("comparison:settled-reloaded") > reloaded);
  NodeAssertStrict.ok(offline > events.indexOf("comparison:settled-reloaded"));
  NodeAssertStrict.ok(events.indexOf("connection-banner:visible") > offline);
  NodeAssertStrict.ok(reconnected > events.indexOf("connection-banner:visible"));
  NodeAssertStrict.ok(events.indexOf("connection-banner:hidden") > reconnected);
  NodeAssertStrict.ok(publicState > events.indexOf("connection-banner:hidden"));
  NodeAssertStrict.ok(events.indexOf("rendered-reconnected") > publicState);
});

function composerJourneyPage(events = []) {
  const control = { click: async () => {}, fill: async () => {}, press: async () => {}, waitFor: async () => {}, isVisible: async () => false };
  const dialog = { ...control, isVisible: async () => true, getByTestId: () => control, getByRole: () => control, getByText: () => control };
  const connectionBanner = { waitFor: async ({ state }) => { events.push(`connection-banner:${state}`); } };
  return {
    getByTestId: () => control,
    getByRole: (role) => role === "dialog" ? dialog : control,
    getByText: (text) => text === "Connection lost. Reconnecting to server..." ? connectionBanner : control,
    context: () => ({ setOffline: async (offline) => { events.push(`network:${offline ? "offline" : "online"}`); } }),
    reload: async () => { events.push("reload"); },
  };
}

NodeTest.test("uses an explicit Windows-safe hold after the exact agent write", () => {
  const prompt = composerPrompt("target.txt");
  NodeAssertStrict.match(prompt, /Edit target\.txt/);
  NodeAssertStrict.match(prompt, /AGENT_MARKER/);
  NodeAssertStrict.match(prompt, /apply_patch tool/);
  NodeAssertStrict.match(prompt, /powershell\.exe -NoProfile -Command "Start-Sleep -Seconds 30"/);
  NodeAssertStrict.doesNotMatch(prompt, /EXTERNAL_MARKER/);
});

NodeTest.test("retains bounded, distinct Live comparison diagnostics", () => {
  const diagnostics = { states: [], omitted: 0 };
  recordLiveComparisonDiagnostic(diagnostics, null);
  recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision: 1 }, files: [{ path: "nested/target.txt" }] });
  recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision: 1 }, files: [{ path: "nested/target.txt" }] });
  for (let revision = 2; revision <= 30; revision += 1) recordLiveComparisonDiagnostic(diagnostics, { turnDiff: { phase: "live", source: "provider", fidelity: "agent", revision }, files: [] });
  NodeAssertStrict.deepEqual(diagnostics.states[0], { state: "null", phase: null, source: null, fidelity: null, revision: null, files: [] });
  NodeAssertStrict.deepEqual(diagnostics.states[1], { state: "comparison", phase: "live", source: "provider", fidelity: "agent", revision: 1, files: ["target.txt"] });
  NodeAssertStrict.equal(diagnostics.states.length, 24);
  NodeAssertStrict.equal(diagnostics.omitted, 7);
});

NodeTest.test("classifies only an exhausted held Live window as a Codex provider/product gap", () => {
  const failure = new Error("Condition: exact file never appeared in a Live agent diff with AGENT_MARKER.");
  NodeAssertStrict.match(classifyLiveDiffFailure("agent-live-diff", failure), /Codex provider\/product gap/);
  NodeAssertStrict.equal(classifyLiveDiffFailure("agent-live-diff", new Error("socket closed")), undefined);
  NodeAssertStrict.equal(classifyLiveDiffFailure("settled", failure), undefined);
});

NodeTest.test("records installed Codex trace evidence and distinguishes an absent diff notification", () => {
  const threadId = "mcode-thread";
  const log = [
    `info: Codex trace ingest {"method":"turn/started","raw":{"threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
    `info: Codex trace ingest {"method":"item/started","raw":{"itemType":"fileChange","threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
    `info: Codex trace ingest {"method":"turn/completed","raw":{"threadId":"native-thread","turnId":"native-turn"},"threadId":"${threadId}"}`,
  ].join("\n");
  const trace = captureCodexTraceEvidence("root", threadId, { readFile: () => log, execute: () => "codex-cli 0.153.4\n" });
  NodeAssertStrict.equal(trace.installedVersion, "codex-cli 0.153.4");
  NodeAssertStrict.deepEqual(trace.nativeThreadIds, ["native-thread"]);
  NodeAssertStrict.deepEqual(trace.nativeTurnIds, ["native-turn"]);
  NodeAssertStrict.equal(trace.fileChangeSeen, true);
  NodeAssertStrict.equal(trace.turnDiffUpdatedSeen, false);
  NodeAssertStrict.match(trace.emitCodexTurnDiff, /not evaluated/);
});

NodeTest.test("rejects external-marker attribution in the public agent patch", () => {
  NodeAssertStrict.doesNotThrow(() => assertPatchAttribution("AGENT_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"));
  NodeAssertStrict.throws(() => assertPatchAttribution("AGENT_MARKER\nEXTERNAL_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"), /exclusively attribute/);
});

NodeTest.test("rejects incomplete Review and disk evidence", () => {
  const result = { comparison: { turnDiff: { id: "comparison", phase: "settled", source: "native", fidelity: "agent" } }, file: { path: "target.txt" }, patch: "AGENT_MARKER\nEXTERNAL_MARKER" };
  const rendered = { rows: 1, spinners: 0, screenshot: "proof.png", filePath: "target.txt", fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  NodeAssertStrict.doesNotThrow(() => assertObservation(rendered, result, "settled"));
  NodeAssertStrict.throws(() => assertObservation({ ...rendered, rows: 2 }, result, "settled"), /incomplete/);
  NodeAssertStrict.throws(() => assertObservation({ ...rendered, spinners: 1 }, result, "settled"), /incomplete/);
  NodeAssertStrict.throws(() => assertObservation(rendered, { ...result, comparison: { turnDiff: { phase: "settled" } } }, "settled"), /incomplete/);
  NodeAssertStrict.throws(() => assertObservation({ ...rendered, patch: null }, result, "settled"), /incomplete/);
  NodeAssertStrict.throws(() => assertObservation({ ...rendered, fileText: "AGENT_MARKER\nEXTERNAL_MARKER" }, result, "settled"), /incomplete/);
  NodeAssertStrict.throws(() => assertObservation({ ...rendered, sourceLabel: null }, result, "settled"), /incomplete/);
  NodeAssertStrict.doesNotThrow(() => assertDiskContent("AGENT_MARKER\nEXTERNAL_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"));
  NodeAssertStrict.throws(() => assertDiskContent("AGENT_MARKER", "AGENT_MARKER", "EXTERNAL_MARKER"), /disk did not retain/);
});

NodeTest.test("records valid Live Review observations without settled Review invariants", async () => {
  const receipt = { renderedEvidence: [] };
  const result = { comparison: { turnDiff: { id: "live", phase: "live", source: "native", fidelity: "agent" } }, file: { path: "target.txt" }, patch: "AGENT_MARKER" };
  const rendered = { stopVisible: true, screenshot: "live.png", filePath: "target.txt", fileText: "AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" };
  await captureLiveObservation({}, receipt, result, async () => rendered);
  NodeAssertStrict.equal(receipt.renderedEvidence[0].state, "live");
  await NodeAssertStrict.rejects(captureLiveObservation({}, { renderedEvidence: [] }, result, async () => ({ ...rendered, stopVisible: false })), /Live Review evidence was incomplete/);
  NodeAssertStrict.throws(() => assertLiveObservation({ ...rendered, stopVisible: false }, result), /Live Review evidence was incomplete/);
  NodeAssertStrict.throws(() => assertLiveObservation({ ...rendered, patch: null }, result), /Live Review evidence was incomplete/);
});

NodeTest.test("reads only the exact Review file and source label", async () => {
  const page = reviewPage({ filePath: "target.txt", fileText: "target.txt AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssertStrict.deepEqual(await readRenderedReview(page, "target.txt"), { filePath: "target.txt", fileText: "target.txt AGENT_MARKER", patch: "AGENT_MARKER", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  const wrongPatchPage = reviewPage({ filePath: "target.txt", fileText: "target.txt", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssertStrict.equal((await readRenderedReview(wrongPatchPage, "target.txt")).patch, null);
  const missingLabelPage = reviewPage({ filePath: "target.txt", fileText: "target.txt AGENT_MARKER", sourceLabel: null, source: null, fidelity: null });
  NodeAssertStrict.equal((await readRenderedReview(missingLabelPage, "target.txt")).sourceLabel, null);
  const transcriptOnlyMarker = reviewPage({ filePath: "other.txt", fileText: "other.txt", sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
  NodeAssertStrict.deepEqual(await readRenderedReview(transcriptOnlyMarker, "target.txt"), { filePath: null, fileText: null, patch: null, sourceLabel: "Agent changes", source: "native", fidelity: "agent" });
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
  NodeAssertStrict.deepEqual(Object.keys(receipt.comparison), ["electron-settled", "web-settled", "web-reopened", "web-reloaded", "electron-reconnected"]);
  NodeAssertStrict.equal(calls.filter(({ method }) => method === "turnDiff.getComparison").length, 5);
  NodeAssertStrict.equal(calls.filter(({ method }) => method === "turnDiff.getFileDiff").length, 5);
});

NodeTest.test("rejects a mixed-marker settled public patch", async () => {
  const socket = { rpc: async (method) => method === "turnDiff.getComparison"
    ? { turnDiff: { id: "comparison", phase: "settled", source: "native", fidelity: "agent" }, files: [{ path: "target.txt" }] }
    : "AGENT_MARKER\nEXTERNAL_MARKER" };
  await NodeAssertStrict.rejects(readSettledPublicComparison(socket, "thread", "target.txt"), /exclusively attribute/);
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
    NodeAssertStrict.equal(resolved.commit, "abc123");
    NodeAssertStrict.equal(resolved.command, "bunx --no-install opensrc path openai/codex");
    NodeAssertStrict.deepEqual(calls[0].args, ["x", "--no-install", "opensrc", "path", "openai/codex"]);
    NodeAssertStrict.equal(calls[0].options.env.OPENSRC_HOME, NodePath.join(root, ".opensrc"));
    NodeFS.rmSync(NodePath.join(root, ".opensrc", "sources.json"));
    const noCommitCalls = [];
    const noCommit = resolveUpstreamCodex(root, (command, args) => { noCommitCalls.push({ command, args }); if (command === "bun.exe") return "cached-codex\n"; if (args.includes("rev-parse")) throw new Error("cache metadata unavailable"); if (args[0] === "ls-remote") return "0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n"; throw new Error("unexpected command"); }, "bun.exe", () => "2026-09-08T12:00:00.000Z");
    NodeAssertStrict.equal(noCommit.resolverOutput, "cached-codex");
    NodeAssertStrict.equal(noCommit.commit, "0123456789abcdef0123456789abcdef01234567");
    NodeAssertStrict.equal(noCommit.cacheCommit, null);
    NodeAssertStrict.equal(noCommit.commitProvenance, "git ls-remote https://github.com/openai/codex.git refs/heads/main");
    NodeAssertStrict.equal(noCommit.commitResolvedAt, "2026-09-08T12:00:00.000Z");
    NodeAssertStrict.equal(noCommit.sourceVersion, null);
    NodeAssertStrict.equal(noCommit.auditBlocker, undefined);
    NodeAssertStrict.deepEqual(noCommitCalls.map(({ command }) => command), ["bun.exe", "git", "git"]);
    const blocked = resolveUpstreamCodex(root, (command, args) => {
      if (command === "bun.exe") return "cached-codex\n";
      if (args.includes("rev-parse")) throw new Error("cache metadata unavailable");
      throw new Error("remote lookup unavailable");
    }, "bun.exe");
    NodeAssertStrict.equal(blocked.commit, null);
    NodeAssertStrict.match(blocked.auditBlocker, /cache metadata unavailable/);
    NodeAssertStrict.match(blocked.auditBlocker, /remote lookup unavailable/);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("requires separate web and Electron browser objects", () => {
  const browser = {};
  NodeAssertStrict.throws(() => assertSeparateClients({ browser, context: {} }, { session: { browser, context: {} } }), /separate browser clients/);
  NodeAssertStrict.doesNotThrow(() => assertSeparateClients({ browser: {}, context: {} }, { session: { browser: {}, context: {} } }));
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
    NodeAssertStrict.deepEqual(calls, [{ method: "thread.delete", params: { threadId: "only-thread", cleanupWorktree: false } }]);
    NodeAssertStrict.equal(NodeFS.existsSync(file), false);
    NodeAssertStrict.match(result.failures.join("\n"), /socket: close failed/);
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
  NodeAssertStrict.deepEqual(calls, ["web", "desktop", "workspace", "rm:fixture/target.txt", "rm:fixture", "socket"]);
  NodeAssertStrict.deepEqual(result.failures, []);
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
  NodeAssertStrict.deepEqual(calls, ["web:thread.list:undefined", "web:thread.delete:web-thread", "electron:thread.list:undefined", "electron:thread.delete:electron-thread", "electron:workspace.list:undefined", "workspace:electron-workspace:present", "web:workspace.list:undefined", "workspace:web-workspace:present"]);
  NodeAssertStrict.deepEqual(result.failures, []);
});

NodeTest.test("stops an owned partial Electron session but preserves a reused session", async () => {
  let stopped = 0;
  const deps = { startElectron: async () => {}, stopElectron: () => { stopped += 1; }, sessionHelper: { connectElectronSession: async () => { throw new Error("connect failed"); } } };
  await NodeAssertStrict.rejects(openDesktop("root", {}, {}, { ...deps, sessionExists: () => false }), /connect failed/);
  NodeAssertStrict.equal(stopped, 1);
  await NodeAssertStrict.rejects(openDesktop("root", {}, {}, { ...deps, sessionExists: () => true }), /connect failed/);
  NodeAssertStrict.equal(stopped, 1);
});

NodeTest.test("propagates false and failed workspace cleanup", async () => {
  const receipt = { run: { ownedWorkspaceId: "workspace", threadId: null, ownedFile: null } };
  const base = { socket: { close: async () => {} }, io: NodeFS.promises, receipt, repoRoot: process.cwd() };
  const falseResult = await cleanupOwned({ ...base, deleteWorkspace: async ({ report }) => { report.cleanup.workspaceDeleted = false; } });
  NodeAssertStrict.match(falseResult.failures.join("\n"), /workspace deletion was not confirmed/);
  const errorResult = await cleanupOwned({ ...base, deleteWorkspace: async ({ report }) => { report.cleanup.workspaceDeleted = false; report.cleanup.failure = "rpc failed"; } });
  NodeAssertStrict.match(errorResult.failures.join("\n"), /workspace: rpc failed/);
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
    NodeAssertStrict.equal(calls, 0);
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
    NodeAssertStrict.deepEqual(result, { receipts: 1, cleanup: "complete" });
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
    NodeAssertStrict.equal(NodeFS.existsSync(path), true);
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(root, "[path]")), false);
    NodeAssertStrict.equal(NodeFS.existsSync(fixtureDirectory), false);
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
    NodeAssertStrict.equal(calls, 0);
    NodeAssertStrict.equal(NodeFS.existsSync(outside), true);
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("writes a redacted receipt when orchestration fails before dispatch", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-completeness-receipt-"));
  try {
    await NodeAssertStrict.rejects(proof(root, { health: async () => { throw new Error("health failed"); } }), /health failed/);
    const receipt = NodeFS.readdirSync(NodePath.join(root, ".dev", "verification", "provider-completeness"), { recursive: true }).find((path) => path.endsWith("receipt.json"));
    NodeAssertStrict.ok(receipt);
    const contents = NodeFS.readFileSync(NodePath.join(root, ".dev", "verification", "provider-completeness", receipt), "utf8");
    NodeAssertStrict.match(contents, /"phase": "cleanup"/);
    NodeAssertStrict.match(contents, /"phase": "health"/);
    NodeAssertStrict.match(contents, /"complete": true/);
    NodeAssertStrict.doesNotMatch(contents, /[A-Za-z]:\\\\/);
    for (const field of ["applicationCommit", "upstreamCodex", "provider", "model", "baseline", "publicComparison", "fetchedPatch", "renderedEvidence", "disk", "cleanup"]) NodeAssertStrict.match(contents, new RegExp(`"${field}"`));
  } finally { NodeFS.rmSync(root, { recursive: true, force: true }); }
});
