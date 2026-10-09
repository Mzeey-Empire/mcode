import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const beginNewThread = vi.hoisted(() => vi.fn());

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      workspaces: [
        { id: "ws-1", name: "fixture-repo", path: "/repo/fixture" },
        { id: "ws-2", name: "other-repo", path: "/repo/other" },
      ],
      beginNewThread,
    })),
}));

vi.mock("@/features/conversation/composer/Composer", () => ({
  Composer: ({ isNewThread, workspaceId }: { isNewThread?: boolean; workspaceId?: string }) => (
    <div data-testid="composer" data-new-thread={String(isNewThread)} data-workspace={workspaceId ?? ""} />
  ),
}));

import { NewThreadStartColumn } from "../NewThreadStartColumn";

function renderColumn(projectName: string | undefined) {
  return render(
    <NewThreadStartColumn
      projectName={projectName}
      workspaceId={projectName ? "ws-1" : undefined}
      draftId={null}
      sidebarCollapsed={false}
    />,
  );
}

describe("NewThreadStartColumn", () => {
  beforeEach(() => {
    beginNewThread.mockClear();
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

    expect(beginNewThread).toHaveBeenCalledWith("ws-2");
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
});
