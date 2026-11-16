import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { Database } from "bun:sqlite";
import { aggregate, analyzeRecord, percentile, parseLogLines, classifyRecords, summarizeRecords } from "../../perf/app-startup/analysis.mjs";
import { buildFixture, donorCaps } from "../../perf/app-startup/fixture.mjs";
import { assertPackagedExecutable, cleanupStaleRoots, launchEnvironment, launchFailure, launchOnce, launchPlan, waitForRecord } from "../../perf/app-startup/runtime.mjs";
import { buildReceipt } from "../../perf/app-startup/receipt.mjs";

const assert = NodeAssertStrict.default;

function record(offset = 0) {
  return {
    version: 1,
    launchId: NodeCrypto.randomUUID(),
    appVersion: "0.13.0",
    t0: offset,
    bootAt: 0,
    firstSinceBoot: false,
    serverMode: "spawned",
    main: { mainModuleStart: offset + 20, serverSpawned: offset + 100, windowCreated: offset + 50, serverHealthy: offset + 1130 },
    renderer: {
      scriptsEvaluated: offset + 200,
      urlReceived: offset + 1130,
      workspaceListAnswered: offset + 1200,
      threadListAnswered: offset + 1250,
      settingsAnswered: offset + 1230,
      usable: offset + 1400,
    },
    serverTelemetry: {
      launchId: NodeCrypto.randomUUID(),
      migrated: false,
      marks: [
        { name: "entry", at: offset + 180 },
        { name: "database", at: offset + 600 },
        { name: "listen", at: offset + 1100 },
      ],
      listenAt: offset + 1100,
      windowEndAt: offset + 11400,
      rpcs: [],
      unansweredRpcs: [],
      rpcsDropped: 0,
      tasks: [],
      stalls: [],
      memory: [],
    },
    serverTelemetryError: null,
    writtenBecause: "window-ended",
  };
}

NodeTest.test("segments and missing marks remain independently measured", () => {
  const input = record();
  assert.deepEqual(analyzeRecord(input).segments, { A: 100, B: 1000, C: 30, D: 150, E: 120, F: 150, total: 1400 });
  input.t0 = null;
  delete input.renderer.settingsAnswered;
  assert.deepEqual(analyzeRecord(input).segments, { A: null, B: 1000, C: 30, D: 150, E: null, F: null, total: null });
});

NodeTest.test("server steps start at spawn so process start and module load are measured", () => {
  const input = record();
  assert.deepEqual(analyzeRecord(input).substeps, { entry: 80, database: 420, listen: 500 });
  delete input.main.serverSpawned;
  assert.deepEqual(analyzeRecord(input).substeps, { database: 420, listen: 500 });
});

NodeTest.test("repeated server marks add up to one step", () => {
  const input = record();
  input.serverTelemetry.marks.splice(2, 0, { name: "checkpoint interrupted", at: 700 },
    { name: "checkpoint interrupted", at: 950 });
  assert.deepEqual(analyzeRecord(input).substeps, {
    entry: 80,
    database: 420,
    "checkpoint interrupted": 350,
    listen: 150,
  });
});

NodeTest.test("nearest rank selects fifth and ninth of ten values", () => {
  const values = [10, 4, 8, 2, 6, 1, 9, 3, 7, 5];
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.9), 9);
  assert.equal(percentile([], 0.9), null);
});

NodeTest.test("settled uses strict 250ms threshold and the ten-second overlap boundary", () => {
  const input = record();
  input.serverTelemetry.stalls = [{ startAt: 11399, endAt: 11649 }];
  assert.equal(analyzeRecord(input).settled, true);
  input.serverTelemetry.stalls[0].endAt++;
  assert.equal(analyzeRecord(input).settled, false);
  input.serverTelemetry.stalls = [{ startAt: 11400, endAt: 11651 }, { startAt: 0, endAt: 1400 }];
  assert.equal(analyzeRecord(input).settled, true);
  input.serverTelemetry.windowEndAt = 11399;
  assert.equal(analyzeRecord(input).settled, null);
});

