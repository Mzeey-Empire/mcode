import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  THREAD_COUNT,
  attributeControlLaunchToTurnCompletion,
  auditAgentEvents,
  createControlLaunch,
  expectedThreadTitle,
  launchActiveControlRequests,
  normalizeTerminalSessions,
  parseArguments,
  parseServerStallEntries,
  recordWorkerQueueSample,
  selectTerminalTransport,
  summarizeEventThroughput,
  summarizeLatency,
} from "./seven-thread-live-harness.mjs";

NodeTest.test("requires an explicit before or after run confirmation", () => {
  NodeAssertStrict.deepEqual(
    parseArguments(["--run", "--confirm-run", "--label", "before"]),
    { command: "run", label: "before" },
  );
  NodeAssertStrict.deepEqual(
    parseArguments(["--run", "--confirm-run", "--label", "after", "--stop-one"]),
    { command: "run", label: "after", stopOne: true },
  );
  NodeAssertStrict.throws(
    () => parseArguments(["--run", "--label", "before"]),
    /requires --confirm-run/,
  );
  NodeAssertStrict.throws(
    () => parseArguments(["--run", "--confirm-run", "--label", "later"]),
    /before or --label after/,
  );
  NodeAssertStrict.deepEqual(
    parseArguments(["--cleanup-receipt", ".dev/verification/performance/seven-thread-live/before-run/receipt.json", "--confirm-run"]),
    { command: "cleanup", receiptPath: ".dev/verification/performance/seven-thread-live/before-run/receipt.json" },
  );
  NodeAssertStrict.throws(
    () => parseArguments(["--cleanup-receipt", "receipt.json", "--confirm-cleanup"]),
    /requires --confirm-run/,
  );
  NodeAssertStrict.throws(
    () => parseArguments(["--cleanup-receipt", "receipt.json", "--confirm-run", "--stop-one"]),
    /cannot include run options/,
  );
});

