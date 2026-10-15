import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedDraftImage } from "@mcode/contracts";
import { freezeDraftSubmission, readSendableDraftContent } from "@/features/conversation/composer/draft/draft-submission";
import {
  browserPagesToBundle,
  clearVisibleBrowserNotes,
  readVisibleBrowserNotePages,
  removeTakenBrowserNotePages,
} from "@/features/conversation/composer/draft/draft-browser-notes";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { flushPageSnapshots, PAGE_SNAPSHOT_DEBOUNCE_MS, schedulePageSnapshot } from "../previewNoteSnapshots";
import { removePreviewNote } from "../previewNotes";
import { BILLING_PAGE, PRODUCT_PAGE, seedPage, stagedImage } from "./fixtures";

const { mockRender, mockRead, mockStage } = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockRead: vi.fn(),
  mockStage: vi.fn(),
}));
vi.mock("../renderPageSnapshot", () => ({ renderPageSnapshot: mockRender }));
vi.mock("../stagedDraftImages", () => ({ readStagedDraftImage: mockRead, stageDraftImage: mockStage }));

let threadId = "";
let counter = 0;

const pageOf = (pageIdentity = PRODUCT_PAGE) =>
  readVisibleBrowserNotePages(threadId).find((candidate) => candidate.pageIdentity === pageIdentity);
const noteIds = (pageIdentity = PRODUCT_PAGE) => pageOf(pageIdentity)?.notes.map((note) => note.id) ?? [];

/** Saves each note onto its page, leaving the page without a snapshot as an edit does. */
function addNotes(pageIdentity: string, title: string, notes: string[]) {
  for (const note of notes) seedPage(threadId, pageIdentity, title, { snapshot: false, note });
}