NodeTest.test("stall candidates require positive interval overlap, including unfinished tasks", () => {
  const input = record();
  input.serverTelemetry.stalls = [{ startAt: 500, endAt: 600 }, { startAt: 700, endAt: 799 }];
  input.serverTelemetry.rpcs = [
    { method: "endsAtStart", startAt: 400, durationMs: 100, responseBytes: 1 },
    { method: "overlap", startAt: 499, durationMs: 2, responseBytes: 1 },
    { method: "startsAtEnd", startAt: 600, durationMs: 10, responseBytes: 1 },
    { method: "emptyInterval", startAt: 550, durationMs: 0, responseBytes: 1 },
  ];
  input.serverTelemetry.tasks = [{ name: "unfinished", startAt: 550, endAt: null }, { name: "ended", startAt: 0, endAt: 500 }];
  assert.deepEqual(analyzeRecord(input).stallAttribution, [{ startAfterT0Ms: 500, durationMs: 100, beforeUsable: true,
    candidateRpcs: ["overlap"], candidateTasks: ["unfinished"] }]);
});

NodeTest.test("RPC overflow past the cap is counted, and a launch without server data adds nothing", () => {
  const full = record();
  full.serverTelemetry.rpcs = [{ method: "workspace.list", startAt: 1200, durationMs: 5, responseBytes: 10 }];
  full.serverTelemetry.rpcsDropped = 3;
  const lost = record();
  lost.serverTelemetry = null;
  const summary = aggregate([full, record(), lost].map(analyzeRecord));
  assert.equal(summary.rpcsAnsweredMax, 1);
  assert.equal(summary.rpcsDropped, 3);
});

NodeTest.test("receipt gives each variant its own headed table in whole milliseconds", () => {
  const fractional = record(0.25);
  fractional.serverTelemetry.stalls = [{ startAt: 1300.5, endAt: 1450.75 }];
  const rows = [analyzeRecord(fractional)];
  const donor = { tables: { threads: 2 }, worktreeThreads: 0, openOrDraftPrThreads: 0, fileBytes: 1, freelistCount: 0 };
  const { markdown } = buildReceipt({ A: rows, B: rows }, { donor });
  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    if (line.startsWith("|") && !lines[index - 1].startsWith("|")) assert.match(lines[index + 1], /^\| --- /, line);
  });
  assert.equal(lines.filter((line) => line.startsWith("| Segment |")).length, 2);
  assert.doesNotMatch(markdown, /\d\.\d/);
});

NodeTest.test("records distinguish normal, reused, migrated, first boot, failed and unknown", () => {
  const records = Array.from({ length: 7 }, (_, i) => record(i * 2000));
  records[0].firstSinceBoot = null;
  records[2].serverMode = "reused";
  records[3].serverTelemetry.migrated = true;
  records[4].firstSinceBoot = true;
  records[6].writtenBecause = "startup-failed";
  records[6].serverTelemetry = null;
  assert.deepEqual(classifyRecords(records).map((row) => row.classification),
    ["unknown", "normal", "reused", "migrated", "first-since-boot", "normal", "startup-failed"]);
});

NodeTest.test("records widen beyond seven days for ten measured normal launches", () => {
  const day = 86_400_000;
  const records = Array.from({ length: 13 }, (_, i) => record(i * day));
  records[11].t0 = null;
  records[11].main.mainModuleStart = 11 * day;
  const summary = summarizeRecords(records, 7, 13 * day);
  assert.equal(summary.normalMeasured, 10);
  assert.equal(summary.widened, true);
  assert.equal(summary.days, 11);
  assert.equal(summary.p90, 1400);
  assert.equal(summary.shareSettled, 1);
  assert.equal(summary.passed, true);
  assert.equal(summarizeRecords(records.slice(0, 3), 7, 13 * day).normalMeasured, 3);
});

NodeTest.test("malformed launch candidates are reported and excluded by the contract schema", () => {
  const valid = { message: "Launch record", ...record() };
  const lines = [
    JSON.stringify(valid),
    JSON.stringify({ ...valid, t0: "wrong" }),
    '{"message":"Launch record",broken',
    '{"message":"unrelated"}',
  ];
  const parsed = parseLogLines(lines.join("\n"));
  assert.equal(parsed.invalid, 2);
  assert.equal(parsed.records.length, 1);
  assert.equal(analyzeRecord(parsed.records[0]).segments.total, 1400);
});

