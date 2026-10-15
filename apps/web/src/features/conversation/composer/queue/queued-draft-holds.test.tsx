import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { sendQueuedMessage, useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { seedPage, tickClockPerRead } from "@/features/preview/notes/__tests__/fixtures";
import { readVisibleBrowserNotePages } from "../draft/draft-browser-notes";
import { readVisibleDiffComments, saveDraftDiffComment } from "../draft/draft-diff-comments";
import { readVisibleFileComments, saveDraftFileComment } from "../draft/draft-file-comments";
import { useComposerFormController } from "../draft/useComposerFormController";
import type { ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import { useComposerQueueController } from "../submission/useComposerQueueController";
import { useComposerSubmissionController } from "../submission/useComposerSubmissionController";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "queued-draft-holds-thread";
const WORKSPACE_ID = "queued-draft-holds-workspace";
const diffTarget = { filePath: "src/state.ts", side: "right" as const, line: 11, lineContent: "const state = next;" };
const fileTarget = { filePath: "src/main.tsx", line: 7, lineContent: "render(<App />);" };

function execution(): ComposerExecutionTargetController {
  return {
    target: { kind: "existing-thread", mode: "direct" },
    mode: "direct",
    isGitRepo: false,
    needsWorkspace: false,
    isStaleWorktree: false,
    selectedWorktree: null,
    newThreadBranch: "main",
    newThreadBranchSource: "branch",
    branchExecMode: "direct",
    branchTargetBranch: "main",
    branchWorktreePath: null,
    branchWorktreeIsDetached: false,
    targetPending: false,
    setMode: vi.fn(),
    setBranchMode: vi.fn(),
    setNewThreadMode: vi.fn(),
    setNewThreadBranch: vi.fn(),
    setNewThreadBranchFromPullRequest: vi.fn(),
  };
}

/** The Composer of a running thread, wired as Composer.tsx wires it. */
function useRunningThreadComposer() {
  const form = useComposerFormController({ threadId: THREAD_ID, isNewThread: false, workspaceId: WORKSPACE_ID });
  const queue = useComposerQueueController({
    threadId: THREAD_ID,
    annotationScopeId: THREAD_ID,
    handoffStatus: undefined,
    form,
  });
  const controller = useComposerSubmissionController({
    threadId: THREAD_ID,
    workspaceId: WORKSPACE_ID,
    isNewThread: false,
    isAgentRunning: true,
    startingThread: false,
    annotationScopeId: THREAD_ID,
    form,
    execution: execution(),
    queue: {
      editing: queue.editing,
      queueIfGenerating: queue.queueIfGenerating,
      discardEmptyEdit: queue.discardEmptyEdit,
      finishEditing: queue.finishEditing,
      consumeEditForDispatch: queue.consumeEditForDispatch,
      releaseConsumedEdit: queue.releaseConsumedEdit,
      resolvePreviewAnnotations: queue.resolvePreviewAnnotations,
    },
  });
  return { queue, controller };
}

function queued(): QueuedMessage[] {
  return useQueueStore.getState().queues[THREAD_ID] ?? [];
}

function visibleNotes(): string[] {
  return readVisibleBrowserNotePages(THREAD_ID).flatMap((page) => page.notes.map((note) => note.note));
}

function storedNotes(): string[] {
  return (useComposerDraftStore.getState().drafts[THREAD_ID]?.browserNotePages ?? [])
    .flatMap((page) => page.notes.map((note) => note.note));
}

/** Presses Send while the thread runs, which queues the message. */
async function queueSend() {
  const composer = renderHook(useRunningThreadComposer);
  await act(async () => {
    await composer.result.current.controller.submit();
  });
  expect(queued()).toHaveLength(1);
  return { entry: queued()[0]!, composer };
}

function drainNext(): Promise<void> {
  useThreadStore.setState({ runningThreadIds: new Set() });
  const next = useQueueStore.getState().claimNextQueuedMessage(THREAD_ID);
  expect(next).toBeDefined();
  return sendQueuedMessage(THREAD_ID, next!);
}

/**
 * A reload keeps only what was persisted: a fresh queue store, the stored draft, and no
 * memory of sends this window started. It then reconciles the draft against the server.
 */
async function reloadAndReconcile(): Promise<typeof import("../draft/draft-browser-notes")> {
  vi.resetModules();
  const lifecycle = await import("../draft/draft-submission-lifecycle");
  const { useQueueStore: freshQueue } = await import("@/stores/queueStore");
  expect(freshQueue.getState().queues[THREAD_ID]).toBeUndefined();
  await lifecycle.reconcileOrphanedDraftSubmissions(THREAD_ID);
  return import("../draft/draft-browser-notes");
}

function freshVisibleNotes(notes: typeof import("../draft/draft-browser-notes")): string[] {
  return notes.readVisibleBrowserNotePages(THREAD_ID).flatMap((page) => page.notes.map((note) => note.note));
}

describe("a queued Send owns the draft elements it carries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    tickClockPerRead();
    useComposerDraftStore.setState({ drafts: {} });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      autoDrainSuppressedThreadIds: new Set<string>(),
      toast: null,
      editingThreadId: null,
    });
    resetThreadStoreForTests({ currentThreadId: THREAD_ID, runningThreadIds: new Set([THREAD_ID]) });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID, workspace_id: WORKSPACE_ID })],
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockTransport.confirmMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ admitted: false });
  });

  it("returns the notes after a reload when the server never admitted the queued message", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry } = await queueSend();
    expect(visibleNotes()).toEqual([]);

    const notes = await reloadAndReconcile();

    expect(mockTransport.confirmMessage).toHaveBeenCalledWith(THREAD_ID, entry.id);
    expect(freshVisibleNotes(notes)).toEqual(["Make the button bigger"]);
  });

  it("drops the notes after a reload when the server admitted the queued message", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry } = await queueSend();
    (mockTransport.confirmMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ admitted: true });

    const notes = await reloadAndReconcile();

    expect(mockTransport.confirmMessage).toHaveBeenCalledWith(THREAD_ID, entry.id);
    expect(freshVisibleNotes(notes)).toEqual([]);
    expect(notes.readVisibleBrowserNotePages(THREAD_ID)).toEqual([]);
  });

  it("returns a Review comment after a reload when the queued message was never admitted", async () => {
    saveDraftDiffComment(THREAD_ID, diffTarget, { note: "Rename this", mentions: [] });
    const { entry } = await queueSend();
    expect(readVisibleDiffComments(THREAD_ID)).toEqual([]);

    vi.resetModules();
    const lifecycle = await import("../draft/draft-submission-lifecycle");
    await lifecycle.reconcileOrphanedDraftSubmissions(THREAD_ID);
    const fresh = await import("../draft/draft-diff-comments");

    expect(mockTransport.confirmMessage).toHaveBeenCalledWith(THREAD_ID, entry.id);
    expect(fresh.readVisibleDiffComments(THREAD_ID).map((comment) => comment.note)).toEqual(["Rename this"]);
  });

  it("sends the queued message under its entry id and removes its notes once admitted", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry } = await queueSend();

    await drainNext();

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: entry.id }));
    expect(queued()).toEqual([]);
    expect(storedNotes()).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]?.submissions ?? []).toEqual([]);
    expect(mockTransport.confirmMessage).not.toHaveBeenCalled();
  });

  it("keeps the entry queued and its notes held when the dispatch is not accepted", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry } = await queueSend();
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("transport unavailable"));

    await drainNext();

    expect(queued().map((message) => message.id)).toEqual([entry.id]);
    expect(visibleNotes()).toEqual([]);
    expect(storedNotes()).toEqual(["Make the button bigger"]);

    // The lost response may still have been admitted, so removal asks the server first.
    act(() => useQueueStore.getState().removeFromQueue(THREAD_ID, entry.id));
    await waitFor(() => expect(visibleNotes()).toEqual(["Make the button bigger"]));
    expect(mockTransport.confirmMessage).toHaveBeenCalledWith(THREAD_ID, entry.id);
  });

  it("returns the notes when the queued message is removed", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry } = await queueSend();

    act(() => useQueueStore.getState().removeFromQueue(THREAD_ID, entry.id));

    expect(visibleNotes()).toEqual(["Make the button bigger"]);
  });

  it("returns a Files comment when the queue is cleared", async () => {
    saveDraftFileComment(THREAD_ID, fileTarget, { note: "Explain this render", mentions: [] });
    await queueSend();
    expect(readVisibleFileComments(THREAD_ID)).toEqual([]);

    act(() => useQueueStore.getState().clearQueue(THREAD_ID));

    expect(readVisibleFileComments(THREAD_ID).map((comment) => comment.note)).toEqual(["Explain this render"]);
  });

  it("puts the notes back once, still redrawable, when the queued message is opened for editing", async () => {
    seedPage(THREAD_ID, undefined, undefined, { note: "Make the button bigger" });
    const { entry, composer } = await queueSend();

    act(() => composer.result.current.queue.loadIntoComposer(entry));

    const pages = readVisibleBrowserNotePages(THREAD_ID);
    expect(pages.flatMap((page) => page.notes.map((note) => note.note))).toEqual(["Make the button bigger"]);
    expect(storedNotes()).toEqual(["Make the button bigger"]);
    // The draft's own page came back, so it keeps the clean capture it redraws from.
    expect(pages[0]!.cleanCapture).not.toBeNull();

    act(() => composer.result.current.queue.cancelEdit());

    const requeued = queued();
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.id).not.toBe(entry.id);
    expect(visibleNotes()).toEqual([]);
    act(() => useQueueStore.getState().removeFromQueue(THREAD_ID, requeued[0]!.id));
    expect(visibleNotes()).toEqual(["Make the button bigger"]);
  });
});
