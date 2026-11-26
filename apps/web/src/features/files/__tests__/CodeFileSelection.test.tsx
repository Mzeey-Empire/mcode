import { mockTransport } from "@/__tests__/mocks/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FileReadResult, WorkspaceFileChanges } from "@mcode/contracts/models/workspace-file";
import { FilesTool } from "../FilesTool";
import { useConnectionStore } from "@/stores/connectionStore";
import { useFilesTabsStore } from "../filesTabsStore";

const WORKSPACE = "ws-1";
const PATH = "src/a.ts";
const LINES = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const NO_CHANGES: WorkspaceFileChanges = { git: true, truncated: false, entries: [] };

const visible = vi.hoisted(() => ({ start: 0, end: 9 }));

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));
vi.mock("@/hooks/useOpenInApps", () => ({ useOpenInApps: () => [] }));
// jsdom has no layout, so the fake virtualizer takes its window from `visible`; the file tree shares it and uses the default extractor.
vi.mock("@tanstack/react-virtual", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-virtual")>("@tanstack/react-virtual");
  return {
    ...actual,
    useVirtualizer: ({
      count,
      estimateSize,
      getItemKey,
      rangeExtractor,
    }: {
      count: number;
      estimateSize: (i: number) => number;
      getItemKey: (i: number) => string;
      rangeExtractor?: (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => number[];
    }) => ({
      getTotalSize: () => count * 20,
      getVirtualItems: () =>
        (rangeExtractor ?? actual.defaultRangeExtractor)({ startIndex: visible.start, endIndex: Math.min(visible.end, count - 1), overscan: 0, count }).map((index) => ({
          key: getItemKey(index),
          index,
          start: index * 20,
          size: estimateSize(index),
        })),
      scrollToIndex: () => {},
      measureElement: () => {},
    }),
  };
});

function textFile(path: string): FileReadResult {
  return { kind: "text", path, size: 800, encoding: "utf-8", content: LINES.join("\n") };
}

function lineText(line: number): Node {
  const text = document.querySelector(`[data-line="${line}"] [data-line-text]`)?.firstChild;
  if (!text) throw new Error(`line ${line} is not mounted`);
  return text;
}

function select(start: { line: number; offset: number }, end: { line: number; offset: number }) {
  const range = document.createRange();
  range.setStart(lineText(start.line), start.offset);
  range.setEnd(lineText(end.line), end.offset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

async function openFile() {
  useFilesTabsStore.getState().openFile(WORKSPACE, PATH);
  const view = render(<FilesTool workspaceId={WORKSPACE} threadId={null} scopeId={WORKSPACE} />);
  const viewport = await screen.findByTestId("code-file-view", undefined, { timeout: 5000 });
  return { viewport, rerender: () => view.rerender(<FilesTool workspaceId={WORKSPACE} threadId={null} scopeId={WORKSPACE} />) };
}

beforeEach(() => {
  visible.start = 0;
  visible.end = 9;
  useFilesTabsStore.setState({ scopes: {} });
  useConnectionStore.getState().setStatus("connected");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 900, height: 600 }));
  vi.mocked(mockTransport.listWorkspaceFiles).mockResolvedValue({ paths: [PATH], truncated: false });
  vi.mocked(mockTransport.getWorkspaceFileChanges).mockResolvedValue(NO_CHANGES);
  vi.mocked(mockTransport.readFileContent).mockImplementation((_ws: string, path: string) => Promise.resolve(textFile(path)));
  vi.mocked(mockTransport.refreshWorkspaceFiles).mockResolvedValue(undefined);
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
});

describe("Files text selection", () => {
  it("keeps the row where a selection starts mounted after it scrolls out of view", async () => {
    const { rerender } = await openFile();
    select({ line: 2, offset: 6 }, { line: 9, offset: 3 });

    visible.start = 25;
    visible.end = 34;
    rerender();

    expect(document.querySelector('[data-line="2"]')).not.toBeNull();
    expect(document.querySelector('[data-line="12"]')).toBeNull();
    expect(document.getSelection()?.anchorNode).toBe(lineText(2));
  });

  it("copies every selected line, including rows that are not mounted", async () => {
    const { viewport, rerender } = await openFile();
    select({ line: 2, offset: 6 }, { line: 9, offset: 3 });
    visible.start = 25;
    visible.end = 34;
    rerender();
    select({ line: 2, offset: 6 }, { line: 30, offset: 5 });

    const setData = vi.fn();
    fireEvent.copy(viewport, { clipboardData: { setData } });

    const expected = [LINES[1]!.slice(6), ...LINES.slice(2, 29), LINES[29]!.slice(0, 5)].join("\n");
    expect(setData).toHaveBeenCalledWith("text/plain", expected);
  });
});
