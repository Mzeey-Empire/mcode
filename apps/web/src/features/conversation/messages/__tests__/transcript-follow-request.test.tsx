// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockThread } from "@mcode/contracts/testing";
import { useQueueStore } from "@/stores/queueStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { sendQueuedMessage } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { mockTransport } from "@/__tests__/mocks/transport";
import { TranscriptViewport, type TranscriptPosition } from "../transcript-viewport";
import { requestTranscriptFollow, useFollowOnSend, useTranscriptFollowStore } from "../transcript-follow-request";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "follow-thread";
const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 200;

class LayoutObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("transcript follow on Send", () => {
  let view: TranscriptViewport;
  let position: TranscriptPosition;
  let rows: { id: string; height: number }[];

  const maxScrollTop = () => rows.length * ROW_HEIGHT - VIEWPORT_HEIGHT;
  const appendRow = () => {
    rows = [...rows, { id: String(rows.length), height: ROW_HEIGHT }];
    view.setRows(rows);
  };
  /** A wheel gesture upward, as a reader scrolling back through the transcript. */
  const scrollUpTo = (top: number) => {
    view.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    view.viewport.scrollTop = top;
    view.viewport.dispatchEvent(new Event("scroll"));
  };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", LayoutObserver);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "0") || VIEWPORT_HEIGHT;
    });
    const container = document.createElement("div");
    document.body.append(container);
    position = { kind: "end" };
    view = new TranscriptViewport(container, () => {}, (next) => { position = next; });
    rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), height: ROW_HEIGHT }));
    view.setRows(rows);
    useTranscriptFollowStore.setState({ request: null });
  });

  afterEach(() => {
    view.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderFollow(threadId = THREAD_ID) {
    return renderHook(() => useFollowOnSend(threadId, () => view));
  }

  it("brings a reader back to the new prompt on Send and follows the reply", () => {
    renderFollow();
    scrollUpTo(600);
    expect(position.kind).toBe("reading");

    act(() => requestTranscriptFollow(THREAD_ID));
    appendRow();
    appendRow();

    expect(position).toEqual({ kind: "end" });
    expect(view.viewport.scrollTop).toBe(maxScrollTop());
    expect(useTranscriptFollowStore.getState().request).toBeNull();
  });

  it("leaves another thread's reader in place", () => {
    renderFollow();
    scrollUpTo(600);

    act(() => requestTranscriptFollow("other-thread"));
    appendRow();

    expect(position.kind).toBe("reading");
    expect(view.viewport.scrollTop).toBe(600);
  });

  it("does not pull back a reader who scrolls up while the reply streams", () => {
    renderFollow();
    act(() => requestTranscriptFollow(THREAD_ID));
    appendRow();
    scrollUpTo(900);

    appendRow();
    appendRow();

    expect(position.kind).toBe("reading");
    expect(view.viewport.scrollTop).toBe(900);
  });

  describe("queued follow-up sent at turn end", () => {
    beforeEach(() => {
      resetThreadStoreForTests({ currentThreadId: THREAD_ID, runningThreadIds: new Set() });
      useWorkspaceStore.setState({ activeThreadId: THREAD_ID, threads: [createMockThread({ id: THREAD_ID })] });
      useQueueStore.setState({ queues: {}, inFlightQueuedMessages: {} });
      (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      useQueueStore.getState().enqueue(THREAD_ID, { content: "queued earlier", attachments: [], model: "", permissionMode: "full" });
    });

    async function sendNextQueued() {
      const next = useQueueStore.getState().claimNextQueuedMessage(THREAD_ID);
      expect(next).toBeDefined();
      await act(() => sendQueuedMessage(THREAD_ID, next!));
    }

    it("keeps a reader who scrolled up where they are", async () => {
      renderFollow();
      scrollUpTo(600);

      await sendNextQueued();
      appendRow();

      expect(mockTransport.sendMessage).toHaveBeenCalled();
      expect(position.kind).toBe("reading");
      expect(view.viewport.scrollTop).toBe(600);
    });

    it("keeps following when the view was already at the end", async () => {
      renderFollow();

      await sendNextQueued();
      appendRow();

      expect(position).toEqual({ kind: "end" });
      expect(view.viewport.scrollTop).toBe(maxScrollTop());
    });
  });
});
