import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileReadResult, WorkspaceFileChanges } from "@mcode/contracts";
import { pushEmitter } from "@/transport";
import { FilesTool } from "../FilesTool";
import { getFilesScope, useFilesTabsStore } from "../filesTabsStore";

const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  getWorkspaceFileChanges: vi.fn(),
  readFileContent: vi.fn(),
  refreshWorkspaceFiles: vi.fn(),
}));

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => transport }));
vi.mock("@/hooks/useOpenInApps", () => ({ useOpenInApps: () => [] }));
// jsdom has no layout, so render every virtual row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * estimateSize(), size: estimateSize() })),
    scrollToIndex: vi.fn(),
    measureElement: vi.fn(),
  }),
}));

const WORKSPACE = "ws-1";
const PATHS = ["src/a.ts", "src/b.ts", "README.md"];
const NO_CHANGES: WorkspaceFileChanges = { git: true, truncated: false, entries: [] };

function textFile(path: string, changedLines: [number, number][] | null): FileReadResult {
  return { kind: "text", path, size: 20, encoding: "utf-8", content: "one\ntwo\nthree", changedLines };
}

function setBodyWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width, height: 600 }));
}

function renderTool() {
  return render(<FilesTool workspaceId={WORKSPACE} threadId={null} scopeId={WORKSPACE} />);
}

beforeEach(() => {
  useFilesTabsStore.setState({ scopes: {} });
  transport.listWorkspaceFiles.mockResolvedValue({ paths: PATHS, truncated: false });
  transport.getWorkspaceFileChanges.mockResolvedValue(NO_CHANGES);
  transport.readFileContent.mockImplementation((_ws: string, path: string) => Promise.resolve(textFile(path, null)));
  transport.refreshWorkspaceFiles.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FilesTool layout", () => {
  it("docks the tree beside the code at 900px", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    await screen.findByTestId("code-file-view");
    expect(screen.getByTestId("files-docked-tree")).toBeTruthy();
  });

  it("shows the tree as the body at 536px and swaps to the file when one opens", async () => {
    setBodyWidth(536);
    renderTool();
    await screen.findByTestId("files-tree-body");
    fireEvent.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    await screen.findByTestId("code-file-view");
    expect(screen.queryByTestId("files-docked-tree")).toBeNull();
    expect(screen.queryByTestId("files-tree-body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show files tree" }));
    expect(screen.getByTestId("files-tree-body")).toBeTruthy();
    expect(screen.queryByTestId("code-file-view")).toBeNull();
  });

  it("shows the tree after the last tab closes", async () => {
    setBodyWidth(536);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    useFilesTabsStore.getState().setTreeOpen(WORKSPACE, false);
    renderTool();
    await screen.findByTestId("code-file-view");
    act(() => useFilesTabsStore.getState().closeFile(WORKSPACE, "src/a.ts"));
    expect(screen.getByTestId("files-tree-body")).toBeTruthy();
  });
});

describe("FilesTool freshness", () => {
  it("refreshes marks and changed-line bars on files.changed", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    useFilesTabsStore.getState().toggleFolder(WORKSPACE, "src");
    renderTool();
    const view = await screen.findByTestId("code-file-view");
    await waitFor(() => expect(transport.getWorkspaceFileChanges).toHaveBeenCalled());
    expect(view.querySelector("[data-changed]")).toBeNull();
    expect(screen.queryByLabelText("Modified")).toBeNull();

    transport.getWorkspaceFileChanges.mockResolvedValue({ ...NO_CHANGES, entries: [{ path: "src/a.ts", mark: "M" }] });
    transport.readFileContent.mockImplementation((_ws: string, path: string) => Promise.resolve(textFile(path, [[2, 2]])));
    act(() => pushEmitter.emit("files.changed", { workspaceId: WORKSPACE, changedPaths: ["src/a.ts"] }));

    await waitFor(() => expect(screen.getByTestId("code-file-view").querySelector('[data-line="2"]')?.hasAttribute("data-changed")).toBe(true));
    expect(screen.getByTestId("code-file-view").querySelector('[data-line="1"]')?.hasAttribute("data-changed")).toBe(false);
    const tree = screen.getByTestId("files-docked-tree");
    await waitFor(() => expect(within(tree).getByLabelText("Modified")).toBeTruthy());
  });

  it("caps the tree drag at the widest width that still docks", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    await screen.findByTestId("code-file-view");
    const separator = screen.getByRole("separator", { name: "Resize files tree" });
    separator.setPointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 1 });
    expect(getFilesScope(WORKSPACE).treeWidth).toBe(380);
    expect(screen.getByTestId("files-docked-tree")).toBeTruthy();
  });

  it("numbers a file that ends in a newline without a phantom last line", async () => {
    setBodyWidth(900);
    transport.readFileContent.mockResolvedValue({ ...textFile("src/a.ts", null), content: "one\ntwo\n" });
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    const view = await screen.findByTestId("code-file-view");
    expect(view.querySelectorAll("[data-line]")).toHaveLength(2);
  });

  it("ignores files.changed for another workspace", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    await screen.findByTestId("code-file-view");
    const reads = transport.readFileContent.mock.calls.length;
    act(() => pushEmitter.emit("files.changed", { workspaceId: "other", changedPaths: ["src/a.ts"] }));
    expect(transport.readFileContent.mock.calls.length).toBe(reads);
  });
});

describe("FilesTool Go to file", () => {
  it("opens beside the active tab without switching on Ctrl+Enter", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    await screen.findByTestId("code-file-view");
    act(() => useFilesTabsStore.getState().setGoToFileOpen(WORKSPACE, true));
    const input = await screen.findByRole("textbox", { name: "Go to file" });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    const scope = getFilesScope(WORKSPACE);
    expect(scope.openPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope.activePath).toBe("src/a.ts");
    expect(screen.queryByRole("dialog", { name: "Go to file" })).toBeNull();
  });

  it("opens and activates on Enter", async () => {
    setBodyWidth(900);
    useFilesTabsStore.getState().openFile(WORKSPACE, "src/a.ts");
    renderTool();
    await screen.findByTestId("code-file-view");
    act(() => useFilesTabsStore.getState().setGoToFileOpen(WORKSPACE, true));
    const input = await screen.findByRole("textbox", { name: "Go to file" });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getFilesScope(WORKSPACE).activePath).toBe("src/b.ts");
  });
});
