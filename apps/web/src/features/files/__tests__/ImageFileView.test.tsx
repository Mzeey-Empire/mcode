import { mockTransport } from "@/__tests__/mocks/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileReadResult, WorkspaceFileChanges } from "@mcode/contracts";
import { FilesTool } from "../FilesTool";
import { useFilesTabsStore } from "../filesTabsStore";

const transport = {
  listWorkspaceFiles: vi.mocked(mockTransport.listWorkspaceFiles),
  getWorkspaceFileChanges: vi.mocked(mockTransport.getWorkspaceFileChanges),
  readFileContent: vi.mocked(mockTransport.readFileContent),
  refreshWorkspaceFiles: vi.mocked(mockTransport.refreshWorkspaceFiles),
};

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.listWorkspaceFiles).mockReset();
  vi.mocked(mockTransport.getWorkspaceFileChanges).mockReset();
  vi.mocked(mockTransport.readFileContent).mockReset();
  vi.mocked(mockTransport.refreshWorkspaceFiles).mockReset();
});
vi.mock("@/hooks/useOpenInApps", () => ({ useOpenInApps: () => [] }));
vi.mock("@/lib/server-image-url", () => ({ buildServerImageUrl: (url: string) => `http://server${url}` }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * estimateSize(), size: estimateSize() })),
  }),
}));

const WORKSPACE = "ws-1";
const NO_CHANGES: WorkspaceFileChanges = { git: true, truncated: false, entries: [] };
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';

function imageFile(path: string, mime: string): FileReadResult {
  return { kind: "image", path, size: 182 * 1024, mime, url: `/workspace-images/${path}` };
}

function openImage(path: string, mime: string) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 900, height: 600 }));
  transport.listWorkspaceFiles.mockResolvedValue({ paths: [path], truncated: false });
  transport.readFileContent.mockImplementation((_ws: string, readPath: string, _thread?: string, as?: "text") =>
    Promise.resolve(
      as === "text"
        ? { kind: "text", path: readPath, size: SVG_SOURCE.length, encoding: "utf-8", content: SVG_SOURCE, changedLines: null }
        : imageFile(readPath, mime),
    ),
  );
  useFilesTabsStore.getState().openFile(WORKSPACE, path);
  render(<FilesTool workspaceId={WORKSPACE} threadId={null} scopeId={WORKSPACE} />);
}

function loadImage(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
}

beforeEach(() => {
  useFilesTabsStore.setState({ scopes: {} });
  transport.getWorkspaceFileChanges.mockResolvedValue(NO_CHANGES);
  transport.refreshWorkspaceFiles.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImageFileView", () => {
  it("shows dimensions and size in the chip once the image loads", async () => {
    openImage("assets/hero.png", "image/png");
    const img = await screen.findByRole("img", { name: "assets/hero.png" });
    expect(screen.getByTestId("files-image-chip").textContent).toBe("182 KB");
    loadImage(img, 1440, 900);
    expect(screen.getByTestId("files-image-chip").textContent).toBe("1440×900 · 182 KB");
  });

  it("sizes the image for Fit, 100% and 200%", async () => {
    openImage("assets/hero.png", "image/png");
    const img = await screen.findByRole("img", { name: "assets/hero.png" });
    loadImage(img, 1440, 900);
    expect(img.style.maxWidth).toBe("100%");
    expect(img.style.width).toBe("");

    act(() => useFilesTabsStore.getState().setImageScale(WORKSPACE, "assets/hero.png", "100"));
    expect(screen.getByRole("button", { name: "Scale 100%" })).toBeTruthy();
    expect(img.style.width).toBe("1440px");
    expect(img.style.height).toBe("900px");

    act(() => useFilesTabsStore.getState().setImageScale(WORKSPACE, "assets/hero.png", "200"));
    expect(screen.getByRole("button", { name: "Scale 200%" })).toBeTruthy();
    expect(img.style.width).toBe("2880px");
    expect(img.style.height).toBe("1800px");
  });

  it("reads SVG text only after flipping to Source, and shows the image again on Preview", async () => {
    openImage("icons/logo.svg", "image/svg+xml");
    await screen.findByRole("img", { name: "icons/logo.svg" });
    expect(transport.readFileContent.mock.calls.some((call) => call[3] === "text")).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    await waitFor(() => expect(screen.getByTestId("code-file-view").textContent).toContain('<rect width="4"'));
    expect(transport.readFileContent).toHaveBeenCalledWith(WORKSPACE, "icons/logo.svg", undefined, "text");
    expect(screen.queryByRole("img")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
    expect(screen.getByRole("img", { name: "icons/logo.svg" })).toBeTruthy();
  });
});
