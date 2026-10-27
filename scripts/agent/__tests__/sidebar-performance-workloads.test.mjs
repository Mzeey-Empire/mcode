import * as NodeAssertStrict from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { createModeSignalCollector } from "../../perf/frontend-performance-collectors.mjs";
import { normalizeFrontendRendererWorkloads } from "../../perf/frontend-renderer-fixture.mjs";
import {
  buildSidebarSignalPushes,
  buildSidebarStreamEvents,
  readFrameIndex,
  readFrameIntervals,
  sampleMeasureOptions,
  summarizeFrameIntervals,
  summarizeFramesInWindow,
  summarizeSidebarStreamEvents,
  validateSidebarCheck,
} from "../../perf/sidebar-renderer-workloads.mjs";
import {
  SIDEBAR_STREAM_TARGET_TITLE,
  parseSidebarThreadCount,
  planSidebarThreads,
  resolveSidebarFixtureDatabasePath,
} from "../../perf/sidebar-thread-fixture-plan.mjs";

const assert = NodeAssertStrict.default;
const repoRoot = NodePath.resolve("/repo/worktree");

NodeTest.describe("sidebar thread fixture", () => {
  NodeTest.it("accepts only an app.sqlite inside the worktree .dev directory", () => {
    assert.equal(
      resolveSidebarFixtureDatabasePath(repoRoot, undefined),
      NodePath.join(repoRoot, ".dev", "db", "app.sqlite"),
    );
    assert.equal(
      resolveSidebarFixtureDatabasePath(repoRoot, ".dev/electron-performance-profiling/runtime/db/app.sqlite"),
      NodePath.join(repoRoot, ".dev", "electron-performance-profiling", "runtime", "db", "app.sqlite"),
    );
    for (const outside of ["../other/.dev/db/app.sqlite", ".dev/../app.sqlite", NodePath.resolve("/home/user/.mcode/app.sqlite"), ".dev/db/live.sqlite"]) {
      assert.throws(() => resolveSidebarFixtureDatabasePath(repoRoot, outside), /Refusing to seed/);
    }
  });

  NodeTest.it("plans the stream target as the newest open thread at every scale", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    for (const count of [0, 1, 1000]) {
      const plan = planSidebarThreads(count, now);
      assert.equal(plan.length, Math.max(1, count));
      assert.equal(plan[0].title, SIDEBAR_STREAM_TARGET_TITLE);
      assert.equal(plan[0].workspaceIndex, 0);
      assert.equal(plan[0].userCompletedAt, null);
      assert.ok(plan.slice(1).every((thread) => thread.createdAt < plan[0].createdAt));
    }
  });

  NodeTest.it("varies activity times, completion, and workspaces deterministically", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    const plan = planSidebarThreads(1000, now);
    assert.deepEqual(plan, planSidebarThreads(1000, now));
    assert.equal(new Set(plan.map((thread) => thread.workspaceIndex)).size, 6);
    const completed = plan.filter((thread) => thread.userCompletedAt !== null).length;
    const withTurns = plan.filter((thread) => thread.lastTurnEndedAt !== null).length;
    assert.ok(completed > 50 && completed < 200, `completed=${completed}`);
    assert.ok(withTurns > 600 && withTurns < 800, `withTurns=${withTurns}`);
    assert.ok(plan.every((thread) => thread.updatedAt >= thread.createdAt && thread.updatedAt <= new Date(now).toISOString()));
  });

  NodeTest.it("rejects thread counts outside 0 through 5000", () => {
    assert.equal(parseSidebarThreadCount("5000"), 5000);
    for (const value of ["5001", "-1", "1e3", "", "12.5"]) assert.throws(() => parseSidebarThreadCount(value));
  });
});

