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

function formStub(): ComposerQueueEditForm {
  return {
    hasContent: () => true,
    capture: vi.fn(() => ({
      content: "captured draft",
      displayContent: "captured draft",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full" as const,
    })),
    restore: vi.fn(),
    clear: vi.fn(),
    invalidateAttachments: vi.fn(),
  };
}

function setup() {
  const form = formStub();
  const annotations = { restore: vi.fn(), clear: vi.fn() };
  const hook = renderHook(() =>
    useComposerQueueEditing({ threadId: THREAD_ID, form, annotations }),
  );
  return { form, annotations, hook };
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