describe("page snapshot redraws", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    threadId = `thread-snapshots-${counter++}`;
    useComposerDraftStore.setState({ drafts: {} });
    mockRender.mockReset().mockResolvedValue(new Uint8Array([9]));
    mockRead.mockReset().mockResolvedValue(new Uint8Array([1]));
    mockStage.mockReset().mockImplementation(async () => stagedImage());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removing a note renumbers its page and redraws the snapshot within 300 ms", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["First", "Second", "Third"]);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);
    mockRender.mockClear();

    removePreviewNote(threadId, noteIds()[0]!);

    expect(pageOf()?.snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS - 1);
    expect(mockRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(PAGE_SNAPSHOT_DEBOUNCE_MS).toBeLessThanOrEqual(300);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0]?.[1]).toEqual(
      pageOf()!.notes.map((note, index) => ({ displayNumber: index + 1, bounds: note.targetContext.bounds })),
    );
    expect(mockStage).toHaveBeenLastCalledWith(threadId, new Uint8Array([9]), expect.any(String));
    expect(pageOf()?.snapshot).not.toBeNull();
  });

  it("restarts the wait when another edit lands before it elapses", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B"]);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);
    mockRender.mockClear();
    removePreviewNote(threadId, noteIds()[0]!);
    await vi.advanceTimersByTimeAsync(200);
    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    await vi.advanceTimersByTimeAsync(200);

    expect(mockRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("discards a redraw that a later edit overtook while it was saving", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A"]);
    let release: (image: StagedDraftImage) => void = () => {};
    mockStage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);

    schedulePageSnapshot(threadId, PRODUCT_PAGE);
    release(stagedImage());
    await vi.advanceTimersByTimeAsync(0);

    expect(pageOf()?.snapshot).toBeNull();
  });

  it("discards a redraw whose notes were cleared from the tile while an earlier Send still holds the page", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["Sent"]);
    await flushPageSnapshots(threadId);
    useComposerDraftStore.getState().updateNextMessage(threadId, (draft) =>
      freezeDraftSubmission(draft, "message-1", readSendableDraftContent(draft)).draft);
    addNotes(PRODUCT_PAGE, "Product", ["Added after Send"]);
    let release: (image: StagedDraftImage) => void = () => {};
    mockStage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);
    const late = stagedImage("late.png");

    clearVisibleBrowserNotes(threadId);
    release(late);
    await vi.advanceTimersByTimeAsync(0);

    const [page] = useComposerDraftStore.getState().drafts[threadId]!.browserNotePages!;
    expect(page!.snapshot?.stagingId).not.toBe(late.stagingId);
  });

  it("flush redraws a pending page immediately so Send never carries a stale number", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B"]);
    removePreviewNote(threadId, noteIds()[0]!);

    await flushPageSnapshots(threadId);

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0]?.[1]).toHaveLength(1);
    expect(pageOf()?.snapshot).not.toBeNull();
  });

  it("flush waits for the redraw that replaces one an edit overtook", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B", "C", "D"]);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);
    mockRender.mockClear();
    const [first, second] = noteIds();
    let release: (image: StagedDraftImage) => void = () => {};
    mockStage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    removePreviewNote(threadId, first!);
    const flushed = flushPageSnapshots(threadId);
    await vi.advanceTimersByTimeAsync(0);

    removePreviewNote(threadId, second!);
    const stale = stagedImage();
    release(stale);
    await flushed;

    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(mockRender.mock.calls[1]?.[1]).toHaveLength(2);
    expect(pageOf()?.snapshot).not.toBeNull();
    expect(pageOf()?.snapshot?.stagingId).not.toBe(stale.stagingId);
  });

  it("flush rechecks a page that was edited again while another page was still saving", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B", "C"]);
    addNotes(BILLING_PAGE, "Billing", ["D", "E"]);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);
    mockRender.mockClear();
    const productNotes = noteIds();
    const billingNotes = noteIds(BILLING_PAGE);
    let releaseBilling: (image: StagedDraftImage) => void = () => {};
    mockStage
      .mockImplementationOnce(async () => stagedImage())
      .mockImplementationOnce(() => new Promise((resolve) => { releaseBilling = resolve; }));
    removePreviewNote(threadId, productNotes[0]!);
    removePreviewNote(threadId, billingNotes[0]!);
    const flushed = flushPageSnapshots(threadId);
    await vi.advanceTimersByTimeAsync(0);

    removePreviewNote(threadId, productNotes[1]!);
    releaseBilling(stagedImage());
    await flushed;

    expect(pageOf()?.snapshot).not.toBeNull();
    expect(pageOf(BILLING_PAGE)?.snapshot).not.toBeNull();
    const drawn = browserPagesToBundle(readVisibleBrowserNotePages(threadId));
    expect(drawn.annotations.map((annotation) => annotation.displayNumber)).toEqual([1, 1]);
  });

  it("flush rejects when a stale page has no clean screenshot to redraw from", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B"]);
    useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => ({
      ...draft,
      browserNotePages: draft.browserNotePages?.map((page) => ({ ...page, cleanCapture: null, snapshot: null })),
    }));

    await expect(flushPageSnapshots(threadId)).rejects.toThrow("to refresh its snapshot");
  });

  it("flush rejects when the staged clean screenshot is gone", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A"]);
    mockRead.mockResolvedValue(null);

    await expect(flushPageSnapshots(threadId)).rejects.toThrow("Add a note on it to retake it");
    expect(pageOf()?.snapshot).toBeNull();
  });

  it("flush leaves up-to-date pages alone", async () => {
    seedPage(threadId);
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);

    await flushPageSnapshots(threadId);

    expect(mockRender).not.toHaveBeenCalled();
  });

  it("redraws a page a settled Send renumbered, without waiting for the next Send", async () => {
    addNotes(PRODUCT_PAGE, "Product", ["A", "B"]);
    await flushPageSnapshots(threadId);
    mockRender.mockClear();
    const [sent] = pageOf()!.notes;

    removeTakenBrowserNotePages(threadId, [{ id: sent!.id, revision: sent!.revision }]);
    expect(pageOf()?.snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(PAGE_SNAPSHOT_DEBOUNCE_MS);

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0]?.[1]).toHaveLength(1);
    expect(pageOf()?.snapshot).not.toBeNull();
  });
});
