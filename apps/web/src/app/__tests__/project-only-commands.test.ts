// @vitest-environment jsdom
import { createMockWorkspace } from "@mcode/contracts/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { clearCommands, executeCommand, getAllCommands, isCommandAvailable } from "@/lib/command-registry";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { registerProjectOnlyCommands } from "../project-only-commands";

const PROJECT = createMockWorkspace({ id: "ws-project", name: "mcode", is_git_repo: true });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", kind: "no_project", is_git_repo: false });

function openTabsFor(workspaceId: string, threadId: string): readonly string[] {
  return useDiffStore.getState().getRightPanel(workspaceId, threadId).openTabs;
}

describe("project-only commands", () => {
  let dispose: () => void;

  beforeEach(() => {
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useUiStore.setState({ primarySurface: "chat" });
    useWorkspaceStore.setState({ workspaces: [PROJECT, HIDDEN], threads: [] });
    dispose = registerProjectOnlyCommands();
  });

  afterEach(() => {
    dispose();
    clearCommands();
  });

  it("opens Project settings and the Changes panel in a project thread", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: PROJECT.id, activeThreadId: "thread-p" });

    expect(executeCommand("projectEnvironment.open")).toBe(true);
    expect(executeCommand("changes.toggle")).toBe(true);

    expect(openTabsFor(PROJECT.id, "thread-p")).toEqual(expect.arrayContaining(["environment", "changes"]));
  });

  it("does nothing in a No project thread, where the folder has no project or repository", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: HIDDEN.id, activeThreadId: "thread-h" });

    expect(executeCommand("projectEnvironment.open")).toBe(false);
    expect(executeCommand("changes.toggle")).toBe(false);

    expect(openTabsFor(HIDDEN.id, "thread-h")).toEqual([]);
  });

  it("marks both as unavailable in a No project thread, which is what keeps them out of the palette", () => {
    const unavailable = getAllCommands().filter((command) => !isCommandAvailable(command, true));

    expect(unavailable.map((command) => command.id).sort()).toEqual(["changes.toggle", "projectEnvironment.open"]);
    expect(getAllCommands().every((command) => isCommandAvailable(command, false))).toBe(true);
  });
});
