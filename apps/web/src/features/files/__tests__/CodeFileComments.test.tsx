import { mockTransport } from "@/__tests__/mocks/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LexicalEditor } from "lexical";
import type { FileReadResult, WorkspaceFileChanges } from "@mcode/contracts";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { saveDraftFileComment } from "@/features/conversation/composer/draft/draft-file-comments";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { FilesTool } from "../FilesTool";
import { getFilesScope, useFilesTabsStore } from "../filesTabsStore";

const transport = {
  listWorkspaceFiles: vi.mocked(mockTransport.listWorkspaceFiles),
  getWorkspaceFileChanges: vi.mocked(mockTransport.getWorkspaceFileChanges),
  readFileContent: vi.mocked(mockTransport.readFileContent),
  refreshWorkspaceFiles: vi.mocked(mockTransport.refreshWorkspaceFiles),
};
const scrollToIndex = vi.hoisted(() => vi.fn());

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.listWorkspaceFiles).mockReset();
  vi.mocked(mockTransport.getWorkspaceFileChanges).mockReset();
  vi.mocked(mockTransport.readFileContent).mockReset();
  vi.mocked(mockTransport.refreshWorkspaceFiles).mockReset();
});
vi.mock("@/hooks/useOpenInApps", () => ({ useOpenInApps: () => [] }));
// jsdom has no layout, so render every virtual row; scrollToIndex is the layout seam the jump drives.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize, getItemKey }: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: getItemKey(index), index, start: index * 20, size: estimateSize(index) })),
    scrollToIndex,
    measureElement: () => {},
  }),
}));

const WORKSPACE = "ws-1";
const THREAD = "thread-1";
const PATH = "src/a.ts";
const LINES = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const NO_CHANGES: WorkspaceFileChanges = { git: true, truncated: false, entries: [] };

function textFile(path: string): FileReadResult {
  return { kind: "text", path, size: 400, encoding: "utf-8", content: LINES.join("\n"), changedLines: null };
}

function renderTool(threadId: string | null = THREAD) {
  return render(<FilesTool workspaceId={WORKSPACE} threadId={threadId} scopeId={threadId ?? WORKSPACE} />);
}

function draft() {
  return useComposerDraftStore.getState().drafts[THREAD];
}

async function typeNote(text: string) {
  const dialog = await screen.findByRole("dialog");
  const root = dialog.querySelector<HTMLElement>("[contenteditable]");
  const editor = (root as unknown as { __lexicalEditor?: LexicalEditor } | null)?.__lexicalEditor;
  await waitFor(() => expect(editor).toBeTruthy());
  await act(async () => writeComposerContent(editor!, text, []));
  return root!;
}

beforeEach(() => {
  useFilesTabsStore.setState({ scopes: {} });
  useComposerDraftStore.setState({ drafts: {} });
  scrollToIndex.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 900, height: 600 }));
  transport.listWorkspaceFiles.mockResolvedValue({ paths: [PATH], truncated: false });
  transport.getWorkspaceFileChanges.mockResolvedValue(NO_CHANGES);
  transport.readFileContent.mockImplementation((_ws: string, path: string) => Promise.resolve(textFile(path)));
  transport.refreshWorkspaceFiles.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openLine(line: number) {
  useFilesTabsStore.getState().openFile(THREAD, PATH);
  renderTool();
  fireEvent.click(await screen.findByRole("button", { name: `Comment on line ${line}` }));
}

describe("Files line comments", () => {
  it("saves a comment on line 14 into the composer draft with Enter", async () => {
    await openLine(14);
    const root = await typeNote("rename this");
    fireEvent.keyDown(root, { key: "Enter" });

    await waitFor(() => expect(draft()?.fileComments).toHaveLength(1));
    expect(draft()?.fileComments?.[0]).toMatchObject({ filePath: PATH, line: 14, lineContent: LINES[13], note: "rename this" });
    expect(draft()?.fileCommentEditor).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit comment on line 14" }).textContent).toBe("rename this");
  });

  it("closes a clean editor on Escape without saving", async () => {
    await openLine(3);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(draft()?.fileComments ?? []).toEqual([]);
  });

  it("discards typed text on Cancel", async () => {
    await openLine(3);
    await typeNote("half a thought");
    expect(draft()?.fileCommentEditor?.note).toBe("half a thought");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(draft()?.fileCommentEditor).toBeUndefined();
    expect(draft()?.fileComments ?? []).toEqual([]);
  });

  it("edits a saved comment in place and deletes it with the trash button", async () => {
    saveDraftFileComment(THREAD, { filePath: PATH, line: 5, lineContent: LINES[4]! }, { note: "first", mentions: [] });
    const saved = draft()!.fileComments![0]!;
    useFilesTabsStore.getState().openFile(THREAD, PATH);
    renderTool();

    fireEvent.click(await screen.findByRole("button", { name: "Edit comment on line 5" }));
    const root = await typeNote("second");
    fireEvent.keyDown(root, { key: "Enter" });
    await waitFor(() => expect(draft()?.fileComments?.[0]?.note).toBe("second"));
    expect(draft()!.fileComments).toHaveLength(1);
    expect(draft()!.fileComments![0]).toMatchObject({ id: saved.id, revision: saved.revision + 1 });

    fireEvent.click(screen.getByRole("button", { name: "Edit comment on line 5" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete comment" }));
    expect(draft()?.fileComments ?? []).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no comment button without a thread", async () => {
    useFilesTabsStore.getState().openFile(WORKSPACE, PATH);
    renderTool(null);
    await screen.findByText(LINES[0]!);
    expect(screen.queryByRole("button", { name: /Comment on line/ })).toBeNull();
  });

  it("restores an open editor with its unsaved text after a remount", async () => {
    await openLine(7);
    await typeNote("keep me");
    cleanup();

    renderTool();
    const dialog = await screen.findByRole("dialog", { name: `Comment on ${PATH} line 7` });
    await waitFor(() => expect(dialog.textContent).toContain("keep me"));
  });

  it("scrolls a pending jump into view once the file loads, then clears it", async () => {
    useFilesTabsStore.getState().jumpTo(THREAD, PATH, 20);
    renderTool();
    await waitFor(() => expect(getFilesScope(THREAD).pendingJump).toBeNull());
    expect(scrollToIndex).toHaveBeenCalledWith(19, { align: "center" });
  });
});
