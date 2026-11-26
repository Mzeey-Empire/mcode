import { createMockWorkspace } from "@mcode/contracts/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/features/conversation/composer/Composer", () => ({
  Composer: ({ isNewThread, workspaceId, noProject }: { isNewThread?: boolean; workspaceId?: string; noProject?: boolean }) => (
    <div
      data-testid="composer"
      data-new-thread={String(isNewThread)}
      data-workspace={workspaceId ?? ""}
      data-no-project={String(noProject === true)}
    />
  ),
}));

import { NewThreadStartColumn } from "../NewThreadStartColumn";

const FIXTURE = createMockWorkspace({ id: "ws-1", name: "fixture-repo", path: "/repo/fixture" });
const OTHER = createMockWorkspace({ id: "ws-2", name: "other-repo", path: "/repo/other" });

function renderColumn(projectName: string | undefined, noProject = false) {
  return render(
    <NewThreadStartColumn
      projectName={projectName}
      workspaceId={projectName ? "ws-1" : undefined}
      draftId={null}
      noProject={noProject}
    />,
  );
}

describe("NewThreadStartColumn", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [FIXTURE, OTHER],
      workspacesLoaded: true,
      activeWorkspaceId: FIXTURE.id,
      activeThreadId: null,
      threads: [],
      newThreadTarget: { kind: "project" },
    });
    // cmdk scrolls the active option into view, which jsdom does not implement.
    Element.prototype.scrollIntoView = () => {};
  });

  it("asks what to build in the active project", () => {
    renderColumn("fixture-repo");

    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("What should we build in fixture-repo?");
    expect(screen.getByTestId("new-thread-project-slot")).toHaveTextContent("fixture-repo");
    expect(screen.getByTestId("composer")).toHaveAttribute("data-workspace", "ws-1");
  });

  it("switches project from the slot's chooser", async () => {
    const user = userEvent.setup();
    renderColumn("fixture-repo");

    await user.click(screen.getByTestId("new-thread-project-slot"));
    await user.click(await screen.findByRole("option", { name: "other-repo" }));

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-2");
  });

  it("asks for a project when none is chosen", () => {
    renderColumn(undefined);

    expect(screen.getByTestId("new-thread-project-slot")).toHaveTextContent("choose a project");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(/^New thread$/);
  });

  it("puts the project in the canvas breadcrumb", () => {
    renderColumn("fixture-repo");

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("fixture-repo/New thread");
  });

  it("drops the starter cards, the logo and the projectless escape line", () => {
    renderColumn("fixture-repo");

    expect(screen.queryByRole("img", { name: "Mcode" })).toBeNull();
    expect(screen.queryByText("Explore and understand code")).toBeNull();
    expect(screen.queryByText(/without a project instead/)).toBeNull();
  });

  describe("on No project", () => {
    it("asks what to work on, with a No project pill in place of the project slot", () => {
      renderColumn(undefined, true);

      expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("What should we work on?");
      expect(screen.getByRole("button", { name: "No project" })).toBe(screen.getByTestId("new-thread-project-slot"));
      expect(screen.queryByText("choose a project")).toBeNull();
    });

    it("names No project in the canvas breadcrumb", () => {
      renderColumn(undefined, true);

      expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("No project/New thread");
    });

    it("hands the composer the No project target and no workspace", () => {
      renderColumn(undefined, true);

      expect(screen.getByTestId("composer")).toHaveAttribute("data-no-project", "true");
      expect(screen.getByTestId("composer")).toHaveAttribute("data-workspace", "");
    });

    it("opens the same chooser from the pill, and choosing a project leaves No project", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.getState().beginNoProjectThread();
      renderColumn(undefined, true);

      await user.click(screen.getByTestId("new-thread-project-slot"));
      await user.click(await screen.findByRole("option", { name: "other-repo" }));

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-2");
      expect(useWorkspaceStore.getState().newThreadTarget).toEqual({ kind: "project" });
    });
  });
});
