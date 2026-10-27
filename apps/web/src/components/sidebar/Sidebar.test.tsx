import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  openCommandPalette: vi.fn(),
  beginNewThread: vi.fn(),
  setPrimarySurface: vi.fn(),
  ui: { primarySurface: "chat" },
}));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: Object.assign(vi.fn(), {
    getState: () => ({ open: hoisted.openCommandPalette }),
  }),
}));

vi.mock("@/stores/uiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      collapseSidebar: vi.fn(),
      primarySurface: hoisted.ui.primarySurface,
      setPrimarySurface: hoisted.setPrimarySurface,
    }),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(vi.fn(), {
    getState: () => ({ beginNewThread: hoisted.beginNewThread }),
  }),
}));

vi.mock("@/features/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/projects")>()),
  ProjectSidebar: () => <div data-testid="project-tree" />,
}));

vi.mock("./UpdateButton", () => ({
  UpdateButton: () => <div data-testid="update-button" />,
}));

import { Sidebar } from "./Sidebar";
import { useSidebarWidthStore } from "./sidebarWidthStore";

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.ui.primarySurface = "chat";
    useSidebarWidthStore.getState().resetWidth();
  });

  it("opens the thread finder intent from the Search field", () => {
    render(<Sidebar onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(hoisted.openCommandPalette).toHaveBeenCalledWith({
      intent: "threadSearch",
    });
  });

  it("starts a new chat thread from the New thread icon", () => {
    render(<Sidebar onOpenSettings={vi.fn()} />);

    const newThread = screen.getByTestId("sidebar-new-thread");
    expect(newThread).toHaveAccessibleName("New thread");
    fireEvent.click(newThread);

    expect(hoisted.setPrimarySurface).toHaveBeenCalledWith("chat");
    expect(hoisted.beginNewThread).toHaveBeenCalledOnce();
  });

  it("has no text navigation buttons above the projects", () => {
    render(<Sidebar onOpenSettings={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Search threads" })).not.toBeInTheDocument();
    expect(screen.queryByText("New thread")).not.toBeInTheDocument();
    expect(screen.queryByText("Pull requests")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("renders the footer icons and keeps the update indicator in the update slot", () => {
    const onOpenSettings = vi.fn();
    render(<Sidebar onOpenSettings={onOpenSettings} />);

    const footer = screen.getByTestId("sidebar-footer");
    fireEvent.click(within(footer).getByRole("button", { name: "Settings" }));
    fireEvent.click(within(footer).getByRole("button", { name: "Pull requests" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(hoisted.setPrimarySurface).toHaveBeenCalledWith("pullRequests");
    expect(within(footer).getByRole("button", { name: "Notifications" })).toBeEnabled();
    expect(within(screen.getByTestId("sidebar-update-slot")).getByTestId("update-button")).toBeInTheDocument();
  });

  it("shows Pull requests as the current page only while that surface is open", () => {
    const { rerender } = render(<Sidebar onOpenSettings={vi.fn()} />);
    const pullRequests = () => screen.getByRole("button", { name: "Pull requests" });

    expect(pullRequests()).toHaveAttribute("aria-pressed", "false");
    expect(pullRequests()).not.toHaveAttribute("aria-current");

    hoisted.ui.primarySurface = "pullRequests";
    rerender(<Sidebar onOpenSettings={vi.fn()} />);

    expect(pullRequests()).toHaveAttribute("aria-pressed", "true");
    expect(pullRequests()).toHaveAttribute("aria-current", "page");
  });

  it("takes its width from the sidebar width store", () => {
    useSidebarWidthStore.getState().setWidth(260);

    render(<Sidebar onOpenSettings={vi.fn()} />);

    expect(screen.getByTestId("sidebar")).toHaveStyle({ width: "260px" });
  });
});
