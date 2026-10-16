import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { isAwaitingApproval } from "../isAwaitingApproval";
import { useTerminalStore, type TerminalInstance } from "../terminalStore";

function run(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "web",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-1",
    trigger: "manual",
    actionName: "web",
    status: "awaiting-approval",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [], approval: null },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    port: null,
    ...overrides,
  };
}

function seed(state: TerminalInstance["state"], current: WorkspaceEnvironmentActionRun): void {
  const record = { id: "pty-1", threadId: "thread-1", label: "web", state, kind: "action", actionId: "web" } as TerminalInstance;
  useTerminalStore.setState({ terminals: { "thread-1": [record] }, ptyToThread: { "pty-1": "thread-1" } });
  useProjectActionStore.getState().applyRun(current);
}

describe("isAwaitingApproval", () => {
  beforeEach(() => useProjectActionStore.setState({ runsByThread: {} }));

  it("follows the run when a reused terminal still has a running record", () => {
    seed("running", run());

    expect(isAwaitingApproval("pty-1")).toBe(true);
  });

  it("is false once the run started, and for a terminal that is not an Action's", () => {
    seed("pending", run({ status: "running", startedAt: "2026-08-22T12:00:01.000Z" }));
    expect(isAwaitingApproval("pty-1")).toBe(false);
    expect(isAwaitingApproval("pty-unknown")).toBe(false);
  });
});
