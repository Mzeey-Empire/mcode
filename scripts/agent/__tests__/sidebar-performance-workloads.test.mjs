import * as NodeAssertStrict from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { normalizeFrontendRendererWorkloads } from "../../perf/frontend-renderer-fixture.mjs";
import {
  buildSidebarStreamEvents,
  summarizeFrameIntervals,
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
});
