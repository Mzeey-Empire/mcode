import { createMockWorkspace } from "@mcode/contracts/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "../state/workspaceStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { ProjectChooser } from "../ProjectChooser";

const PROTOCOL = createMockWorkspace({ id: "ws-protocol", name: "protocol-api", path: "/repo/protocol-api" });
const NOTES = createMockWorkspace({ id: "ws-notes", name: "notes-app", path: "/work/notes-app" });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });

function seedStore(workspaces: ReturnType<typeof createMockWorkspace>[], activeWorkspaceId: string | null) {
  useWorkspaceStore.setState({
    workspaces,
    workspacesLoaded: true,
    activeWorkspaceId,
    activeThreadId: null,
    threads: [],
    newThreadTarget: { kind: "project" },
    pendingNewThread: false,
  });
}

async function openChooser() {
  const user = userEvent.setup();
  render(<ProjectChooser trigger={<button type="button">choose a project</button>} />);
  await user.click(screen.getByRole("button", { name: "choose a project" }));
  const chooser = await screen.findByRole("dialog", { name: "Choose project" });
  return { user, chooser };
}

function expectRows(names: string[]) {
  expect(screen.queryAllByRole("option")).toEqual(names.map((name) => screen.getByRole("option", { name })));
}

function addProjectRow() {
  return screen.getByRole("button", { name: /^Add project/ });
}

describe("ProjectChooser", () => {
  beforeEach(() => {
    seedStore([], null);
    useCommandPaletteStore.getState().close();
    Element.prototype.scrollIntoView = () => {};
  });

  describe("with no projects", () => {
    it("offers No project, then Add project, without a No projects yet block", async () => {
      const { chooser } = await openChooser();

      expectRows(["No project"]);
      expect(chooser).not.toHaveTextContent("No projects yet");
      expect(within(addProjectRow()).getByText("Folder")).toBeVisible();
    });

    it("opens the palette on Sources from the Add project row and closes", async () => {
      const { user } = await openChooser();

      await user.click(addProjectRow());

      await waitFor(() => expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "sources" }]));
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull());
    });
  });

  describe("with projects", () => {
    beforeEach(() => seedStore([PROTOCOL, NOTES, HIDDEN], PROTOCOL.id));

    it("leads with No project, then the projects with a check on the active one, above Add project", async () => {
      await openChooser();

      expectRows(["No project", "protocol-api", "notes-app"]);
      expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
      expect(addProjectRow()).toBeVisible();
    });

    it("never lists a hidden No project workspace as a project", async () => {
      await openChooser();

      expect(screen.getAllByRole("option", { name: "No project" })).toHaveLength(1);
    });

    it("hides No project when the search does not begin its name", async () => {
      const { user } = await openChooser();

      await user.type(screen.getByRole("combobox", { name: "Search projects" }), "pro");

      expectRows(["protocol-api"]);
    });

    it("shows No project after the matching projects when the search begins its name", async () => {
      const { user } = await openChooser();

      await user.type(screen.getByRole("combobox", { name: "Search projects" }), "no");

      expectRows(["notes-app", "No project"]);
    });

    it("ignores case and outer spaces in the search, and hides No project once the search runs past its name", async () => {
      const { user } = await openChooser();
      const search = screen.getByRole("combobox", { name: "Search projects" });

      await user.type(search, "  NO Project ");
      expectRows(["No project"]);

      await user.type(search, "s");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("filters projects by name or folder", async () => {
      const { user } = await openChooser();

      await user.type(screen.getByRole("combobox", { name: "Search projects" }), "WORK");

      expectRows(["notes-app"]);
    });

    it("picks the first row on Enter, so a search for no opens the matching project, not No project", async () => {
      const { user } = await openChooser();

      await user.type(screen.getByRole("combobox", { name: "Search projects" }), "no{Enter}");

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(NOTES.id);
      expect(useWorkspaceStore.getState().newThreadTarget).toEqual({ kind: "project" });
    });

    it("starts the new thread in the chosen project and closes", async () => {
      const { user } = await openChooser();

      await user.click(screen.getByRole("option", { name: "notes-app" }));

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(NOTES.id);
      expect(useWorkspaceStore.getState().pendingNewThread).toBe(true);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull());
    });

    it("moves the new thread to No project: no active project, and the check follows", async () => {
      const { user } = await openChooser();

      await user.click(screen.getByRole("option", { name: "No project" }));

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
      expect(useWorkspaceStore.getState().pendingNewThread).toBe(true);
      expect(useWorkspaceStore.getState().newThreadTarget.kind).toBe("no-project");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull());

      await user.click(screen.getByRole("button", { name: "choose a project" }));
      await screen.findByRole("dialog", { name: "Choose project" });
      expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    });
  });
});
