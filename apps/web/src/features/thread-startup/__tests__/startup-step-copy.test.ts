import { describe, expect, it } from "vitest";
import type { ThreadStartup, ThreadStartupStep } from "@mcode/contracts";
import {
  formatStartupDuration,
  placeholderTrailRows,
  setupCommandLine,
  startupTrailRows,
  startupTrailSummary,
} from "../startup-step-copy";

const T0 = "2026-09-02T12:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

function managed(steps: ThreadStartupStep[]): Pick<ThreadStartup, "kind" | "steps"> {
  return { kind: "managed-worktree", steps };
}

describe("formatStartupDuration", () => {
  it("formats m:ss and clamps negatives", () => {
    expect(formatStartupDuration(0)).toBe("0:00");
    expect(formatStartupDuration(14_900)).toBe("0:14");
    expect(formatStartupDuration(75_000)).toBe("1:15");
    expect(formatStartupDuration(-5_000)).toBe("0:00");
  });
});

describe("setupCommandLine", () => {
  it("returns the first non-empty script line", () => {
    expect(setupCommandLine("\n  bun install\r\nbun run build")).toBe("bun install");
    expect(setupCommandLine(null)).toBeUndefined();
    expect(setupCommandLine("  \n")).toBeUndefined();
  });
});

describe("startupTrailRows", () => {
  it("renders the live 04f trail and hides the thread phase", () => {
    const rows = startupTrailRows(managed([
      { phase: "thread", state: "completed", startedAt: at(0), endedAt: at(0) },
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(1), detail: { phase: "fetch", ref: "origin/main" } },
      { phase: "worktree", state: "completed", startedAt: at(1), endedAt: at(3), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w/mcode-3f2a" } },
      { phase: "setup", state: "running", startedAt: at(3) },
      { phase: "agent", state: "pending" },
    ]), { now: Date.parse(at(17)), setupCommand: "bun install" });

    expect(rows).toEqual([
      { phase: "fetch", tone: "done", label: "Fetched", meta: ["origin/main", "0:01"], title: undefined, expandable: false },
      { phase: "worktree", tone: "done", label: "Created worktree", meta: ["mcode-3f2a", "0:02"], title: "/w/mcode-3f2a", expandable: false },
      { phase: "setup", tone: "live", label: "Running setup", meta: ["bun install", "0:14"], title: undefined, expandable: true },
      { phase: "agent", tone: "pending", label: "Start thread", meta: [], title: undefined, expandable: false },
    ]);
  });

  it("joins a failed row's argument and duration into one run", () => {
    const [setup] = startupTrailRows(managed([
      { phase: "setup", state: "failed", startedAt: at(0), endedAt: at(14), detail: { phase: "setup", exitCode: 1 } },
    ]), { now: 0, setupCommand: "bun install" });
    expect(setup).toMatchObject({ tone: "failed", label: "Setup failed", meta: ["exit 1 · 0:14"] });
  });

  it("reads a setup step the server blocked on a failed command as failed, with its exit code and open output", () => {
    const [setup] = startupTrailRows(managed([
      { phase: "setup", state: "blocked", startedAt: at(0), endedAt: at(14), detail: { phase: "setup", exitCode: 1 } },
    ]), { now: 0, setupCommand: "bun install" });
    expect(setup).toEqual({ phase: "setup", tone: "failed", label: "Setup failed", meta: ["exit 1 · 0:14"], title: undefined, expandable: true });
  });

  it("labels blocked, interrupted, cancelled and skipped steps", () => {
    const rows = startupTrailRows(managed([
      { phase: "fetch", state: "interrupted", startedAt: at(0), endedAt: at(2), detail: { phase: "fetch", ref: "origin/main" } },
      { phase: "worktree", state: "cancelled", startedAt: at(2), endedAt: at(11) },
      { phase: "setup", state: "blocked", startedAt: at(11) },
      { phase: "agent", state: "failed", startedAt: at(0), endedAt: at(30) },
    ]), { now: 0, setupCommand: "bun install" });
    expect(rows.map(({ label, meta, tone }) => ({ label, meta, tone }))).toEqual([
      { label: "Fetch stopped", meta: ["origin/main · 0:02"], tone: "failed" },
      { label: "Cancelled", meta: ["0:09"], tone: "cancelled" },
      { label: "Setup failed", meta: ["bun install"], tone: "failed" },
      { label: "Thread didn't start", meta: ["0:30"], tone: "failed" },
    ]);
  });

  it("shows a pull request fetch as its number and branch, falling back to the ref", () => {
    const rows = startupTrailRows(managed([
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(3), detail: { phase: "fetch", ref: "pull/1804/head", pullRequestNumber: 1804, branch: "feat/sidebar-resize" } },
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(3), detail: { phase: "fetch", ref: "pull/1804/head", pullRequestNumber: 1804 } },
    ]), { now: 0 });
    expect(rows.map((row) => row.meta)).toEqual([
      ["#1804 · feat/sidebar-resize", "0:03"],
      ["#1804", "0:03"],
    ]);
  });

  it("shows the skip reason and no duration for skipped setup", () => {
    const [setup] = startupTrailRows(managed([
      { phase: "setup", state: "skipped", startedAt: at(0), endedAt: at(0), detail: { phase: "setup", skipReason: "thread-running-here" } },
    ]), { now: 0, setupCommand: "bun install" });
    expect(setup).toMatchObject({ label: "Skipped setup", meta: ["thread running here"] });
  });

  it("shows an opened worktree without a duration", () => {
    const [worktree] = startupTrailRows({
      kind: "attached-worktree",
      steps: [{ phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(1), detail: { phase: "worktree", mode: "opened", folderName: "mcode-9c1d", path: "/w/mcode-9c1d" } }],
    }, { now: 0 });
    expect(worktree).toMatchObject({ label: "Opened worktree", meta: ["mcode-9c1d"] });
  });
});

describe("placeholderTrailRows", () => {
  it("lists the kind's visible phases as pending", () => {
    expect(placeholderTrailRows("managed-worktree").map((row) => row.label)).toEqual([
      "Create worktree", "Run setup", "Start thread",
    ]);
    expect(placeholderTrailRows("attached-worktree").map((row) => row.label)).toEqual([
      "Open worktree", "Run setup", "Start thread",
    ]);
  });
});

describe("startupTrailSummary", () => {
  it("collapses to total time, folder and the setup command that ran", () => {
    const summary = startupTrailSummary({
      createdAt: at(0),
      updatedAt: at(40),
      steps: [
        { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w" } },
        { phase: "setup", state: "completed" },
        { phase: "agent", state: "completed", endedAt: at(22) },
      ],
    }, "bun install");
    expect(summary).toEqual({ duration: "0:22", parts: ["mcode-3f2a", "bun install"] });
  });

  it("omits the setup command when setup was skipped", () => {
    const summary = startupTrailSummary({
      createdAt: at(0),
      updatedAt: at(5),
      steps: [{ phase: "setup", state: "skipped" }],
    }, "bun install");
    expect(summary).toEqual({ duration: "0:05", parts: [] });
  });
});
