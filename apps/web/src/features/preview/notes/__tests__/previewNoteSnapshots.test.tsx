import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import { flushPageSnapshots, PAGE_SNAPSHOT_DEBOUNCE_MS, schedulePageSnapshot } from "../previewNoteSnapshots";
import { removePreviewNote } from "../previewNotes";
import { seedPage, draft, PRODUCT_PAGE } from "./fixtures";

const { mockRender } = vi.hoisted(() => ({ mockRender: vi.fn() }));
vi.mock("../renderPageSnapshot", () => ({ renderPageSnapshot: mockRender }));

type SavedFile = { id: string; name: string; sizeBytes: number; sourcePath: string };

const store = () => usePreviewAnnotationStore.getState();
let threadId = "";
let counter = 0;
let saveClipboardFile: ReturnType<typeof vi.fn<() => Promise<SavedFile>>>;

const page = () => store().pages[threadId]?.[PRODUCT_PAGE];
const savedFile = (sourcePath: string): SavedFile => ({
  id: crypto.randomUUID(),
  name: "page.png",
  sizeBytes: 1,
  sourcePath,
});

describe("page snapshot redraws", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    threadId = `thread-snapshots-${counter++}`;
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    mockRender.mockReset().mockResolvedValue(new Uint8Array([9]));
    saveClipboardFile = vi.fn(async () => savedFile("C:/tmp/redrawn.png"));
    Object.assign(window, { desktopBridge: { saveClipboardFile } });
    seedPage(threadId);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(window, { desktopBridge: undefined });
  });

  it("removing a note renumbers its page and redraws the snapshot within 300 ms", async () => {
    const first = store().saveAnnotation(threadId, draft(threadId, { note: "First" }));
    store().saveAnnotation(threadId, draft(threadId, { note: "Second" }));

    removePreviewNote(threadId, first.id);

    expect(page()?.marked).toBeNull();
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS - 1);
    expect(mockRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(PAGE_SNAPSHOT_DEBOUNCE_MS).toBeLessThanOrEqual(300);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0]?.[1]).toEqual([
      { displayNumber: 1, bounds: store().getThreadAnnotations(threadId)[0]?.targetContext.bounds },
    ]);
    expect(page()?.marked?.sourcePath).toBe("C:/tmp/redrawn.png");
    expect(page()?.markedPng).toEqual(new Uint8Array([9]));
  });

  it("restarts the wait when another edit lands before it elapses", async () => {
    store().saveAnnotation(threadId, draft(threadId));
    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    await vi.advanceTimersByTimeAsync(200);
    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    await vi.advanceTimersByTimeAsync(200);

    expect(mockRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("discards a redraw that a later edit overtook while it was saving", async () => {
    store().saveAnnotation(threadId, draft(threadId));
    let release: (file: SavedFile) => void = () => {};
    saveClipboardFile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);

    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    release({ ...savedFile("C:/tmp/stale.png"), id: "stale" });
    await vi.advanceTimersByTimeAsync(0);

    expect(page()?.marked?.id).not.toBe("stale");
  });

  it("flush redraws a pending page immediately so Send never carries a stale number", async () => {
    const note = store().saveAnnotation(threadId, draft(threadId));
    store().saveAnnotation(threadId, draft(threadId));
    removePreviewNote(threadId, note.id);

    await flushPageSnapshots(threadId);

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(page()?.marked).not.toBeNull();
  });

  it("flush waits for the redraw that replaces one an edit overtook", async () => {
    const first = store().saveAnnotation(threadId, draft(threadId, { note: "A" }));
    const second = store().saveAnnotation(threadId, draft(threadId, { note: "B" }));
    store().saveAnnotation(threadId, draft(threadId, { note: "C" }));
    let release: (file: SavedFile) => void = () => {};
    saveClipboardFile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    removePreviewNote(threadId, first.id);
    const flushed = flushPageSnapshots(threadId);
    await vi.advanceTimersByTimeAsync(0);

    removePreviewNote(threadId, second.id);
    release(savedFile("C:/tmp/stale.png"));
    await flushed;

    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(mockRender.mock.calls[1]?.[1]).toHaveLength(1);
    expect(page()?.marked?.sourcePath).toBe("C:/tmp/redrawn.png");
  });

  it("flush rejects when a stale page has no clean screenshot to redraw from", async () => {
    store().saveAnnotation(threadId, draft(threadId, { note: "A" }));
    store().saveAnnotation(threadId, draft(threadId, { note: "B" }));
    const bundle = store().buildBundle(threadId)!;
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    store().restoreBundle(threadId, bundle);
    store().deleteAnnotation(threadId, store().getThreadAnnotations(threadId)[0]!.id);

    await expect(flushPageSnapshots(threadId)).rejects.toThrow("to refresh its snapshot");
  });

  it("flush leaves up-to-date pages alone", async () => {
    store().saveAnnotation(threadId, draft(threadId));

    await flushPageSnapshots(threadId);

    expect(mockRender).not.toHaveBeenCalled();
  });
});
