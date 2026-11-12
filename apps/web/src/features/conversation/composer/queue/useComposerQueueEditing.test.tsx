import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import {
  useComposerQueueEditing,
  type ComposerQueueEditForm,
} from "./useComposerQueueEditing";

vi.mock("@/stores/threadStore", () => ({
  scheduleDrainAfterEdit: vi.fn(),
}));

const THREAD_ID = "queue-editing-thread";

function enqueue(content: string): QueuedMessage {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
  const queued = useQueueStore.getState().queues[THREAD_ID];
  return queued[queued.length - 1]!;
}

function queuedContents(): string[] {
  return (useQueueStore.getState().queues[THREAD_ID] ?? []).map(
    (message) => message.content,
  );
}

const DRAFT_ATTACHMENT = {
  id: "draft-file",
  name: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 12,
  sourcePath: "/tmp/notes.md",
};

function formStub(hasContent: () => boolean): ComposerQueueEditForm {
  return {
    hasContent,
    capture: vi.fn(() => ({
      content: "captured draft",
      displayContent: "captured draft",
      attachments: [DRAFT_ATTACHMENT],
      model: "claude-sonnet-4-6",
      permissionMode: "full" as const,
    })),
    restore: vi.fn(),
    clear: vi.fn(),
    invalidateAttachments: vi.fn(),
  };
}

function setup(settle: () => Promise<boolean> = async () => true) {
  let composerHasDraft = false;
  const form = formStub(() => composerHasDraft);
  const annotations = { restore: vi.fn(), clear: vi.fn(), settle: vi.fn(settle) };
  const hook = renderHook(() =>
    useComposerQueueEditing({ threadId: THREAD_ID, form, annotations }),
  );
  const typeDraft = () => {
    composerHasDraft = true;
  };
  return { form, annotations, hook, typeDraft };
}

describe("useComposerQueueEditing dispatch consumption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      editingThreadId: null,
    });
  });

  it("does not resurrect the popped original when cancel lands while its dispatch is in flight", () => {
    const original = enqueue("queued original");
    const { hook, form } = setup();

    act(() => hook.result.current.loadIntoComposer(original));
    expect(hook.result.current.editing?.messageId).toBe(original.id);
    expect(queuedContents()).toEqual([]);

    act(() => hook.result.current.consumeEditForDispatch());
    act(() => hook.result.current.cancelEdit());

    expect(queuedContents()).toEqual([]);
    expect(hook.result.current.editing?.messageId).toBe(original.id);
    let discarded = true;
    act(() => {
      discarded = hook.result.current.discardEmptyEdit();
    });
    expect(discarded).toBe(false);
    expect(form.clear).not.toHaveBeenCalled();

    act(() => hook.result.current.finishEditing());
    expect(queuedContents()).toEqual([]);
  });

  it("re-arms cancel when the dispatch fails before settling", () => {
    const original = enqueue("queued original");
    const { hook } = setup();

    act(() => hook.result.current.loadIntoComposer(original));
    act(() => hook.result.current.consumeEditForDispatch());
    act(() => hook.result.current.releaseConsumedEdit());
    act(() => hook.result.current.cancelEdit());

    expect(queuedContents()).toEqual(["queued original"]);
    expect(hook.result.current.editing).toBeNull();
  });
});

describe("useComposerQueueEditing switching between queued messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      editingThreadId: null,
    });
  });

  it("settles page snapshots before it captures the edit being left", async () => {
    const first = enqueue("first");
    const second = enqueue("second");
    const { hook, form, annotations, typeDraft } = setup();
    act(() => hook.result.current.loadIntoComposer(first));
    typeDraft();

    await act(async () => hook.result.current.loadIntoComposer(second));

    expect(annotations.settle.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(form.capture).mock.invocationCallOrder[0]!,
    );
    expect(hook.result.current.editing?.messageId).toBe(second.id);
    expect(queuedContents()).toEqual(["captured draft"]);
  });

  it("leaves both messages where they are when a page snapshot cannot settle", async () => {
    const first = enqueue("first");
    const second = enqueue("second");
    const { hook, form, typeDraft } = setup(async () => false);
    act(() => hook.result.current.loadIntoComposer(first));
    typeDraft();

    await act(async () => hook.result.current.loadIntoComposer(second));

    expect(form.capture).not.toHaveBeenCalled();
    expect(hook.result.current.editing?.messageId).toBe(first.id);
    expect(queuedContents()).toEqual(["second"]);
  });

  it("drops the switch when the edit is cancelled while snapshots settle", async () => {
    const first = enqueue("first");
    const second = enqueue("second");
    let finish: (settled: boolean) => void = () => {};
    const { hook, form, typeDraft } = setup(() => new Promise((resolve) => { finish = resolve; }));
    act(() => hook.result.current.loadIntoComposer(first));
    typeDraft();
    act(() => hook.result.current.loadIntoComposer(second));

    act(() => hook.result.current.cancelEdit());
    await act(async () => finish(true));

    expect(form.capture).not.toHaveBeenCalled();
    expect(hook.result.current.editing).toBeNull();
    expect(queuedContents()).toEqual(["first", "second"]);
  });
});

describe("useComposerQueueEditing with an unsent draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      editingThreadId: null,
    });
  });

  it("sets the unsent draft aside behind the queue before editing a queued message", async () => {
    enqueue("first");
    const second = enqueue("second");
    const { hook, typeDraft } = setup();
    typeDraft();

    await act(async () => hook.result.current.loadIntoComposer(second));

    expect(hook.result.current.editing?.messageId).toBe(second.id);
    const queued = useQueueStore.getState().queues[THREAD_ID] ?? [];
    expect(queued.map((message) => message.content)).toEqual(["first", "captured draft"]);
    expect(queued[1]?.attachments).toEqual([DRAFT_ATTACHMENT]);
    expect(hook.result.current.editing?.parkedDraftId).toBe(queued[1]?.id);
  });

  it("returns the unsent draft to the composer, not the queue, when the edit is cancelled", async () => {
    enqueue("first");
    const second = enqueue("second");
    const { hook, form, typeDraft } = setup();
    typeDraft();
    await act(async () => hook.result.current.loadIntoComposer(second));

    act(() => hook.result.current.cancelEdit());

    expect(queuedContents()).toEqual(["first", "second"]);
    const restored = vi.mocked(form.restore);
    expect(restored.mock.lastCall?.[0].content).toBe("captured draft");
    expect(vi.mocked(form.clear).mock.invocationCallOrder[0]).toBeLessThan(restored.mock.invocationCallOrder.at(-1)!);
  });

  it("returns the unsent draft to the composer once the edited message is saved", async () => {
    enqueue("first");
    const second = enqueue("second");
    const { hook, form, typeDraft } = setup();
    typeDraft();
    await act(async () => hook.result.current.loadIntoComposer(second));
    act(() => {
      useQueueStore.getState().insertAt(THREAD_ID, 1, { content: "second, edited", displayContent: "second, edited", attachments: [], model: "claude-sonnet-4-6", permissionMode: "full" });
    });

    act(() => hook.result.current.finishEditing());

    expect(queuedContents()).toEqual(["first", "second, edited"]);
    expect(vi.mocked(form.restore).mock.lastCall?.[0].content).toBe("captured draft");
    expect(hook.result.current.editing).toBeNull();
  });
});
