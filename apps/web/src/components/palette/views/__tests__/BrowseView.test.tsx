import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let pendingConfirm: (() => void) | null = null;
  let pendingBack: (() => void) | null = null;
  const palette = {
    query: "~/",
    setQuery: vi.fn(),
    setPendingConfirm: vi.fn((action: (() => void) | null) => {
      pendingConfirm = action;
    }),
    setPendingBack: vi.fn((action: (() => void) | null) => {
      pendingBack = action;
    }),
    close: vi.fn(),
  };
  const workspace = {
    createWorkspace: vi.fn(),
    beginNewThread: vi.fn(),
  };

  return {
    palette,
    workspace,
    filesystemBrowse: vi.fn(),
    getPendingConfirm: () => pendingConfirm,
    getPendingBack: () => pendingBack,
  };
});

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: typeof mocks.palette) => unknown) =>
    selector(mocks.palette),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.workspace) => unknown) =>
    selector(mocks.workspace),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ filesystemBrowse: mocks.filesystemBrowse }),
}));

vi.mock("@/lib/platform", () => ({ isMac: false, isWindows: true }));

vi.mock("@/components/ui/command", () => ({
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <section aria-label={heading}>{children}</section>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => <button type="button" onClick={onSelect}>{children}</button>,
}));

import { BrowseView } from "../BrowseView";

describe("BrowseView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.palette.query = "~/";
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/home/mcode",
      parent: "/home",
      entries: [
        { name: "Documents", isDir: true },
        { name: "Projects", isDir: true },
        { name: "README.md", isDir: false },
      ],
      isExactDirectory: true,
      isTooBroad: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.desktopBridge;
  });

  it("filters folders with the leaf query without offering Add, and descends into the selected folder", async () => {
    mocks.palette.query = "~/pro";

    render(<BrowseView />);

    const project = await screen.findByRole("button", { name: /projects/i });
    expect(screen.queryByRole("button", { name: /documents/i })).not.toBeInTheDocument();
    expect(mocks.getPendingConfirm()).toBeNull();

    fireEvent.click(project);

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("~/Projects/");
  });

  it("registers usable keyboard actions for an exact directory and ascends to its parent", async () => {
    mocks.palette.query = "~/projects/";

    render(<BrowseView />);

    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
    await waitFor(() => expect(mocks.getPendingBack()).toEqual(expect.any(Function)));

    mocks.getPendingBack()?.();

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("/home/");
  });

  it("roots a bare selected drive before returning to browse mode", async () => {
    mocks.palette.query = "/";
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/",
      parent: null,
      entries: [{ name: "C:", isDir: true }],
      isExactDirectory: true,
      isTooBroad: true,
    });

    render(<BrowseView />);

    fireEvent.click(await screen.findByRole("button", { name: /c:/i }));

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("C:\\");
    expect(mocks.getPendingConfirm()).toBeNull();
    expect(mocks.getPendingBack()).toBeNull();
  });

  it("keeps Add unavailable in a folder too broad to add", async () => {
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/home/mcode",
      parent: "/home",
      entries: [{ name: "src", isDir: true }],
      isExactDirectory: true,
      isTooBroad: true,
    });

    render(<BrowseView />);

    expect(await screen.findByRole("region", { name: "Folders" })).toBeInTheDocument();
    expect(mocks.getPendingConfirm()).toBeNull();
  });

  it("names an addable folder and opens the project it registers", async () => {
    mocks.palette.query = "~/src/mcode/";
    const workspace = { id: "ws-mcode" };
    mocks.workspace.createWorkspace.mockResolvedValue({ ok: true, workspace, reused: true });
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/home/mcode/src/mcode",
      parent: "/home/mcode/src",
      entries: [{ name: "apps", isDir: true }],
      isExactDirectory: true,
      isTooBroad: false,
    });

    render(<BrowseView />);

    expect(await screen.findByRole("region", { name: "Folders in mcode" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
    mocks.getPendingConfirm()?.();

    await waitFor(() => expect(mocks.palette.close).toHaveBeenCalledOnce());
    expect(mocks.workspace.createWorkspace).toHaveBeenCalledWith(undefined, "/home/mcode/src/mcode");
    expect(mocks.workspace.beginNewThread).toHaveBeenCalledWith("ws-mcode");
  });

  it("names an empty folder above its empty state and keeps it addable", async () => {
    mocks.palette.query = "~/src/mcode/";
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/home/mcode/src/mcode",
      parent: "/home/mcode/src",
      entries: [],
      isExactDirectory: true,
      isTooBroad: false,
    });

    render(<BrowseView />);

    const empty = await screen.findByText("No subfolders here.");
    const heading = screen.getByRole("region", { name: "Folders in mcode" });
    expect(heading.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
  });

  it("says why a folder could not be added and keeps the palette open", async () => {
    mocks.palette.query = "~/gone/";
    mocks.workspace.createWorkspace.mockResolvedValue({
      ok: false,
      error: { code: "path_not_found", message: "server copy" },
    });

    render(<BrowseView />);

    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
    mocks.getPendingConfirm()?.();

    expect(await screen.findByRole("alert")).toHaveTextContent("This folder doesn't exist.");
    expect(mocks.palette.close).not.toHaveBeenCalled();
    expect(mocks.workspace.beginNewThread).not.toHaveBeenCalled();
    expect(mocks.getPendingConfirm()).toBeNull();
  });

  it("shows fixed copy instead of a transport failure and lets the user retry", async () => {
    mocks.palette.query = "~/projects/";
    mocks.workspace.createWorkspace.mockRejectedValue(new Error("socket closed: ECONNRESET 127.0.0.1"));

    render(<BrowseView />);

    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
    mocks.getPendingConfirm()?.();

    expect(await screen.findByRole("alert")).toHaveTextContent("Mcode couldn't add this folder. Try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("ECONNRESET");
    expect(mocks.getPendingConfirm()).toEqual(expect.any(Function));
  });

  it("hides Open in File Explorer on the web", async () => {
    render(<BrowseView />);

    await screen.findByRole("button", { name: /projects/i });
    expect(screen.queryByRole("button", { name: /open in/i })).not.toBeInTheDocument();
  });

  it("adds the folder chosen in the native dialog on desktop", async () => {
    const showOpenDialog = vi.fn().mockResolvedValue("/home/mcode/src/app");
    window.desktopBridge = { showOpenDialog } as unknown as typeof window.desktopBridge;
    mocks.workspace.createWorkspace.mockResolvedValue({ ok: true, workspace: { id: "ws-app" }, reused: false });

    render(<BrowseView />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in File Explorer" }));

    await waitFor(() => expect(mocks.workspace.beginNewThread).toHaveBeenCalledWith("ws-app"));
    expect(mocks.workspace.createWorkspace).toHaveBeenCalledWith(undefined, "/home/mcode/src/app");
    expect(mocks.palette.close).toHaveBeenCalledOnce();
  });

  it("keeps the browsed folder addable when a folder picked in the dialog is rejected", async () => {
    window.desktopBridge = { showOpenDialog: vi.fn().mockResolvedValue("/") } as unknown as typeof window.desktopBridge;
    mocks.palette.query = "~/projects/";
    mocks.workspace.createWorkspace.mockResolvedValue({
      ok: false,
      error: { code: "too_broad", message: "server copy" },
    });

    render(<BrowseView />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in File Explorer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a project folder, not your home folder or a drive.");
    expect(mocks.getPendingConfirm()).toEqual(expect.any(Function));
  });
});
