import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  palette: {
    isOpen: true,
    viewStack: [{ kind: "threadSearch" }],
    query: "",
    setQuery: vi.fn(),
    close: vi.fn(),
    pop: vi.fn(),
    pendingConfirm: null as (() => void) | null,
  },
}));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.palette),
}));

vi.mock("@/lib/context-tracker", () => ({
  setContext: vi.fn(),
}));

vi.mock("./views/RootView", () => ({
  RootView: () => null,
}));
vi.mock("./views/ProjectsView", () => ({
  ProjectsView: () => null,
}));
vi.mock("./views/BrowseView", () => ({
  BrowseView: () => <div data-testid="browse-view" />,
}));
vi.mock("./views/SelectionListView", () => ({
  SelectionListView: () => null,
}));
vi.mock("./views/ThreadSearchView", () => ({
  ThreadSearchView: () => null,
}));

import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    // cmdk scrolls the highlighted row into view, which jsdom does not implement.
    Element.prototype.scrollIntoView = () => {};
    mocks.palette.viewStack = [{ kind: "threadSearch" }];
    mocks.palette.query = "";
    mocks.palette.pendingConfirm = null;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    vi.clearAllMocks();
  });

  it("focuses the thread search input when opened with the thread finder intent", async () => {
    render(<CommandPalette />);

    const input = screen.getByLabelText("Search threads");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("lists Local folder as the only source when opened to add a project", () => {
    mocks.palette.viewStack = [{ kind: "sources" }];

    render(<CommandPalette />);

    expect(screen.getByLabelText("Search sources")).toHaveAttribute(
      "placeholder",
      "Search sources, or type ~/ to browse",
    );
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Local folderAdd a folder on this computer",
    ]);
    expect(screen.queryByTestId("browse-view")).toBeNull();
  });

  it("browses from the sources view once the query is a path", () => {
    mocks.palette.viewStack = [{ kind: "sources" }];
    mocks.palette.query = "~/";

    render(<CommandPalette />);

    expect(screen.getByTestId("browse-view")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Local folder/ })).toBeNull();
  });

  it("starts browsing at the home folder when Enter selects Local folder", async () => {
    mocks.palette.viewStack = [{ kind: "sources" }];
    const user = userEvent.setup();

    render(<CommandPalette />);

    const input = screen.getByLabelText("Search sources");
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("option", { name: /Local folder/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(mocks.palette.setQuery).toHaveBeenCalledWith("~/");
  });

  it("starts browsing at the home folder when Local folder is clicked", async () => {
    mocks.palette.viewStack = [{ kind: "sources" }];
    const user = userEvent.setup();

    render(<CommandPalette />);

    await user.click(screen.getByRole("option", { name: /Local folder/ }));
    expect(mocks.palette.setQuery).toHaveBeenCalledWith("~/");
  });

  it("shows no source rows when the query matches none", () => {
    mocks.palette.viewStack = [{ kind: "sources" }];
    mocks.palette.query = "github";

    render(<CommandPalette />);

    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText("No sources match.")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    mocks.palette.viewStack = [{ kind: "sources" }];
    const user = userEvent.setup();

    render(<CommandPalette />);

    await waitFor(() => expect(screen.getByLabelText("Search sources")).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(mocks.palette.close).toHaveBeenCalledOnce();
  });

  it("shows the enabled add-project tooltip and confirms the selected folder", async () => {
    const confirm = vi.fn();
    mocks.palette.query = "~/project";
    mocks.palette.pendingConfirm = confirm;
    const user = userEvent.setup();

    render(<CommandPalette />);

    const addProject = screen.getByTestId("palette-add-folder");
    await user.hover(addProject.parentElement!);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "Add this folder as a project",
      );
    });

    fireEvent.click(addProject);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("shows the disabled add-project tooltip while keeping the action unavailable", async () => {
    mocks.palette.query = "~/project";
    const user = userEvent.setup();

    render(<CommandPalette />);

    const addProject = screen.getByTestId("palette-add-folder");
    expect(addProject).toBeDisabled();
    await user.hover(addProject.parentElement!);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "Choose a folder before adding a project",
      );
    });
  });
});