NodeTest.describe("sidebar renderer workloads", () => {
  NodeTest.it("runs sidebar workloads only without chat workloads", () => {
    assert.deepEqual(normalizeFrontendRendererWorkloads("sidebarScroll,sidebarStream"), ["sidebarStream", "sidebarScroll"]);
    assert.throws(() => normalizeFrontendRendererWorkloads("message100,sidebarScroll"), /without chat renderer workloads/);
    assert.ok(!normalizeFrontendRendererWorkloads(null).includes("sidebarStream"));
  });

  NodeTest.it("rewrites the captured turn onto the target thread with fresh identities", () => {
    const capture = {
      threadId: "captured-thread",
      executionId: "11111111-2222-3333-4444-555555555555",
      frames: [
        { phase: "saved", threadId: "captured-thread", epoch: "epoch-a", events: [{ routing: { threadId: "captured-thread", executionId: "11111111-2222-3333-4444-555555555555" } }] },
        { phase: "saved", threadId: "captured-thread", epoch: "epoch-b", events: [] },
        { phase: "accepted", threadId: "captured-thread", epoch: "epoch-b", events: [] },
      ],
    };
    const events = buildSidebarStreamEvents(capture, "target", "s1", "99999999-2222-3333-4444-555555555555");
    assert.deepEqual(events.map((event) => event.channel), ["thread.status", "agent.canonical", "agent.canonical", "agent.canonical", "thread.status"]);
    assert.equal(events[1].recoveryBase.admission.epoch, "sidebar-perf-s1-0");
    assert.ok(events.slice(2, 4).every((event) => event.data.epoch === "sidebar-perf-s1-1"));
    const text = JSON.stringify(events);
    assert.ok(!text.includes("captured-thread") && !text.includes("epoch-a") && !text.includes(capture.executionId));
    assert.notEqual(JSON.stringify(buildSidebarStreamEvents(capture, "target", "s2", "88888888-2222-3333-4444-555555555555")), text);
  });

  NodeTest.it("summarizes commits per event by channel", () => {
    const summary = summarizeSidebarStreamEvents([
      [{ channel: "thread.status", commitCount: 1, commitDurationMs: 4 }, { channel: "agent.canonical", commitCount: 0, commitDurationMs: 0 }],
      [{ channel: "thread.status", commitCount: 2, commitDurationMs: 6 }, { channel: "agent.canonical", commitCount: 1, commitDurationMs: 2 }],
    ]);
    assert.equal(summary.all.eventCount, 4);
    assert.equal(summary.all.totalCommits, 4);
    assert.equal(summary.byChannel["thread.status"].commitDurationP95Ms, 6);
    assert.equal(summary.byChannel["agent.canonical"].commitDurationP50Ms, 0);
  });

  NodeTest.it("summarizes row renders and setRows calls per event, and leaves them empty in production", () => {
    const summary = summarizeSidebarStreamEvents([
      [{ channel: "thread.activity", commitCount: 1, commitDurationMs: 3, rowRenderCount: 1, rowsRendered: 1, setRowsCount: 1 }],
      [{ channel: "thread.activity", commitCount: 2, commitDurationMs: 5, rowRenderCount: 4, rowsRendered: 3, setRowsCount: 0 }],
    ]);
    assert.equal(summary.byChannel["thread.activity"].rowRendersPerEventMax, 4);
    assert.equal(summary.byChannel["thread.activity"].rowsRenderedPerEventMax, 3);
    assert.equal(summary.byChannel["thread.activity"].setRowsPerEventMax, 1);
    const production = summarizeSidebarStreamEvents([[{ channel: "thread.status", commitCount: null, commitDurationMs: null, rowRenderCount: null, rowsRendered: null, setRowsCount: null }]]);
    assert.equal(production.all.rowRendersPerEventMax, null);
    assert.equal(production.all.setRowsPerEventP50, null);
  });

  NodeTest.it("follows the turn with one activity push and one pull-request push for the target", () => {
    const pushes = buildSidebarSignalPushes("target", "2026-10-27T12:00:00.000Z", 1001);
    assert.deepEqual(pushes.map((push) => push.channel), ["thread.activity", "thread.pullRequests"]);
    assert.ok(pushes.every((push) => push.data.threadId === "target"));
    assert.equal(pushes[1].data.pullRequests[0].number, 1001);
  });

  NodeTest.it("counts only the frames that end inside a flight window", () => {
    const frames = summarizeFramesInWindow([0, 16.7, 33.4, 66.8, 83.5, 150], 16.7, 83.5, 16.7);
    assert.equal(frames.frameCount, 3);
    assert.equal(frames.overBudgetFrames, 1);
  });

  NodeTest.it("rejects flight samples that had no row to fly or saw no flight", () => {
    assert.deepEqual(validateSidebarCheck("sidebarCompleteFlight", { candidate: null }, "production"), ["no thread row besides the stream target was on screen"]);
    assert.deepEqual(validateSidebarCheck("sidebarCompleteFlight", { candidate: { id: "a" }, flights: 0 }, "production"), ["the completed row did not fly"]);
    assert.deepEqual(validateSidebarCheck("sidebarOlderCrossing", { crossing: [1, 2, 3, 4, 5], flights: 3 }, "production"), []);
    assert.deepEqual(validateSidebarCheck("sidebarOlderCrossing", { crossing: [1, 2] }, "production"), ["fewer than five Recent rows were on screen"]);
  });

  NodeTest.it("rejects an idle tick sample outside a profiling build or shorter than a minute", () => {
    assert.deepEqual(validateSidebarCheck("sidebarIdleTick", { profiling: true, elapsedMs: 61_000 }, "profiling"), []);
    assert.equal(validateSidebarCheck("sidebarIdleTick", { profiling: false, elapsedMs: 59_000 }, "production").length, 2);
  });

  NodeTest.it("counts frames that miss at least half a vsync as over budget", () => {
    const frames = summarizeFrameIntervals([16.7, 16.6, 25.1, 24.9, 50], 16.7);
    assert.equal(frames.overBudgetFrames, 2);
    assert.equal(frames.p95Ms, 50);
  });

  NodeTest.it("rejects a hydration sample whose Profiler recorded nothing in a profiling build", () => {
    const check = { firstThreadRowMs: 900, sidebarCommitsBeforeSettle: 0 };
    assert.deepEqual(validateSidebarCheck("sidebarHydration", check, "profiling"), ["the sidebar Profiler recorded no commits"]);
    assert.deepEqual(validateSidebarCheck("sidebarHydration", check, "production"), []);
  });

  NodeTest.it("profiles the first measured sample of any workload only when the run asks", () => {
    const context = { traceDirectory: "out-traces", runtime: "electron", mode: "profiling", fixture: { requestedThreadCount: 5000 } };
    assert.deepEqual(sampleMeasureOptions(context, "sidebarStream", 0), {});
    assert.equal(sampleMeasureOptions({ ...context, cpuProfile: true }, "sidebarStream", 1).cpuProfileFile, undefined);
    assert.deepEqual(sampleMeasureOptions({ ...context, cpuProfile: true }, "sidebarStream", 0), {
      trace: true,
      traceFile: "out-traces/electron-profiling-5000-sidebarStream.trace.json",
      cpuProfileFile: "out-traces/electron-profiling-5000-sidebarStream.cpuprofile",
    });
  });

  NodeTest.it("keeps a sample's frames when the rAF buffer trims past ten thousand frames", async () => {
    const page = createFramePage();
    await createModeSignalCollector(page, "profiling");
    page.tickFrames(9_990, 16);
    const index = await readFrameIndex(page);
    page.tickFrames(20, 8);
    assert.deepEqual(await readFrameIntervals(page, index), Array(19).fill(8));
    page.restore();
  });
});

/** A page whose evaluate runs in Node against a stub window, with rAF driven by the test. */
function createFramePage() {
  const saved = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, PerformanceObserver: globalThis.PerformanceObserver };
  let frameCallback = null;
  let now = 0;
  globalThis.window = {};
  globalThis.requestAnimationFrame = (callback) => { frameCallback = callback; };
  globalThis.PerformanceObserver = class { static supportedEntryTypes = []; observe() {} };
  return {
    async evaluate(callback, argument) { return callback(argument); },
    tickFrames(count, stepMs) {
      for (let frame = 0; frame < count; frame += 1) {
        now += stepMs;
        frameCallback(now);
      }
    },
    restore() { Object.assign(globalThis, saved); },
  };
}
