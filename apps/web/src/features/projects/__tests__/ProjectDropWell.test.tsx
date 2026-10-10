import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ openCommandPalette: vi.fn() }));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: Object.assign(vi.fn(), {
    getState: () => ({ open: hoisted.openCommandPalette }),
  }),
}));

import { ProjectDropWell } from "../ProjectDropWell";

const droppedFolder = new File([], "proj");

function fileTransfer(files: File[] = [droppedFolder]) {
  return { types: ["Files"], files, dropEffect: "none" };
}

function well(): HTMLElement {
  return screen.getByTestId("project-drop-well");
}

function setDesktopBridge(bridge: unknown): void {
  Object.defineProperty(window, "desktopBridge", { value: bridge, configurable: true, writable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setDesktopBridge(undefined);
});

describe("ProjectDropWell on the web", () => {
  it("points at the + button and does not react to drops", () => {
    render(<ProjectDropWell />);

    expect(screen.getByText("No projects")).toBeInTheDocument();
    expect(screen.getByText("Use + to add a project.")).toBeInTheDocument();

    fireEvent.dragEnter(well(), { dataTransfer: fileTransfer() });
    expect(well()).toHaveAttribute("data-state", "idle");
    fireEvent.drop(well(), { dataTransfer: fileTransfer() });
    expect(hoisted.openCommandPalette).not.toHaveBeenCalled();
  });
});

describe("ProjectDropWell on desktop", () => {
  const getPathForFile = vi.fn<(file: File) => string>();

  beforeEach(() => {
    getPathForFile.mockReturnValue("C:\\proj");
    setDesktopBridge({ getPathForFile });
  });

  it("invites a folder drop while idle", () => {
    render(<ProjectDropWell />);

    expect(screen.getByText("No projects")).toBeInTheDocument();
    expect(screen.getByText("Drop a folder here or use + to add one.")).toBeInTheDocument();
  });

  it("shows the drop prompt during a file drag and clears it when the drag leaves", () => {
    render(<ProjectDropWell />);

    fireEvent.dragEnter(well(), { dataTransfer: fileTransfer() });
    expect(well()).toHaveAttribute("data-state", "over");
    expect(screen.getByText("Drop to add project")).toBeInTheDocument();
    expect(screen.queryByText("No projects")).not.toBeInTheDocument();

    fireEvent.dragLeave(well(), { dataTransfer: fileTransfer() });
    expect(well()).toHaveAttribute("data-state", "idle");
    expect(screen.getByText("No projects")).toBeInTheDocument();
  });

  it("ignores drags that carry no files", () => {
    render(<ProjectDropWell />);

    fireEvent.dragEnter(well(), { dataTransfer: { types: ["text/plain"], files: [] } });

    expect(well()).toHaveAttribute("data-state", "idle");
  });

  it("opens the add-project palette at the dropped path", () => {
    render(<ProjectDropWell />);

    fireEvent.dragEnter(well(), { dataTransfer: fileTransfer() });
    fireEvent.drop(well(), { dataTransfer: fileTransfer() });

    expect(getPathForFile).toHaveBeenCalledWith(droppedFolder);
    expect(hoisted.openCommandPalette).toHaveBeenCalledWith({ intent: "addProject", path: "C:\\proj" });
    expect(well()).toHaveAttribute("data-state", "idle");
  });

  it("does not open the palette when the bridge cannot resolve a path", () => {
    getPathForFile.mockReturnValue("");
    render(<ProjectDropWell />);

    fireEvent.drop(well(), { dataTransfer: fileTransfer() });

    expect(hoisted.openCommandPalette).not.toHaveBeenCalled();
  });
});
