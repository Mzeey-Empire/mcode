import { mockTransport } from "@/__tests__/mocks/transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.terminalPause).mockReset().mockResolvedValue(undefined);
  vi.mocked(mockTransport.terminalResume).mockReset();
});

import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { applyActionRun } from "../applyActionRun";
import { useTerminalStore } from "../terminalStore";

function actionRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "web",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-1",
    trigger: "manual",
    port: null,
    actionName: "web",
    status: "running",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

const recordIds = () => useTerminalStore.getState().terminals["thread-1"]?.map((terminal) => terminal.id) ?? [];

describe("applyActionRun", () => {
  beforeEach(() => {
    useProjectActionStore.setState({ runsByThread: {} });
    useTerminalStore.setState({ terminals: {}, activeTerminalByScope: {}, ptyToThread: {} });
  });

  it("adopts a started run's terminal as an action record and makes it the active tab", () => {
    applyActionRun(actionRun(), { focus: true });

    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]).toMatchObject({
      id: "pty-1",
      kind: "action",
      actionId: "web",
    });
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-1");
  });

  it("adopts a run awaiting approval as a pending record, then starts it in the same record on approval", () => {
    const pending = actionRun({ status: "awaiting-approval", startedAt: null });
    applyActionRun(pending, { focus: true });
    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]?.state).toBe("pending");

    applyActionRun(actionRun({ runId: "run-2", createdAt: "2026-08-22T12:00:01.000Z" }), { focus: true });

    expect(recordIds()).toEqual(["pty-1"]);
    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]?.state).toBe("running");
  });

  it("removes the pending record when the run is cancelled", () => {
    applyActionRun(actionRun({ status: "awaiting-approval", startedAt: null }), { focus: true });

    applyActionRun(actionRun({ status: "interrupted", terminalSessionId: null, startedAt: null, revision: 1 }), { focus: false });

    expect(recordIds()).toEqual([]);
  });

  it("leaves the tab the user is on when a run starts in the background", () => {
    useTerminalStore.getState().addTerminal("thread-1", "shell", "pwsh");

    applyActionRun(actionRun(), { focus: false });

    expect(recordIds()).toEqual(["shell", "pty-1"]);
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("shell");
  });

  it("focuses an already adopted record instead of adding a second one", () => {
    applyActionRun(actionRun(), { focus: true });
    useTerminalStore.getState().addTerminal("thread-1", "shell", "pwsh");

    applyActionRun(actionRun({ revision: 1 }), { focus: true });

    expect(recordIds()).toEqual(["pty-1", "shell"]);
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-1");
  });

  it("still focuses the tab when the push event beats the start response", () => {
    useTerminalStore.getState().addTerminal("thread-1", "shell", "pwsh");
    applyActionRun(actionRun({ revision: 1 }), { focus: false });
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("shell");

    applyActionRun(actionRun({ revision: 0 }), { focus: true });

    expect(recordIds()).toEqual(["shell", "pty-1"]);
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-1");
  });

  it("keeps one record across a restart in the same terminal", () => {
    applyActionRun(actionRun({ status: "failed", exitCode: 1 }), { focus: true });

    applyActionRun(actionRun({ runId: "run-2", createdAt: "2026-08-22T12:00:02.000Z" }), { focus: false });

    expect(recordIds()).toEqual(["pty-1"]);
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.web?.runId).toBe("run-2");
  });

  it("clears the exit when a rerun reuses a terminal whose shell the user exited", () => {
    applyActionRun(actionRun({ status: "failed", exitCode: 1 }), { focus: true });
    useTerminalStore.getState().recordTerminalExit("pty-1", { code: 0, signal: null, reason: "natural" });

    applyActionRun(actionRun({ runId: "run-2", createdAt: "2026-08-22T12:00:02.000Z" }), { focus: false });

    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]).toMatchObject({ id: "pty-1", state: "running" });
    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]?.exit).toBeUndefined();
  });

  it("keeps the exit when a delayed update of the same run arrives after the shell exited", () => {
    applyActionRun(actionRun({ revision: 1 }), { focus: false });
    useTerminalStore.getState().recordTerminalExit("pty-1", { code: 0, signal: null, reason: "natural" });

    applyActionRun(actionRun({ revision: 0 }), { focus: true });

    expect(useTerminalStore.getState().terminals["thread-1"]?.[0]).toMatchObject({ id: "pty-1", state: "exited" });
  });

  it("drops the record when the run no longer has a terminal", () => {
    applyActionRun(actionRun(), { focus: true });

    applyActionRun(actionRun({ revision: 1, status: "interrupted", terminalSessionId: null }), { focus: false });

    expect(recordIds()).toEqual([]);
  });

  it("replaces the record when a newer run lands in a different terminal", () => {
    applyActionRun(actionRun(), { focus: true });

    applyActionRun(
      actionRun({ runId: "run-2", terminalSessionId: "pty-2", createdAt: "2026-08-22T12:00:02.000Z" }),
      { focus: true },
    );

    expect(recordIds()).toEqual(["pty-2"]);
  });

  it("does not resurrect a record from a delayed run that a newer run already replaced", () => {
    const older = actionRun();
    applyActionRun(older, { focus: true });
    applyActionRun(
      actionRun({ runId: "run-2", terminalSessionId: null, createdAt: "2026-08-22T12:00:02.000Z" }),
      { focus: false },
    );
    expect(recordIds()).toEqual([]);

    applyActionRun(older, { focus: true });

    expect(recordIds()).toEqual([]);
  });
});
