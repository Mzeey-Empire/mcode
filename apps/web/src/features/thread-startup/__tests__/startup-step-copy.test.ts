import { describe, expect, it } from "vitest";
import type { ThreadStartup, ThreadStartupAction, ThreadStartupStep, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import {
  formatStartupDuration,
  placeholderTrailRows,
  setupCommandLine,
  startupDecision,
  startupSetupView,
  startupTrailRows,
} from "../startup-step-copy";

const T0 = "2026-09-02T12:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

function managed(steps: ThreadStartupStep[]): Pick<ThreadStartup, "kind" | "steps"> {
  return { kind: "managed-worktree", steps };
}

describe("formatStartupDuration", () => {
  it("formats m:ss and clamps negatives", () => {
    expect(formatStartupDuration(0)).toBe("0s");
    expect(formatStartupDuration(14_900)).toBe("14s");
    expect(formatStartupDuration(75_000)).toBe("1m 15s");
    expect(formatStartupDuration(-5_000)).toBe("0s");
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
  it("explains the skipped Setup for an Implement continuation", () => {
    const rows = startupTrailRows({ kind: "attached-worktree", steps: [
      { phase: "setup", state: "skipped", detail: { phase: "setup", skipReason: "plan-implement" } },
    ] }, { now: 0 });
    expect(rows).toEqual([{ phase: "setup", tone: "skipped", label: "Skipped setup",
      meta: ["implementing a plan"], title: undefined, expandable: false }]);
  });
  it("renders the live 04f trail and hides the thread phase", () => {
    const rows = startupTrailRows(managed([
      { phase: "thread", state: "completed", startedAt: at(0), endedAt: at(0) },
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(1), detail: { phase: "fetch", ref: "origin/main" } },
      { phase: "worktree", state: "completed", startedAt: at(1), endedAt: at(3), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w/mcode-3f2a" } },
      { phase: "setup", state: "running", startedAt: at(3) },
      { phase: "agent", state: "pending" },
    ]), { now: Date.parse(at(17)), setupCommand: "bun install" });

    expect(rows).toEqual([
      { phase: "fetch", tone: "done", label: "Fetched", meta: ["origin/main", "1s"], title: undefined, expandable: false },
      { phase: "worktree", tone: "done", label: "Created worktree", meta: ["mcode-3f2a", "2s"], title: "/w/mcode-3f2a", expandable: false },
      { phase: "setup", tone: "live", label: "Running setup", meta: ["bun install", "14s"], title: undefined, expandable: true },
      { phase: "agent", tone: "pending", label: "Start thread", meta: [], title: undefined, expandable: false },
    ]);
  });

  it("joins a failed row's argument and duration into one run", () => {
    const [setup] = startupTrailRows(managed([
      { phase: "setup", state: "failed", startedAt: at(0), endedAt: at(14), detail: { phase: "setup", exitCode: 1 } },
    ]), { now: 0, setupCommand: "bun install" });
    expect(setup).toMatchObject({ tone: "failed", label: "Setup failed", meta: ["exit 1 · 14s"] });
  });

  it("reads a setup step the server blocked on a failed command as failed, with its exit code", () => {
    const [setup] = startupTrailRows(managed([
      { phase: "setup", state: "blocked", startedAt: at(0), endedAt: at(14), detail: { phase: "setup", exitCode: 1 } },
    ]), { now: 0, setupCommand: "bun install" });
    expect(setup).toEqual({ phase: "setup", tone: "failed", label: "Setup failed", meta: ["exit 1 · 14s"], title: undefined, expandable: false });
  });

  it("reads a setup step waiting on approval as a quiet decision row without meta", () => {
    const [setup] = startupTrailRows({
      ...managed([{ phase: "setup", state: "blocked", startedAt: at(0) }]),
      block: { code: "SETUP_APPROVAL_REQUIRED", message: "Setup needs approval", actions: ["retry", "continue"] },
    }, { now: 0, setupCommand: "bun install" });
    expect(setup).toEqual({ phase: "setup", tone: "approval", label: "Setup needs approval", meta: [], expandable: false });
  });

  it("labels blocked, interrupted, cancelled and skipped steps", () => {
    const rows = startupTrailRows(managed([
      { phase: "fetch", state: "interrupted", startedAt: at(0), endedAt: at(2), detail: { phase: "fetch", ref: "origin/main" } },
      { phase: "worktree", state: "cancelled", startedAt: at(2), endedAt: at(11) },
      { phase: "setup", state: "blocked", startedAt: at(11) },
      { phase: "agent", state: "failed", startedAt: at(0), endedAt: at(30) },
    ]), { now: 0, setupCommand: "bun install" });
    expect(rows.map(({ label, meta, tone }) => ({ label, meta, tone }))).toEqual([
      { label: "Fetch stopped", meta: ["origin/main · 2s"], tone: "failed" },
      { label: "Cancelled", meta: ["9s"], tone: "cancelled" },
      { label: "Setup failed", meta: ["bun install"], tone: "failed" },
      { label: "Thread didn't start", meta: ["30s"], tone: "failed" },
    ]);
  });

  it("shows a pull request fetch as its number and branch, falling back to the ref", () => {
    const rows = startupTrailRows(managed([
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(3), detail: { phase: "fetch", ref: "pull/1804/head", pullRequestNumber: 1804, branch: "feat/sidebar-resize" } },
      { phase: "fetch", state: "completed", startedAt: at(0), endedAt: at(3), detail: { phase: "fetch", ref: "pull/1804/head", pullRequestNumber: 1804 } },
    ]), { now: 0 });
    expect(rows.map((row) => row.meta)).toEqual([
      ["#1804 · feat/sidebar-resize", "3s"],
      ["#1804", "3s"],
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

describe("startupDecision", () => {
  const record = (overrides: Partial<ThreadStartup>): ThreadStartup => ({
    startupId: "startup-1",
    workspaceId: "workspace-1",
    kind: "managed-worktree",
    state: "blocked",
    phase: "setup",
    steps: [],
    transcript: [],
    cancellation: "none",
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

  it.each([
    ["a live startup", record({ state: "running" }), null],
    ["a completed startup", record({ state: "completed", phase: "agent" }), null],
    ["setup waiting on approval", record({ block: { code: "SETUP_APPROVAL_REQUIRED", message: "", actions: ["retry", "continue"] } }), "setup-approval"],
    ["setup that failed", record({ block: { code: "SETUP_FAILED", message: "", actions: ["retry", "continue"] } }), "setup-failed"],
    ["setup a restart interrupted", record({ state: "interrupted" }), "setup-failed"],
    ["a failed origin fetch", record({ phase: "fetch", block: { code: "start_from_origin_failed", message: "", actions: ["retry", "continue"] } }), "fetch-failed"],
    ["a worktree that failed to create", record({ state: "failed", phase: "worktree" }), "creation-failed"],
    ["an agent that failed to start", record({ state: "failed", phase: "agent" }), "agent-failed"],
    ["a cancelled startup", record({ state: "cancelled", phase: "agent" }), "cancelled"],
  ] as const)("asks %s for %s", (_name, startup, expected) => {
    expect(startupDecision(startup) ?? null).toBe(expected);
  });
});

describe("startupSetupView", () => {
  const action = (actionId: string, outcome: ThreadStartupAction["outcome"], runId: string | null): ThreadStartupAction =>
    ({ actionId, scriptHash: "a".repeat(64), runId, outcome });
  const run = (actionId: string, overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun => ({
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId,
    runId: `${actionId}-run`,
    revision: 0,
    terminalSessionId: `${actionId}-pty`,
    trigger: "startup",
    actionName: actionId,
    status: "running",
    snapshot: { platform: "linux", script: `bun ${actionId}
bun other`, checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    exitCode: null,
    port: null,
    ...overrides,
  });

  it("lists the first script line of each launched action in sequence order", () => {
    const view = startupSetupView(
      [action("install", "ready", "install-run"), action("check", "running", "check-run"), action("build", "pending", null)],
      { check: run("check"), install: run("install", { status: "completed", exitCode: 0 }), build: run("build") },
    );
    expect(view.commands).toEqual(["bun install", "bun check"]);
    expect(view.terminalSessionId).toBe("check-pty");
  });

  it("names a replaced run by its action and keeps it out of approval and terminal selection", () => {
    const replaced = run("install", { runId: "manual-run", status: "awaiting-approval", actionName: "Install" });
    const view = startupSetupView([action("install", "running", "install-run")], { install: replaced });
    expect(view).toEqual({ commands: ["Install"], pending: undefined, terminalSessionId: null });
  });

  it("exposes the run waiting for approval and points Open terminal at the failed action", () => {
    const waiting = run("web", { status: "awaiting-approval" });
    const view = startupSetupView(
      [action("install", "failed", "install-run"), action("web", "pending", "web-run")],
      { install: run("install", { status: "completed", exitCode: 3 }), web: waiting },
    );
    expect(view.pending).toBe(waiting);
    expect(view.terminalSessionId).toBe("install-pty");
  });

  it("points Open terminal at a released action whose process keeps running", () => {
    const view = startupSetupView(
      [action("dev", "ready", "dev-run")],
      { dev: run("dev", { status: "running" }) },
    );
    expect(view.terminalSessionId).toBe("dev-pty");
  });

  it("prefers a running or failed action over a released one", () => {
    const released = run("dev", { status: "running" });
    expect(startupSetupView(
      [action("dev", "ready", "dev-run"), action("check", "running", "check-run")],
      { dev: released, check: run("check") },
    ).terminalSessionId).toBe("check-pty");
    expect(startupSetupView(
      [action("dev", "ready", "dev-run"), action("check", "failed", "check-run")],
      { dev: released, check: run("check", { status: "failed", exitCode: 1 }) },
    ).terminalSessionId).toBe("check-pty");
  });

  it("offers no terminal for a waited action that already exited", () => {
    const view = startupSetupView(
      [action("install", "ready", "install-run")],
      { install: run("install", { status: "completed", exitCode: 0 }) },
    );
    expect(view.terminalSessionId).toBeNull();
  });

  it("falls back to the action name for a run without a script", () => {
    const bare = run("check", { actionName: "Check", snapshot: { platform: "linux", script: null, checkoutPath: "/repo", terminal: null, environmentNames: [] } });
    expect(startupSetupView([action("check", "running", "check-run")], { check: bare }).commands).toEqual(["Check"]);
  });
});
