import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";

interface FakeWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

const store = vi.hoisted(() => ({
  workspaces: [] as FakeWorkspace[],
  activeWorkspaceId: null as string | null,
  beginNewThread: vi.fn(),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

import { ProjectChooser } from "../ProjectChooser";

function renderChooser() {
  return render(<ProjectChooser trigger={<button type="button">choose a project</button>} />);
}

function addProjectRow() {
  return screen.getByRole("button", { name: /^Add project/ });
}

async function openChooser() {
  const user = userEvent.setup();
  renderChooser();
  await user.click(screen.getByRole("button", { name: "choose a project" }));
  return { user, chooser: await screen.findByRole("dialog", { name: "Choose project" }) };
}

describe("ProjectChooser", () => {
  beforeEach(() => {
    store.workspaces = [];
    store.activeWorkspaceId = null;
    store.beginNewThread.mockReset();
    useCommandPaletteStore.getState().close();
    Element.prototype.scrollIntoView = () => {};
  });

  it("offers to add a folder when there are no projects", async () => {
    const { chooser } = await openChooser();

    expect(chooser).toHaveTextContent("No projects yet");
    expect(chooser).toHaveTextContent("Add a folder to start working in its code.");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(within(addProjectRow()).getByText("Folder")).toBeVisible();
  });

  it("opens the palette on Sources from the Add project row and closes", async () => {
    const { user } = await openChooser();

    await user.click(addProjectRow());

    await waitFor(() => expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "sources" }]));
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull());
  });

  describe("with projects", () => {
    beforeEach(() => {
      store.workspaces = [
        { id: "ws-1", name: "fixture-repo", path: "/repo/fixture" },
        { id: "ws-2", name: "other-repo", path: "/work/other" },
      ];
      store.activeWorkspaceId = "ws-1";
    });

    it("lists projects with a check on the active one, above the Add project row", async () => {
      const { chooser } = await openChooser();

      const options = screen.getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual(["fixture-repo", "other-repo"]);
      expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
      expect(chooser).not.toHaveTextContent("No projects yet");
      expect(addProjectRow()).toBeVisible();
    });

    it("filters by name or folder", async () => {
      const { user } = await openChooser();

      await user.type(screen.getByRole("combobox", { name: "Search projects" }), "WORK");

      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["other-repo"]);
    });

    it("switches the new thread to the chosen project and closes", async () => {
      const { user } = await openChooser();

      await user.click(screen.getByRole("option", { name: "other-repo" }));

      expect(store.beginNewThread.mock.calls).toEqual([["ws-2"]]);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull());
    });
  });
});