NodeTest.test("stale roots delete dead owners and preserve live owners", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-roots-"));
  try {
    const dead = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
    const live = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
    NodeFS.mkdirSync(dead);
    NodeFS.mkdirSync(live);
    NodeFS.writeFileSync(NodePath.join(dead, "harness.pid"), "2147483647");
    NodeFS.writeFileSync(NodePath.join(live, "harness.pid"), String(process.pid));
    const reports = [];
    cleanupStaleRoots(parent, (message) => reports.push(message));
    assert.equal(NodeFS.existsSync(dead), false);
    assert.equal(NodeFS.existsSync(live), true);
    assert.deepEqual(reports, []);
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

NodeTest.test("stale roots stay, and are reported, while a recorded process still runs", (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-roots-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const staleRoot = (desktopPid, lock) => {
    const root = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
    const launch = NodePath.join(root, "normal-current-0");
    NodeFS.mkdirSync(NodePath.join(launch, "data"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "harness.pid"), "2147483647");
    NodeFS.writeFileSync(NodePath.join(launch, "desktop.pid"), desktopPid);
    NodeFS.writeFileSync(NodePath.join(launch, "data", "server.lock"), lock);
    return root;
  };
  const exited = staleRoot("2147483647", JSON.stringify({ pid: 2147483646 }));
  const liveDesktop = staleRoot(String(process.pid), JSON.stringify({ pid: 2147483646 }));
  const liveServer = staleRoot("2147483647", JSON.stringify({ pid: process.pid }));
  const unreadableLock = staleRoot("2147483647", "{\"pid\":");
  const nullLock = staleRoot("2147483647", "null");
  const unrecordedDesktop = staleRoot("", JSON.stringify({ pid: 2147483646 }));
  const reports = [];
  cleanupStaleRoots(parent, (message) => reports.push(message));
  for (const root of [exited, unreadableLock, nullLock, unrecordedDesktop]) assert.equal(NodeFS.existsSync(root), false);
  for (const root of [liveDesktop, liveServer]) assert.equal(NodeFS.existsSync(root), true);
  const desktop = NodePath.join("normal-current-0", "desktop.pid");
  const server = NodePath.join("normal-current-0", "data", "server.lock");
  assert.deepEqual(reports.sort(), [
    `Kept stale root ${liveDesktop}: ${desktop} names process ${process.pid}, which is still running`,
    `Kept stale root ${liveServer}: ${server} names process ${process.pid}, which is still running`,
  ].sort());
});

NodeTest.test("a stale root another harness takes during cleanup is skipped", (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-race-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const roots = [1, 2].map((index) => {
    const root = NodePath.join(parent, `run-00000000-0000-0000-0000-00000000000${index}`);
    NodeFS.mkdirSync(root);
    NodeFS.writeFileSync(NodePath.join(root, "harness.pid"), "2147483647");
    return root;
  });
  const reports = [];
  cleanupStaleRoots(parent, (message) => reports.push(message), (claimed) => {
    NodeFS.rmSync(claimed, { recursive: true });
    // Model another harness claiming the other root after we list it.
    const other = roots.find((root) => NodeFS.existsSync(root));
    if (other) NodeFS.renameSync(other, `${other}.removing`);
  });
  assert.deepEqual(reports, []);
  assert.equal(NodeFS.readdirSync(parent).length, 1);
});

NodeTest.test("a stale root that fails to delete after its rename is retried by the next cleanup", (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-locked-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const root = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(root);
  NodeFS.writeFileSync(NodePath.join(root, "harness.pid"), "2147483647");
  NodeFS.writeFileSync(NodePath.join(root, "A.db"), "fixture");
  const reports = [];
  cleanupStaleRoots(parent, (message) => reports.push(message), () => {
    throw Object.assign(new Error("locked"), { code: "EBUSY" });
  });
  assert.deepEqual(reports, [`Could not finish deleting ${root}.removing (EBUSY); the next run retries`]);
  assert.equal(NodeFS.existsSync(`${root}.removing`), true);
  cleanupStaleRoots(parent);
  assert.deepEqual(NodeFS.readdirSync(parent), []);
});

NodeTest.test("a stale root that a process holds open stays whole and is reported", {
  skip: process.platform !== "win32" && "Windows refuses to rename a held directory; other platforms do not",
}, async (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-held-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const root = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
  const data = NodePath.join(root, "A-candidate-1", "data");
  NodeFS.mkdirSync(data, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "harness.pid"), "2147483647");
  NodeFS.writeFileSync(NodePath.join(root, "A-candidate-1", "desktop.pid"), "2147483647");
  // Model a server that outlived Desktop before server.lock, still holding its inherited stderr log.
  const log = NodeFS.openSync(NodePath.join(data, "server-stderr.log"), "a");
  const server = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", log] });
  NodeFS.closeSync(log);
  t.after(() => server.kill());
  const reports = [];
  cleanupStaleRoots(parent, (message) => reports.push(message));
  assert.deepEqual(reports, [`Kept stale root ${root}: a process holds a file inside it (EPERM)`]);
  assert.equal(NodeFS.existsSync(NodePath.join(data, "server-stderr.log")), true);
  server.kill();
  await NodeEvents.once(server, "exit");
  cleanupStaleRoots(parent);
  assert.deepEqual(NodeFS.readdirSync(parent), []);
});

NodeTest.test("a harness that dies between starting Desktop and recording its PID leaves a root kept until Desktop exits", {
  skip: process.platform !== "win32" && "Windows refuses to rename a held directory; other platforms do not",
}, async (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-spawn-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const run = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(run);
  NodeFS.writeFileSync(NodePath.join(run, "harness.pid"), "2147483647");
  const fixture = NodePath.join(parent, "fixture.db");
  NodeFS.writeFileSync(fixture, "");
  let desktop;
  const spawn = (_exe, _args, options) => {
    desktop = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    throw new Error("harness died before recording the Desktop PID");
  };
  t.after(() => desktop?.kill());
  const root = NodePath.join(run, "A-candidate-1");
  await assert.rejects(
    launchOnce({ exe: process.execPath, fixture, root, signal: new AbortController().signal, spawn }),
    /harness died/,
  );
  const reports = [];
  cleanupStaleRoots(parent, (message) => reports.push(message));
  assert.deepEqual(reports, [`Kept stale root ${run}: a process holds a file inside it (EPERM)`]);
  assert.equal(NodeFS.existsSync(NodePath.join(root, "data", "mcode.db")), true);
  desktop.kill();
  await NodeEvents.once(desktop, "exit");
  cleanupStaleRoots(parent);
  assert.deepEqual(NodeFS.readdirSync(parent), ["fixture.db"]);
});

NodeTest.test("a failed PID record after spawn still stops Desktop before its root is deleted", async (t) => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-pid-"));
  t.after(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
  const fixture = NodePath.join(parent, "fixture.db");
  NodeFS.writeFileSync(fixture, "");
  const root = NodePath.join(parent, "A-candidate-1");
  let desktop;
  const spawn = (_exe, _args, options) => {
    // Model a PID write failing after Desktop starts.
    NodeFS.mkdirSync(NodePath.join(root, "desktop.pid"));
    desktop = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    return desktop;
  };
  t.after(() => desktop?.kill());
  const result = await launchOnce({ exe: process.execPath, fixture, root, signal: new AbortController().signal, spawn });
  assert.equal(result.failed, true);
  assert.throws(() => process.kill(desktop.pid, 0), { code: "ESRCH" });
  assert.equal(NodeFS.existsSync(root), false);
});

NodeTest.test("synthetic donor caps retain stopped families and fixture removes filesystem bindings", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-fixture-"));
  const source = NodePath.join(root, "donor.db");
  try {
    const { openDatabase } = await import("../../../apps/server/src/runtime/persistence/sqlite/database.ts");
    openDatabase({ dbPath: source }).close(true);
    const donor = new Database(source);
    try {
      for (const id of ["a", "b"]) {
        donor.run(
          `INSERT INTO workspaces (id, name, path, icon_path, created_at, updated_at)
           VALUES (?, ?, ?, '/donor/icon', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          [id, id, `/donor/${id}`],
        );
      }
      for (const [id, workspace, parent] of [["a1", "a", null], ["a2", "a", "a1"], ["a3", "a", null], ["b1", "b", null]]) {
        donor.run(
          `INSERT INTO threads (id, workspace_id, title, parent_thread_id, worktree_path, branch, created_at, updated_at)
           VALUES (?, ?, ?, ?, '/donor/worktree', 'main', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          [id, workspace, id, parent],
        );
      }
      assert.deepEqual(donorCaps(donor), { maxWorkspaces: 2, maxFamiliesPerWorkspace: 2 });
    } finally {
      donor.close(true);
    }
    const fixtureRepo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(fixtureRepo);
    NodeChildProcess.execFileSync("git", ["init", "-q", fixtureRepo]);
    NodeFS.writeFileSync(NodePath.join(fixtureRepo, "fixture.txt"), "fixture");
    NodeChildProcess.execFileSync("git", ["add", "."], { cwd: fixtureRepo });
    const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
    NodeChildProcess.execFileSync("git", [...identity, "commit", "-qm", "fixture"], { cwd: fixtureRepo });
    const runRoot = NodePath.join(root, "run");
    NodeFS.mkdirSync(runRoot);
    const target = NodePath.join(runRoot, "A.db");
    buildFixture(source, target, runRoot, fixtureRepo);
    const copy = new Database(target, { readonly: true });
    try {
      const rows = copy.query("SELECT path, icon_path FROM workspaces ORDER BY id").all();
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].path, rows[1].path);
      for (const row of rows) {
        assert.equal(NodePath.dirname(row.path), runRoot);
        assert.equal(NodeFS.readFileSync(NodePath.join(row.path, "fixture.txt"), "utf8"), "fixture");
        assert.equal(row.icon_path, null);
      }
      assert.equal(copy.query("SELECT COUNT(*) AS n FROM threads WHERE worktree_path IS NOT NULL").get().n, 0);
      assert.equal(copy.query("SELECT COUNT(*) AS n FROM threads").get().n, 4);
    } finally {
      copy.close(true);
    }
    const prepared = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.resolve("apps/server/scripts/prepare-startup-cutoff-turn.ts"), target],
      { env: { ...process.env, MCODE_DATA_DIR: runRoot }, encoding: "utf8" },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    const cutoff = new Database(target, { readonly: true });
    try {
      assert.equal(cutoff.query("SELECT COUNT(*) AS n FROM canonical_agent_turns WHERE status = 'Running'").get().n, 1);
    } finally {
      cutoff.close(true);
    }
    const journals = NodeFS.readdirSync(`${target}.recovery/parent-assistant-text`);
    assert.equal(journals.length, 1);
    assert.equal(NodeFS.existsSync(NodePath.join(runRoot, "logs")), false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryLogs(t) {
  const data = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-wait-"));
  t.after(() => NodeFS.rmSync(data, { recursive: true, force: true }));
  NodeFS.mkdirSync(NodePath.join(data, "logs"));
  return { data, log: NodePath.join(data, "logs/mcode.log.2026-11-11") };
}

function waitOptions(data, overrides = {}) {
  return { data, child: { exitCode: null, signalCode: null }, signal: new AbortController().signal, timeoutMs: 2000, ...overrides };
}

function logLine(input = record()) {
  return JSON.stringify({ message: "Launch record", ...input }) + "\n";
}

NodeTest.test("wait rejects two complete records", async (t) => {
  const { data, log } = temporaryLogs(t);
  NodeFS.writeFileSync(log, logLine() + logLine());
  const result = await waitForRecord(waitOptions(data));
  assert.deepEqual(result, { failed: true, invalidRecords: 0 });
});

NodeTest.test("wait rejects a malformed complete launch line", async (t) => {
  const { data, log } = temporaryLogs(t);
  NodeFS.writeFileSync(log, '{"message":"Launch record",broken\n');
  assert.deepEqual(await waitForRecord(waitOptions(data)), { failed: true, invalidRecords: 1 });
});

NodeTest.test("wait ignores a partial last line until a later poll reads its newline", async (t) => {
  const { data, log } = temporaryLogs(t);
  const line = logLine();
  NodeFS.writeFileSync(log, line.slice(0, 30));
  const timer = setTimeout(() => NodeFS.appendFileSync(log, line.slice(30)), 20);
  t.after(() => clearTimeout(timer));
  const result = await waitForRecord(waitOptions(data));
  assert.equal(result.failed, false);
  assert.equal(result.invalidRecords, 0);
  assert.equal(result.segments.total, 1400);
});

const failureCases = [
  ["server reused", (input) => { input.serverMode = "reused"; input.writtenBecause = "quit"; }],
  ["written because quit", (input) => { input.writtenBecause = "quit"; input.serverTelemetry = null; }],
  ["no server window: http-status", (input) => {
    input.serverTelemetry = null;
    input.serverTelemetryError = "http-status";
    delete input.renderer.usable;
  }],
  ["no usable frame", (input) => { delete input.renderer.usable; input.serverTelemetry.windowEndAt = 0; }],
  ["server window ended before usable + 10 s", (input) => {
    input.serverTelemetry.windowEndAt--;
    input.serverTelemetry.rpcsDropped = 2;
  }],
  ["window dropped 2 requests", (input) => { input.serverTelemetry.rpcsDropped = 2; }],
];

for (const [reason, change] of failureCases) {
  NodeTest.test(`launch failure: ${reason}`, async (t) => {
    const input = record();
    change(input);
    assert.equal(launchFailure(input), reason);
    const { data, log } = temporaryLogs(t);
    NodeFS.writeFileSync(log, logLine(input));
    assert.equal((await waitForRecord(waitOptions(data))).failed, true);
  });
}

NodeTest.test("wait accepts a complete launch at the settle boundary", async (t) => {
  assert.equal(launchFailure(record()), null);
  const { data, log } = temporaryLogs(t);
  NodeFS.writeFileSync(log, logLine());
  const result = await waitForRecord(waitOptions(data));
  assert.equal(result.failed, false);
  assert.equal(result.settled, true);
  assert.equal(result.segments.total, 1400);
});

NodeTest.test("wait throws when Desktop exits before writing", async (t) => {
  const { data } = temporaryLogs(t);
  await assert.rejects(waitForRecord(waitOptions(data, { child: { exitCode: 1, signalCode: null } })), /Desktop exited before launch record/);
});

NodeTest.test("wait throws the abort reason during polling", async (t) => {
  const { data } = temporaryLogs(t);
  const controller = new AbortController();
  const reason = new Error("test interrupted");
  const timer = setTimeout(() => controller.abort(reason), 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(waitForRecord(waitOptions(data, { signal: controller.signal })), (error) => error === reason);
});

NodeTest.test("wait times out with a short deadline", async (t) => {
  const { data } = temporaryLogs(t);
  await assert.rejects(waitForRecord(waitOptions(data, { timeoutMs: 1 })), /Launch record timed out/);
});

NodeTest.test("failed launches count but cannot affect percentiles, settle counts or RPC figures", () => {
  const failed = analyzeRecord(record());
  failed.failed = true;
  failed.segments.total = 1_000_000;
  failed.substeps.database = 1_000_000;
  failed.settled = false;
  failed.rpcs = { answered: 100, unanswered: 200, dropped: 300 };
  const summary = aggregate([analyzeRecord(record()), failed]);
  assert.equal(summary.launches, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.segments.total, { measured: 1, unmeasured: 0, p50: 1400, p90: 1400 });
  assert.deepEqual(summary.substeps.database, { measured: 1, unmeasured: 0, p50: 420, p90: 420 });
  assert.equal(summary.settled, 1);
  assert.equal(summary.unsettled, 0);
  assert.equal(summary.settledUnmeasured, 0);
  assert.equal(summary.rpcsAnsweredMax, 0);
  assert.equal(summary.rpcsUnansweredMax, 0);
  assert.equal(summary.rpcsDropped, 0);
});

NodeTest.test("child environment removes inherited app prefixes and NODE_ENV before setting harness paths", () => {
  const env = launchEnvironment({
    PATH: "system", NODE_ENV: "development", MCODE_FRONTEND_PERFORMANCE_MODE: "off",
    ELECTRON_RENDERER_URL: "http://localhost", VITE_CUSTOM: "override", MCODE_DATA_DIR: "live",
  }, { data: "fixture", userData: "isolated", capability: "token-file" });
  assert.deepEqual(env, {
    PATH: "system", MCODE_MODE: "desktop", MCODE_DATA_DIR: "fixture",
    MCODE_ELECTRON_USER_DATA_DIR: "isolated", MCODE_RELIABILITY_CAPABILITY_PATH: "token-file",
  });
});

NodeTest.test("executable boundary accepts release builds and refuses installed apps", () => {
  assert.doesNotThrow(() => assertPackagedExecutable("C:/src/checkout/apps/desktop/release/win-unpacked/Mcode.exe", "--exe"));
  for (const flag of ["--exe", "--baseline"]) {
    assert.throws(() => assertPackagedExecutable("C:/Users/someone/AppData/Local/Programs/Mcode/Mcode.exe", flag),
      new RegExp(`${flag} must be a packaged build under a release directory, not an installed app:`));
  }
});

NodeTest.test("invalid options exit 1 and name the rejected option", (t) => {
  const harness = NodePath.join(import.meta.dirname, "../../perf/app-startup-harness.mjs");
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-options-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  // A missing source and a missing release build make a regression fail at fixture build instead of reading live data.
  const safe = ["--source", NodePath.join(directory, "missing.db"), "--exe", NodePath.join(directory, "release/win-unpacked/Mcode.exe")];
  const cases = [
    [["--launches", "0"], "launches must be a positive integer"],
    [["--variants", "A,A"], "variants must be A, B or A,B"],
    [["--name", "../escape"], "Receipt name must contain only letters, digits, underscores and hyphens"],
    [["--baseline", "C:/Users/someone/AppData/Local/Programs/Mcode/Mcode.exe"], "--baseline must be a packaged build"],
  ];
  for (const [args, message] of cases) {
    const result = NodeChildProcess.spawnSync(process.execPath, [harness, ...safe, ...args], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, new RegExp(message));
  }
});

NodeTest.test("single build launch plan preserves interleaved variants and warm-up", () => {
  assert.deepEqual(launchPlan(["A", "B"], ["candidate"], 1), [
    { index: 0, variant: "A", build: "candidate" }, { index: 0, variant: "B", build: "candidate" },
    { index: 1, variant: "A", build: "candidate" }, { index: 1, variant: "B", build: "candidate" },
  ]);
});

NodeTest.test("comparison launch plan alternates build order for both variants", () => {
  assert.deepEqual(launchPlan(["A", "B"], ["baseline", "candidate"], 2), [
    { index: 0, variant: "A", build: "baseline" }, { index: 0, variant: "A", build: "candidate" },
    { index: 0, variant: "B", build: "baseline" }, { index: 0, variant: "B", build: "candidate" },
    { index: 1, variant: "A", build: "candidate" }, { index: 1, variant: "A", build: "baseline" },
    { index: 1, variant: "B", build: "candidate" }, { index: 1, variant: "B", build: "baseline" },
    { index: 2, variant: "A", build: "baseline" }, { index: 2, variant: "A", build: "candidate" },
    { index: 2, variant: "B", build: "baseline" }, { index: 2, variant: "B", build: "candidate" },
  ]);
});

NodeTest.test("unanswered RPCs overlap stalls until the window ends", () => {
  const input = record();
  input.serverTelemetry.stalls = [{ startAt: 500, endAt: 600 }];
  input.serverTelemetry.unansweredRpcs = [{ method: "pending", startAt: 450 }, { method: "later", startAt: 600 }];
  const analysis = analyzeRecord(input);
  assert.deepEqual(analysis.stallAttribution[0].candidateRpcs, ["pending"]);
  assert.deepEqual(analysis.rpcs, { answered: 0, unanswered: 2, dropped: 0 });
  assert.equal(aggregate([analysis]).rpcsUnansweredMax, 2);
});

NodeTest.test("records summary returns selected segment aggregates and stalls in launch order", () => {
  const first = record(0);
  const second = record(2000);
  first.serverTelemetry.stalls = [{ startAt: 500, endAt: 600 }];
  second.renderer.usable = 3500;
  const excluded = record(4000);
  excluded.serverMode = "reused";
  const summary = summarizeRecords([second, excluded, first], 7, 6000);
  assert.deepEqual(summary.aggregates.segments.total, { measured: 2, unmeasured: 0, p50: 1400, p90: 1500 });
  assert.deepEqual(summary.stalls, [[{
    startAfterT0Ms: 500, durationMs: 100, beforeUsable: true, candidateRpcs: [], candidateTasks: [],
  }], []]);
  assert.doesNotMatch(JSON.stringify(summary), /launchId|appVersion|0\.13\.0/);
});

NodeTest.test("receipt reports failed warm-ups separately and labels comparison builds", () => {
  const { receipt, markdown } = buildReceipt({ "A baseline": [analyzeRecord(record())], "A candidate": [] },
    { donor: { tables: {} } }, ["A candidate"]);
  assert.deepEqual(receipt.warmupFailed, ["A candidate"]);
  assert.equal(receipt.aggregates["A baseline"].launches, 1);
  assert.equal(receipt.aggregates["A candidate"].launches, 0);
  assert.match(markdown, /Warm-up failed: A candidate/);
  assert.match(markdown, /## Variant A, baseline/);
  assert.match(markdown, /## Variant A, candidate/);
});