NodeTest.test("uses a stable nearest-rank latency summary", () => {
  NodeAssertStrict.deepEqual(summarizeLatency([8, 1, 6, 2, 5]), {
    count: 5,
    p50Ms: 5,
    p95Ms: 8,
    maxMs: 8,
  });
  NodeAssertStrict.deepEqual(summarizeLatency([]), {
    count: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
});

NodeTest.test("flags public event sequence gaps, duplicates, and arrivals out of order", () => {
  const ordered = auditAgentEvents([
    { sequence: 1, type: "turnStarted" },
    { sequence: 2, type: "message" },
    { sequence: 3, type: "turnComplete" },
  ]);
  NodeAssertStrict.equal(ordered.sequenceValid, true);
  NodeAssertStrict.equal(ordered.completed, true);

  const damaged = auditAgentEvents([
    { sequence: 1, type: "turnStarted" },
    { sequence: 3, type: "message" },
    { sequence: 3, type: "turnComplete" },
    { sequence: 2, type: "message" },
  ]);
  NodeAssertStrict.deepEqual(damaged.missingSequences, []);
  NodeAssertStrict.deepEqual(damaged.duplicateSequences, [3]);
  NodeAssertStrict.equal(damaged.arrivalOrderViolations.length, 2);
  NodeAssertStrict.equal(damaged.sequenceValid, false);

  const empty = auditAgentEvents([]);
  NodeAssertStrict.equal(empty.sequenceValid, true);
  NodeAssertStrict.equal(empty.completed, false);
});

NodeTest.test("names each of the exact verifier-owned threads", () => {
  const names = Array.from({ length: THREAD_COUNT }, (_, index) => expectedThreadTitle("run-id", index + 1));
  NodeAssertStrict.equal(new Set(names).size, THREAD_COUNT);
  NodeAssertStrict.deepEqual(names.at(-1), "Seven-thread live performance run-id 7/7");
  NodeAssertStrict.equal(expectedThreadTitle("run-id", 3, THREAD_COUNT, "stop-one"), "Seven-thread Stop verification run-id 3/7");
});

NodeTest.test("uses the same legacy and modern Terminal lifecycle families as the web transport", () => {
  const legacy = selectTerminalTransport({ contractVersion: 0, backend: "legacy" });
  NodeAssertStrict.deepEqual(legacy, {
    kind: "legacy",
    createMethod: "terminal.create",
    listMethod: "terminal.listActive",
    closeMethod: "terminal.kill",
  });

  const modern = selectTerminalTransport({ contractVersion: 1, backend: "modern" });
  NodeAssertStrict.deepEqual(modern, {
    kind: "modern",
    createMethod: "terminal.session.create",
    listMethod: "terminal.session.list",
    closeMethod: "terminal.session.close",
  });
  NodeAssertStrict.deepEqual(normalizeTerminalSessions(modern, [{
    sessionId: "session-1",
    scope: { kind: "thread", workspaceId: "workspace-1", threadId: "thread-1" },
    state: "running",
  }]), [{ ptyId: "session-1", threadId: "thread-1", state: "running" }]);
});

NodeTest.test("launches control RPCs and all seven selected terminal creates before any response settles", () => {
  const calls = [];
  const socket = {
    rpc(method, _params, deadline) {
      calls.push({ method, deadline });
      return new Promise(() => {});
    },
  };
  const threads = Array.from({ length: THREAD_COUNT }, (_, index) => ({ id: `thread-${index + 1}`, ordinal: index + 1 }));
  const requests = launchActiveControlRequests({
    socket,
    metrics: {},
    workspaceId: "workspace-1",
    terminalTransport: selectTerminalTransport({ contractVersion: 0, backend: "legacy" }),
    threads,
    persistTerminal: () => NodeAssertStrict.fail("A pending terminal create must not persist before it settles"),
  });

  NodeAssertStrict.equal(requests.length, THREAD_COUNT + 2);
  NodeAssertStrict.deepEqual(calls.map((call) => call.method), [
    "provider.listModels",
    "terminal.capabilities",
    ...Array(THREAD_COUNT).fill("terminal.create"),
  ]);
  const earliestExpectedDeadline = Date.now() + 89_000;
  NodeAssertStrict.ok(calls.every((call) => Number.isFinite(call.deadline) && call.deadline >= earliestExpectedDeadline));
});

NodeTest.test("records event-derived control launch activity and completion timing without another active-count RPC", () => {
  const threads = [
    { ordinal: 1, startedAtMs: 100, completedAtMs: 110 },
    { ordinal: 2, startedAtMs: 110, completedAtMs: null },
    { ordinal: 3, startedAtMs: null, completedAtMs: null },
  ];
  const launch = createControlLaunch(threads, 120);
  NodeAssertStrict.deepEqual(launch.observedActiveThreadOrdinals, [2]);
  NodeAssertStrict.deepEqual(launch.completedThreadOrdinalsAtLaunch, [1]);
  NodeAssertStrict.equal(launch.inconclusive, false);

  threads[1].completedAtMs = 160;
  NodeAssertStrict.deepEqual(attributeControlLaunchToTurnCompletion(launch, threads), {
    ...launch,
    completionAfterLaunchMs: [
      { ordinal: 1, elapsedMs: -10 },
      { ordinal: 2, elapsedMs: 40 },
      { ordinal: 3, elapsedMs: null },
    ],
    firstTurnCompletionAfterLaunchMs: 40,
    lastTurnCompletionAfterLaunchMs: 40,
  });
});

NodeTest.test("keeps only server diagnostic stall entries inside the workload window", () => {
  const entries = parseServerStallEntries([
    JSON.stringify({ timestamp: "2026-09-24T10:00:00.000Z", message: "Event loop stalled", stalledMs: 900 }),
    JSON.stringify({ timestamp: "2026-09-24T10:00:01.000Z", message: "other", stalledMs: 999 }),
    JSON.stringify({ timestamp: "2026-09-24T10:00:02.000Z", message: "Event loop stalled", stalledMs: 750 }),
  ].join("\n"), Date.parse("2026-09-24T10:00:00.500Z"), Date.parse("2026-09-24T10:00:02.500Z"));
  NodeAssertStrict.deepEqual(entries, [{ timestamp: "2026-09-24T10:00:02.000Z", stalledMs: 750 }]);
});

NodeTest.test("reads structured server work stalls and prefers them over duplicate legacy warnings", () => {
  const entries = parseServerStallEntries([
    JSON.stringify({ timestamp: "2026-09-24T19:07:27.116Z", message: "Event loop stalled", stalledMs: 240 }),
    JSON.stringify({ timestamp: "2026-09-24T19:07:27.116Z", message: "Server work trace", kind: "server-work-stall", delayMs: 260.15 }),
    JSON.stringify({ timestamp: "2026-09-24T19:07:37.927Z", message: "Server work trace", kind: "server-work-stall", delayMs: 3639.19 }),
    JSON.stringify({ timestamp: "2026-09-24T19:07:39.550Z", message: "Server work trace", kind: "other", delayMs: 1603 }),
    JSON.stringify({ timestamp: "2026-09-24T19:07:50.000Z", message: "Server work trace", kind: "server-work-stall", delayMs: 9000 }),
  ].join("\n"), Date.parse("2026-09-24T19:07:26.326Z"), Date.parse("2026-09-24T19:07:46.625Z"));
  NodeAssertStrict.deepEqual(entries, [
    { timestamp: "2026-09-24T19:07:27.116Z", stalledMs: 260.15 },
    { timestamp: "2026-09-24T19:07:37.927Z", stalledMs: 3639.19 },
  ]);
});

NodeTest.test("records only bounded worker queue counts and retains the peak after the sample limit", () => {
  const target = {
    samples: [], omittedSamples: 0, unavailableSamples: 0,
    summary: { sampleCount: 0, maxPending: 0, maxPendingBytes: 0, maxActiveExecutions: 0, maxQueuedPerWorker: 0, maxInFlightWorkers: 0 },
  };
  for (let index = 0; index < 513; index += 1) {
    recordWorkerQueueSample(target, {
      pending: index, pendingBytes: index * 2, activeExecutions: 7,
      workers: [{ index: 0, queued: index, inFlight: true, command: "private prompt" }],
      token: "private token",
    });
  }
  recordWorkerQueueSample(target, { pending: "wrong shape", workers: [] });
  NodeAssertStrict.equal(target.samples.length, 512);
  NodeAssertStrict.equal(target.omittedSamples, 1);
  NodeAssertStrict.equal(target.unavailableSamples, 1);
  NodeAssertStrict.deepEqual(target.summary, {
    sampleCount: 513, maxPending: 512, maxPendingBytes: 1024,
    maxActiveExecutions: 7, maxQueuedPerWorker: 512, maxInFlightWorkers: 1,
  });
  NodeAssertStrict.doesNotMatch(JSON.stringify(target), /private|prompt|token/);
});

NodeTest.test("summarizes public event arrival throughput in bounded one-second buckets", () => {
  const result = summarizeEventThroughput([
    { sentAtMs: 0, events: [{ atMs: 100 }, { atMs: 900 }, { atMs: 1_100 }] },
    { sentAtMs: 0, events: [{ atMs: 2_500 }] },
  ]);
  NodeAssertStrict.deepEqual(result, {
    scope: "public-agent-event-push", intervalMs: 1_000,
    totalEvents: 4, eventsPerInterval: [2, 1, 1], peakEventsPerSecond: 2,
  });
  const longRun = summarizeEventThroughput([{ sentAtMs: 0, events: [{ atMs: 0 }, { atMs: 3_600_000 }] }]);
  NodeAssertStrict.ok(longRun.eventsPerInterval.length <= 600);
  NodeAssertStrict.equal(longRun.totalEvents, 2);
});
