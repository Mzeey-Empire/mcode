import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FileReadResult } from "@mcode/contracts";
import { FilesTool } from "../FilesTool";
import { useFilesTabsStore } from "../filesTabsStore";

const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  getWorkspaceFileChanges: vi.fn(),
  readFileContent: vi.fn(),
  refreshWorkspaceFiles: vi.fn(),
}));
const scrollToIndex = vi.hoisted(() => vi.fn());

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => transport }));
vi.mock("@/hooks/useOpenInApps", () => ({ useOpenInApps: () => [] }));
// jsdom has no layout; paint only the first rows so a 10k-line file stays cheap to render.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 60) }, (_, index) => ({ key: index, index, start: index * estimateSize(), size: estimateSize() })),
    scrollToIndex,
    measureElement: vi.fn(),
  }),
}));

const WORKSPACE = "ws-1";
const PATH = "src/big.ts";
const LINE_COUNT = 10_000;
// Every 100th line holds "needle", so 100 matches; the rest hold "hay".
const CONTENT = Array.from({ length: LINE_COUNT }, (_, line) => `line ${line} ${line % 100 === 0 ? "needle" : "hay"}`).join("\n");

function bigFile(): FileReadResult {
  return { kind: "text", path: PATH, size: CONTENT.length, encoding: "utf-8", content: CONTENT, changedLines: null };
}

async function openFind() {
  // A wide body docks the tree beside the code, so the code view is what the body shows.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 900, height: 600 }));
  useFilesTabsStore.getState().openFile(WORKSPACE, PATH);
  render(<FilesTool workspaceId={WORKSPACE} threadId={null} scopeId={WORKSPACE} />);
  await screen.findByTestId("code-file-view");
  fireEvent.click(screen.getByRole("button", { name: "Find in file" }));
  return screen.getByRole("textbox", { name: "Find" });
}

function currentMatchLine(): string | null {
  return document.querySelector('mark[data-find-match="current"]')?.closest("[data-line]")?.getAttribute("data-line") ?? null;
}

beforeEach(() => {
  useFilesTabsStore.setState({ scopes: {} });
  scrollToIndex.mockClear();
  transport.listWorkspaceFiles.mockResolvedValue({ paths: [PATH], truncated: false });
  transport.getWorkspaceFileChanges.mockResolvedValue({ git: true, truncated: false, entries: [] });
  transport.readFileContent.mockImplementation(() => Promise.resolve(bigFile()));
  transport.refreshWorkspaceFiles.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Find in file", () => {
  it("updates the count as the query changes and highlights the first match", async () => {
    const field = await openFind();

    fireEvent.change(field, { target: { value: "needle" } });
    expect(await screen.findByText("1 of 100")).toBeTruthy();
    expect(currentMatchLine()).toBe("1");

    fireEvent.change(field, { target: { value: "needles" } });
    expect(await screen.findByText("No results")).toBeTruthy();
    expect(currentMatchLine()).toBeNull();
  });

  it("steps with Enter and Shift+Enter, wrapping, and scrolls to the match's line", async () => {
    const field = await openFind();
    fireEvent.change(field, { target: { value: "needle" } });
    await screen.findByText("1 of 100");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByText("2 of 100")).toBeTruthy();
    expect(scrollToIndex).toHaveBeenLastCalledWith(100, { align: "auto" });

    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(await screen.findByText("100 of 100")).toBeTruthy();
    expect(scrollToIndex).toHaveBeenLastCalledWith(9900, { align: "auto" });
  });

  it("flags a pattern that does not compile instead of throwing", async () => {
    const field = await openFind();
    fireEvent.click(screen.getByRole("button", { name: "Use regular expression" }));

    fireEvent.change(field, { target: { value: "(" } });

    expect(await screen.findByText("Invalid pattern")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("closes on Escape, drops the highlights, and returns focus to the code", async () => {
    const field = await openFind();
    fireEvent.change(field, { target: { value: "needle" } });
    await screen.findByText("1 of 100");

    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
    expect(document.querySelector("mark")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("code-file-view"));
  });

  it("closes on Escape pressed in the code after focus left the bar", async () => {
    const field = await openFind();
    fireEvent.change(field, { target: { value: "needle" } });
    await screen.findByText("1 of 100");

    fireEvent.keyDown(screen.getByTestId("code-file-view"), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
    expect(document.querySelector("mark")).toBeNull();
  });

  it("handles Escape and Ctrl+F while focus sits on a toggle instead of the field", async () => {
    const field = await openFind();
    const toggle = screen.getByRole("button", { name: "Match case" });
    toggle.focus();

    fireEvent.keyDown(toggle, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(field);

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
  });
});
