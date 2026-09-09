import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgentModelState, type AgentItem, type AgentTurn, type Message, type SelectedTextComment } from "@mcode/contracts";

const loadOlderMessagesSpy = vi.fn();
const loadNewerMessagesSpy = vi.fn();
const loadNarrativeForMessageSpy = vi.fn();

class LayoutObserver implements ResizeObserver {
  static instances: LayoutObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { LayoutObserver.instances.push(this); }
  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
  disconnect(): void { this.observed.clear(); }
  static resize(element: Element, height: number): void {
    const size = [{ blockSize: height, inlineSize: 1000 }];
    const entry: ResizeObserverEntry = {
      target: element, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
      contentRect: new DOMRect(0, 0, 1000, height),
    };
    for (const observer of this.instances) {
      if (observer.observed.has(element)) observer.callback([entry], observer);
    }
  }
}

// Minimal store mocks; control `loading` and `activeThreadId` between renders.
let loadingValue = false;
let activeThreadIdValue = "thread-A";
let currentThreadIdValue = "thread-A";
let messagesValue: {
  id: string;
  sequence: number;
  thread_id?: string;
  role?: "user" | "assistant";
  content?: string;
  eligible?: boolean;
}[] = [{ id: "m1", sequence: 1 }];
let hasMoreMessagesValue = false;
let hasNewerMessagesValue = false;
let runningThreadIdsValue = new Set<string>();
let handoffStatusByThread: Record<string, "generating" | "ready" | "fallback" | "error"> = {};
let recordOverridesByThread: Record<string, Record<string, unknown>> = {};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function buildMockRecord(threadId = currentThreadIdValue) {
  return {
    canonicalAgent: {
      state: {
        threads: {},
        turns: {},
        items: {},
        collaborationActions: {},
        appliedEventIds: {},
        acceptedInputEventIds: {},
        lastAcceptedSequenceByExecution: {},
      },
      revision: { conversationRevision: 0, rosterRevision: 0 },
      recoveryRequired: false,
    },
    messages: messagesValue,
    loading: loadingValue,
    streamingPreview: "",
    streaming: "",
    toolCalls: [],
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    hasMoreMessages: hasMoreMessagesValue,
    hasNewerMessages: hasNewerMessagesValue,
    isLoadingMore: false,
    isLoadingNewer: false,
    permissions: [],
    hooks: [],
    thoughtSegments: [],
    currentTurnMessageId: "",
    narrativeByMessage: {},
    agentStartTime: undefined,
    ...(handoffStatusByThread[threadId] ? { handoffMeta: { status: handoffStatusByThread[threadId] } } : {}),
    ...recordOverridesByThread[threadId],
  };
}

function canonicalChildState(content: string, status: "Running" | "Completed") {
  const threadId = "child-thread";
  const turnId = "child-turn";
  const timestamp = "2026-09-06T00:00:00.000Z";
  const answer: Message = {
    id: "child-answer",
    thread_id: threadId,
    role: "assistant",
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp,
    sequence: 1,
    attachments: null,
  };
  const turn: AgentTurn = {
    id: turnId,
    threadId,
    status,
    trigger: { kind: "child", sourceThreadId: "parent-thread", sourceTurnId: "parent-turn" },
    permissionMode: "full",
    approvalReviewMode: "manual",
    approvalReviewReason: "manual-requested",
    providerIdentities: [],
    startedAt: timestamp,
    endedAt: status === "Completed" ? timestamp : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const item: AgentItem = {
    id: "child-answer-item",
    threadId,
    turnId,
    kind: "message",
    providerIdentities: [],
    payload: { projection: "message", message: answer },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const state = createAgentModelState();
  state.turns[turnId] = turn;
  state.items[item.id] = item;
  return state;
}

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) => {
    const records = new Map([
      ["thread-A", buildMockRecord("thread-A")],
      ["thread-B", buildMockRecord("thread-B")],
    ]);
    return selector({
      records,
      currentThreadId: currentThreadIdValue,
      runningThreadIds: runningThreadIdsValue,
      loadOlderMessages: loadOlderMessagesSpy,
      loadNewerMessages: loadNewerMessagesSpy,
      loadNarrativeForMessage: loadNarrativeForMessageSpy,
      isNarrativeLoaded: () => false,
    });
  }),
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: vi.fn((threadId: string, selector: (r: ReturnType<typeof buildMockRecord>) => unknown) =>
    selector(buildMockRecord(threadId)),
  ),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: activeThreadIdValue }),
  ),
}));

// Stub heavy children.
vi.mock("../MessageBubble", () => ({
  MessageBubble: ({ message }: { message: {
    id: string;
    content: string;
    role?: "user" | "assistant";
    thread_id?: string;
    eligible?: boolean;
  } }) => (
    <div
      data-message-id={message.id}
      data-message-role={message.role ?? "assistant"}
      data-thread-id={message.thread_id ?? "thread-A"}
    >
      <div
        data-selected-text-content
        data-selected-text-eligible={message.eligible === false ? "false" : "true"}
      >
        {message.content}
      </div>
    </div>
  ),
}));
vi.mock("@/components/chat/ToolCallCard", () => ({ ToolCallCard: () => null }));
vi.mock("@/components/chat/StreamingIndicator", () => ({ StreamingIndicator: () => null }));
vi.mock("@/components/chat/StreamingCard", () => ({ StreamingCard: () => null }));
vi.mock("@/components/chat/TurnChangeSummary", () => ({
  TurnChangeSummary: ({ filesChanged }: { filesChanged: string[] }) => (
    <div data-testid="turn-change-summary">{filesChanged.join(",")}</div>
  ),
}));
vi.mock("@/components/chat/PermissionRequestCard", () => ({ PermissionRequestCard: () => null }));
vi.mock("@/components/chat/HookActivitySection", () => ({ HookActivitySection: () => null }));

import { MessageList, type SelectedTextCommentSourceNavigationRequest } from "../MessageList";
import {
  recallScrollPosition,
  recallScrollTop,
  clearScrollMemory,
  hasRememberedHistoryPosition,
} from "@/components/chat/scrollPositionMemory";

const rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const rangeBoundingRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

function mockSelectedTextViewport(container: HTMLElement): HTMLDivElement {
  const viewport = container.querySelector(".overflow-y-auto") as HTMLDivElement;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 800));
  return viewport;
}

beforeEach(() => {
  LayoutObserver.instances = [];
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  loadOlderMessagesSpy.mockClear();
  loadNewerMessagesSpy.mockClear();
  loadNarrativeForMessageSpy.mockClear();
  loadingValue = false;
  activeThreadIdValue = "thread-A";
  messagesValue = [{ id: "m1", sequence: 1 }];
  hasMoreMessagesValue = false;
  hasNewerMessagesValue = false;
  currentThreadIdValue = "thread-A";
  runningThreadIdsValue = new Set();
  handoffStatusByThread = {};
  recordOverridesByThread = {};
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "0") || 800;
  });
  clearScrollMemory();
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(120, 160, 96, 20)],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(120, 160, 96, 20),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.getSelection()?.removeAllRanges();
  if (rangeClientRectsDescriptor) Object.defineProperty(Range.prototype, "getClientRects", rangeClientRectsDescriptor);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (rangeBoundingRectDescriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBoundingRectDescriptor);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("MessageList thread switch", () => {
  it("keeps virtual message rails vertically visible for sent annotation previews", () => {
    const { container } = render(<MessageList />);
    const rail = container.querySelector(".overflow-x-clip");

    expect(rail).toHaveClass("overflow-x-clip");
    expect(rail).not.toHaveClass("overflow-x-hidden");
  });

  it("renders growing canonical child text before completion without duplicating its bubble", () => {
    activeThreadIdValue = "parent-thread";
    currentThreadIdValue = "parent-thread";
    messagesValue = [];
    recordOverridesByThread["child-thread"] = {
      messages: [],
      canonicalAgent: {
        state: canonicalChildState("First chunk", "Running"),
        revision: { conversationRevision: 1, rosterRevision: 0 },
        recoveryRequired: false,
      },
    };

    const { rerender } = render(<MessageList displayThreadId="child-thread" />);
    expect(screen.getByText("First chunk")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-message-id="child-answer"]')).toHaveLength(1);

    recordOverridesByThread["child-thread"] = {
      messages: [],
      canonicalAgent: {
        state: canonicalChildState("First chunk, second chunk", "Running"),
        revision: { conversationRevision: 2, rosterRevision: 0 },
        recoveryRequired: false,
      },
    };
    rerender(<MessageList displayThreadId="child-thread" />);
    expect(screen.getByText("First chunk, second chunk")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-message-id="child-answer"]')).toHaveLength(1);

    recordOverridesByThread["child-thread"] = {
      messages: [],
      canonicalAgent: {
        state: canonicalChildState("First chunk, second chunk", "Completed"),
        revision: { conversationRevision: 3, rosterRevision: 0 },
        recoveryRequired: false,
      },
    };
    rerender(<MessageList displayThreadId="child-thread" />);
    expect(screen.getByText("First chunk, second chunk")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-message-id="child-answer"]')).toHaveLength(1);
  });

  it("loads and scrolls a virtualized source before it reconstructs the saved range", async () => {
    messagesValue = [{ id: "m1", sequence: 2, thread_id: "thread-A", role: "assistant", content: "Current message" }];
    hasMoreMessagesValue = true;
    const comment: SelectedTextComment = {
      id: "11111111-1111-4111-8111-111111111111",
      displayNumber: 1,
      source: {
        threadId: "thread-A",
        messageId: "m2",
        sourceRole: "assistant",
        start: 0,
        end: 14,
        quote: "Virtual source",
      },
      note: "Saved note",
      mentions: [],
    };
    const onSelectedTextCommentSourceOpened = vi.fn();
    loadOlderMessagesSpy.mockImplementationOnce(async () => {
      messagesValue = [
        { id: "m2", sequence: 1, thread_id: "thread-A", role: "assistant", content: "Virtual source" },
        { id: "m1", sequence: 2, thread_id: "thread-A", role: "assistant", content: "Current message" },
      ];
      // More pages can remain after the target page loads. The navigation
      // effect must react to the newly resident source, not pagination state.
      hasMoreMessagesValue = true;
    });
    const request = { id: 1, comment };
    const props = {
      selectedTextCommentSourceNavigation: request,
      onSelectedTextCommentSourceOpened,
    };
    const { container, rerender } = render(<MessageList {...props} />);
    mockSelectedTextViewport(container);

    await waitFor(() => expect(loadOlderMessagesSpy).toHaveBeenCalledWith("thread-A"));
    rerender(<MessageList {...props} />);
    await waitFor(() => expect(onSelectedTextCommentSourceOpened).toHaveBeenCalledWith(request));
  });

  it("marks a source unavailable only after its resident message fails canonical reconstruction", async () => {
    messagesValue = [{ id: "m1", sequence: 1, thread_id: "thread-A", role: "assistant", content: "Loaded message" }];
    const comment: SelectedTextComment = {
      id: "11111111-1111-4111-8111-111111111111",
      displayNumber: 1,
      source: {
        threadId: "thread-A",
        messageId: "m1",
        sourceRole: "assistant",
        start: 0,
        end: 7,
        quote: "Missing",
      },
      note: "Saved note",
      mentions: [],
    };
    const onSelectedTextCommentSourceUnavailable = vi.fn();
    const request = { id: 2, comment };
    const { container } = render(
      <MessageList
        selectedTextCommentSourceNavigation={request}
        onSelectedTextCommentSourceUnavailable={onSelectedTextCommentSourceUnavailable}
      />,
    );
    mockSelectedTextViewport(container);

    await waitFor(() => expect(onSelectedTextCommentSourceUnavailable).toHaveBeenCalledWith(request));
    expect(loadOlderMessagesSpy).not.toHaveBeenCalled();
    expect(loadNewerMessagesSpy).not.toHaveBeenCalled();
  });

  it("marks a source unavailable after its required history page fails to load", async () => {
    messagesValue = [{ id: "m1", sequence: 2, thread_id: "thread-A", role: "assistant", content: "Current message" }];
    hasMoreMessagesValue = true;
    loadOlderMessagesSpy.mockResolvedValueOnce("failed");
    const comment: SelectedTextComment = {
      id: "11111111-1111-4111-8111-111111111111",
      displayNumber: 1,
      source: {
        threadId: "thread-A",
        messageId: "m2",
        sourceRole: "assistant",
        start: 0,
        end: 14,
        quote: "Virtual source",
      },
      note: "Saved note",
      mentions: [],
    };
    const onSelectedTextCommentSourceUnavailable = vi.fn();
    const request = { id: 3, comment };
    const { container, rerender } = render(
      <MessageList
        selectedTextCommentSourceNavigation={request}
        onSelectedTextCommentSourceUnavailable={onSelectedTextCommentSourceUnavailable}
      />,
    );
    mockSelectedTextViewport(container);

    await waitFor(() => expect(onSelectedTextCommentSourceUnavailable).toHaveBeenCalledWith(request));
    rerender(
      <MessageList
        selectedTextCommentSourceNavigation={request}
        onSelectedTextCommentSourceUnavailable={onSelectedTextCommentSourceUnavailable}
      />,
    );
    expect(loadOlderMessagesSpy).toHaveBeenCalledOnce();
    expect(onSelectedTextCommentSourceUnavailable).toHaveBeenCalledOnce();
  });

  it("keeps the latest source request active when an earlier history request fails", async () => {
    messagesValue = [{ id: "m1", sequence: 3, thread_id: "thread-A", role: "assistant", content: "Current message" }];
    hasMoreMessagesValue = true;
    const commentA: SelectedTextComment = {
      id: "11111111-1111-4111-8111-111111111111",
      displayNumber: 1,
      source: {
        threadId: "thread-A",
        messageId: "missing-a",
        sourceRole: "assistant",
        start: 0,
        end: 1,
        quote: "A",
      },
      note: "Saved note A",
      mentions: [],
    };
    const commentB: SelectedTextComment = {
      id: "22222222-2222-4222-8222-222222222222",
      displayNumber: 2,
      source: {
        threadId: "thread-A",
        messageId: "missing-b",
        sourceRole: "assistant",
        start: 0,
        end: 1,
        quote: "B",
      },
      note: "Saved note B",
      mentions: [],
    };
    const requestA = {
      id: 4,
      comment: commentA,
    };
    const requestB = {
      id: 5,
      comment: commentB,
    };
    let rejectA!: (reason?: unknown) => void;
    loadOlderMessagesSpy
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectA = reject; }))
      .mockReturnValueOnce(new Promise(() => undefined));
    const onSelectedTextCommentSourceUnavailable = vi.fn();

    function NavigationHarness() {
      const [request, setRequest] = useState<SelectedTextCommentSourceNavigationRequest | undefined>(requestA);
      return (
        <>
          <button type="button" onClick={() => setRequest(requestB)}>Open B</button>
          <output data-testid="active-source-request">{request?.id}</output>
          <MessageList
            selectedTextCommentSourceNavigation={request}
            onSelectedTextCommentSourceUnavailable={(resolvedRequest) => {
              onSelectedTextCommentSourceUnavailable(resolvedRequest);
              setRequest(undefined);
            }}
          />
        </>
      );
    }

    const { container } = render(<NavigationHarness />);
    mockSelectedTextViewport(container);
    await waitFor(() => expect(loadOlderMessagesSpy).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    await waitFor(() => expect(loadOlderMessagesSpy).toHaveBeenCalledTimes(2));
    await act(async () => {
      rejectA(new Error("History unavailable"));
      await Promise.resolve();
    });

    expect(onSelectedTextCommentSourceUnavailable).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-source-request")).toHaveTextContent("5");
  });

  it("restores an open source editor after its source is virtualized and scrolled into view", async () => {
    messagesValue = [
      { id: "m1", sequence: 1, thread_id: "thread-A", role: "assistant", content: "Earlier message" },
      { id: "m2", sequence: 2, thread_id: "thread-A", role: "assistant", content: "Virtual source" },
    ];
    const { container } = render(
      <MessageList
        onSelectedTextComment={vi.fn()}
        selectedTextCommentEditor={{
          source: {
            threadId: "thread-A",
            messageId: "m2",
            sourceRole: "assistant",
            start: 0,
            end: 14,
            quote: "Virtual source",
          },
          note: "Unsaved edit",
          mentions: [],
          escapeWarned: false,
          outsideWarned: false,
          anchor: "source",
        }}
      />,
    );
    mockSelectedTextViewport(container);

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Comment on selected text" })).toBeVisible());
  });

  it("does not offer selected-text comments without a comment handler", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByText, queryByRole } = render(<MessageList />);
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });

    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("keeps selected-text actions open through the selection click sequence", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const onSelectedTextComment = vi.fn();
    const { container, getByRole, getByText, queryByRole } = render(
      <MessageList onSelectedTextComment={onSelectedTextComment} />,
    );
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const text = content.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(content, { button: 0, clientX: 24, clientY: 24 });

    const addComment = getByRole("button", { name: "Add comment" });
    expect(queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(fireEvent.contextMenu(content, { button: 2, clientX: 24, clientY: 24 })).toBe(true);

    fireEvent.click(addComment);
    expect(getByRole("dialog", { name: "Comment on selected text" })).toBeInTheDocument();
    const noteInput = getByRole("textbox", { name: "Comment note" });
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(noteInput).toHaveFocus();
    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Close comment editor" })).toBeInTheDocument();
    selection.removeAllRanges();
  });

  it("closes the selected-text editor when mounted canonical content no longer reconstructs", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByRole, getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    const viewport = mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(getByRole("button", { name: "Add comment" }));
    expect(getByRole("dialog", { name: "Comment on selected text" })).toBeInTheDocument();

    content.textContent = "Changed canonical content";
    fireEvent.scroll(viewport);

    await vi.waitFor(() => {
      expect(queryByRole("dialog", { name: "Comment on selected text" })).not.toBeInTheDocument();
    });
  });

  it("reconstructs current range geometry after the native selection clears", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    let selectedRangeRect = new DOMRect(120, 160, 96, 20);
    const originalGetClientRects = Range.prototype.getClientRects;
    const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    const resizeObservers: ResizeObserverMock[] = [];
    let rangeRectReads = 0;
    class ResizeObserverMock implements ResizeObserver {
      readonly observed = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      observe(target: Element, _options?: ResizeObserverOptions) {
        this.observed.add(target);
      }

      unobserve(target: Element) {
        this.observed.delete(target);
      }

      disconnect() {
        this.observed.clear();
      }

      trigger() {
        this.callback([], this);
      }
    }
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => {
        rangeRectReads += 1;
        return [selectedRangeRect];
      },
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });

    try {
      const { container, getByRole, getByText } = render(<MessageList onSelectedTextComment={vi.fn()} />);
      const viewport = mockSelectedTextViewport(container);
      const content = getByText("Select this phrase");
      const text = content.firstChild!;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 6);
      selection.removeAllRanges();
      selection.addRange(range);

      fireEvent.mouseUp(content, { button: 0, clientX: 900, clientY: 700 });

      const action = getByRole("button", { name: "Add comment" });
      const actionPositioner = action.closest('[data-slot="popover-content"]')?.parentElement;
      expect(actionPositioner).toBeTruthy();
      await vi.waitFor(() => {
        expect(actionPositioner).toHaveStyle({
          "--anchor-width": "160px",
          "--anchor-height": "40px",
        });
      });
      expect(document.querySelector('[data-slot="popover-trigger"]')).toBeNull();
      await vi.waitFor(() => {
        expect(resizeObservers.some((observer) => observer.observed.has(viewport))).toBe(true);
      });
      const viewportObserver = resizeObservers.find((observer) => observer.observed.has(viewport))!;
      await vi.waitFor(() => {
        expect([...viewportObserver.observed]).toContain(content);
      });

      selectedRangeRect = new DOMRect(120, 100, 96, 20);
      const readsBeforeScroll = rangeRectReads;
      fireEvent.scroll(viewport);
      await vi.waitFor(() => {
        expect(rangeRectReads).toBeGreaterThan(readsBeforeScroll);
      });

      selectedRangeRect = new DOMRect(120, 80, 128, 20);
      const readsBeforeViewportResize = rangeRectReads;
      act(() => {
        viewportObserver.trigger();
      });
      await vi.waitFor(() => {
        expect(rangeRectReads).toBeGreaterThan(readsBeforeViewportResize);
      });

      fireEvent.click(action);
      selection.removeAllRanges();
      const editor = getByRole("dialog", { name: "Comment on selected text" });
      const editorPositioner = editor.closest('[data-slot="popover-content"]')?.parentElement;
      vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 328, 46));
      const editorObserver = resizeObservers.find((observer) => observer.observed.has(editor));
      expect(editorObserver).toBeDefined();
      act(() => {
        editorObserver!.trigger();
      });
      await vi.waitFor(() => {
        expect(editorPositioner).toHaveStyle({
          "--anchor-width": "328px",
          "--anchor-height": "46px",
        });
      });

      selectedRangeRect = new DOMRect(120, 840, 128, 20);
      const readsBeforeDock = rangeRectReads;
      fireEvent.scroll(viewport);
      await vi.waitFor(() => {
        expect(rangeRectReads).toBeGreaterThan(readsBeforeDock);
      });

      selectedRangeRect = new DOMRect(160, 220, 128, 20);
      const readsBeforeReturn = rangeRectReads;
      fireEvent.scroll(viewport);
      await vi.waitFor(() => {
        expect(rangeRectReads).toBeGreaterThan(readsBeforeReturn);
      });
    } finally {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: originalGetClientRects,
      });
      if (originalResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("closes a selected-text action when the rendered thread changes", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByRole, getByText, queryByRole, rerender } = render(
      <MessageList displayThreadId="thread-A" onSelectedTextComment={vi.fn()} />,
    );
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 900, clientY: 700 });
    expect(getByRole("button", { name: "Add comment" })).toBeInTheDocument();

    rerender(<MessageList displayThreadId="thread-B" onSelectedTextComment={vi.fn()} />);

    await vi.waitFor(() => {
      expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
    });
  });

  it("closes a selected-text action on a later outside press", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByRole, getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 900, clientY: 700 });
    expect(getByRole("button", { name: "Add comment" })).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    act(() => {
      fireEvent.pointerDown(document.body);
    });

    await vi.waitFor(() => {
      expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
    });
  });

  it("closes a selected-text action on Escape", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByRole, getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 900, clientY: 700 });
    expect(getByRole("button", { name: "Add comment" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    await vi.waitFor(() => {
      expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
    });
  });

  it("does not open selected-text actions for a collapsed pointer selection", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 6);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });

    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("does not open selected-text actions after a secondary mouseup", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 2, clientX: 24, clientY: 24 });

    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("returns focus to Add comment when the selected-text editor closes", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { container, getByRole, getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    mockSelectedTextViewport(container);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    const action = getByRole("button", { name: "Add comment" });
    const actionPopup = action.closest('[data-slot="popover-content"]');
    fireEvent.click(action);

    const noteInput = getByRole("textbox", { name: "Comment note" });
    expect(noteInput.closest('[data-slot="popover-content"]')).not.toBe(actionPopup);
    await vi.waitFor(() => expect(noteInput).toHaveFocus());
    fireEvent.keyDown(noteInput, { key: "Escape" });

    await vi.waitFor(() => {
      expect(queryByRole("dialog", { name: "Comment on selected text" })).not.toBeInTheDocument();
    });
    await vi.waitFor(() => expect(getByRole("button", { name: "Add comment" })).toHaveFocus());
  });

  it("does not open the selected-text menu for cross-message or ineligible selections", () => {
    messagesValue = [
      {
        id: "assistant-1",
        sequence: 1,
        thread_id: "thread-A",
        role: "assistant",
        content: "First message",
      },
      {
        id: "assistant-2",
        sequence: 2,
        thread_id: "thread-A",
        role: "assistant",
        content: "Streaming message",
        eligible: false,
      },
    ];
    const { getByText, queryByRole } = render(<MessageList onSelectedTextComment={vi.fn()} />);
    const first = getByText("First message");
    const streaming = getByText("Streaming message");
    const selection = document.getSelection()!;
    const crossMessageRange = document.createRange();
    crossMessageRange.setStart(first.firstChild!, 0);
    crossMessageRange.setEnd(streaming.firstChild!, 3);
    selection.removeAllRanges();
    selection.addRange(crossMessageRange);

    fireEvent.mouseUp(first, { button: 0, clientX: 24, clientY: 24 });
    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();

    const ineligibleRange = document.createRange();
    ineligibleRange.setStart(streaming.firstChild!, 0);
    ineligibleRange.setEnd(streaming.firstChild!, 9);
    selection.removeAllRanges();
    selection.addRange(ineligibleRange);

    fireEvent.mouseUp(streaming, { button: 0, clientX: 24, clientY: 24 });
    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("shows file changes from only the displayed child thread", () => {
    activeThreadIdValue = "thread-A";
    recordOverridesByThread = {
      "thread-A": {
        messages: [{ id: "parent-answer", sequence: 1, thread_id: "thread-A", role: "assistant", content: "Parent" }],
        persistedFilesChanged: { "parent-answer": ["parent-only.ts"] },
        latestTurnWithChanges: "parent-answer",
      },
      "thread-B": {
        messages: [{ id: "child-answer", sequence: 1, thread_id: "thread-B", role: "assistant", content: "Child" }],
        persistedFilesChanged: { "child-answer": ["child-only.ts"] },
        latestTurnWithChanges: "child-answer",
      },
    };

    const { getByTestId, queryByText } = render(<MessageList displayThreadId="thread-B" />);

    expect(getByTestId("turn-change-summary")).toHaveTextContent("child-only.ts");
    expect(queryByText("parent-only.ts")).toBeNull();
  });

  it("renders leading transcript content before the queued user message", () => {
    messagesValue = [{
      id: "queued-first-turn",
      sequence: 1,
      thread_id: "thread-A",
      role: "user",
      content: "Build the feature",
    }];

    const { getByTestId } = render(
      <MessageList leadingContent={<div data-testid="automatic-setup-block">Automatic Setup</div>} />,
    );

    const setupBlock = getByTestId("automatic-setup-block");
    const queuedMessage = getByTestId("message-list").querySelector('[data-message-id="queued-first-turn"]');
    expect(queuedMessage).not.toBeNull();
    expect(setupBlock.compareDocumentPosition(queuedMessage!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("does not pair a cached transcript with another thread's running narrative", async () => {
    activeThreadIdValue = "thread-B";
    currentThreadIdValue = "thread-A";
    runningThreadIdsValue = new Set(["thread-B"]);
    recordOverridesByThread = { "thread-B": {
      runtimePhase: "running",
      thoughtSegments: [{ text: "Thread B reasoning", startedAt: 1, endedAt: 2, isExplicitNonFinal: true }],
    } };
    messagesValue = [{
      id: "a-final",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Thread A final response",
    }];
    const { queryByText, rerender } = render(<MessageList displayThreadId="thread-A" />);

    expect(queryByText("Thread A final response")).not.toBeNull();
    expect(queryByText("Thread B reasoning")).toBeNull();

    currentThreadIdValue = "thread-B";
    messagesValue = [{
      id: "b-user",
      sequence: 1,
      thread_id: "thread-B",
      role: "user",
      content: "Thread B request",
    }];
    act(() => rerender(<MessageList />));

    await waitFor(() => expect(queryByText("Thread B reasoning")).not.toBeNull());
  });

  it("uses the rendered transcript thread for handoff skeletons", () => {
    activeThreadIdValue = "thread-B";
    currentThreadIdValue = "thread-A";
    handoffStatusByThread = { "thread-B": "generating" };
    messagesValue = [{
      id: "a-user",
      sequence: 1,
      thread_id: "thread-A",
      role: "user",
      content: "Thread A request",
    }];
    const { container, rerender } = render(<MessageList displayThreadId="thread-A" />);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);

    currentThreadIdValue = "thread-B";
    messagesValue = [{
      id: "b-user",
      sequence: 1,
      thread_id: "thread-B",
      role: "user",
      content: "Thread B request",
    }];
    act(() => rerender(<MessageList />));

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
  });


  it("virtualizes expanded tool children and restores them after scrolling and thread switches", () => {
    messagesValue = [{ id: "answer", sequence: 1, role: "assistant", content: "Finished commands" }];
    const tools = Array.from({ length: 180 }, (_, index) => ({
      id: `command-${index}`, message_id: "answer", tool_name: "Bash",
      tool_input: JSON.stringify({ command: `echo command-${index}` }), output: "",
      is_error: false, is_complete: true, sort_order: index,
      started_at: new Date(index * 1000).toISOString(),
      completed_at: new Date(index * 1000 + 500).toISOString(),
    }));
    recordOverridesByThread["thread-A"] = { narrativeByMessage: { answer: { tools, hooks: [], thoughts: [] } } };
    const groupMessages = messagesValue;
    const { container, rerender } = render(<MessageList />);
    let viewport = screen.getByTestId("transcript-viewport");
    fireEvent.click(screen.getByRole("button", { name: "Ran 180 commands" }));
    expect(container.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("li").length).toBeLessThan(60);
    expect(screen.getByRole("button", { name: "Ran 180 commands" })).toHaveAttribute("aria-expanded", "true");
    readAt(viewport, 3000);
    expect(screen.queryByRole("button", { name: "Ran 180 commands" })).toBeNull();
    expect(container.querySelectorAll("li").length).toBeLessThan(60);
    const readingAnchor = recallScrollPosition("thread-A")?.rowAnchor;
    activeThreadIdValue = currentThreadIdValue = "thread-B";
    messagesValue = transcriptRows("thread-B");
    act(() => rerender(<MessageList />));
    activeThreadIdValue = currentThreadIdValue = "thread-A";
    messagesValue = groupMessages;
    act(() => rerender(<MessageList />));
    viewport = screen.getByTestId("transcript-viewport");
    expect(viewport.scrollTop).toBe(3000);
    expect(recallScrollPosition("thread-A")?.rowAnchor).toEqual(readingAnchor);
    expect(container.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("li").length).toBeLessThan(60);
    readAt(viewport, 0);
    expect(screen.getByRole("button", { name: "Ran 180 commands" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Ran 180 commands" }));
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(viewport.scrollTop).toBe(0);
  });

  function transcriptRows(threadId = "thread-A") {
    return Array.from({ length: 12 }, (_, sequence) => ({
      id: `${threadId}-${sequence}`, thread_id: threadId, sequence,
      role: "assistant" as const, content: `Message ${sequence}`,
    }));
  }

  function measureRows(container: HTMLElement, height = 100): void {
    act(() => {
      for (const host of container.querySelectorAll("[data-transcript-key]")) LayoutObserver.resize(host, height);
    });
  }

  function readAt(viewport: HTMLElement, top: number): void {
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = top;
    fireEvent.scroll(viewport);
  }

  it("pins measured content and holds a reading anchor through prepend and eviction", () => {
    messagesValue = transcriptRows();
    const { container, rerender } = render(<MessageList />);
    measureRows(container);
    const viewport = screen.getByTestId("transcript-viewport");
    expect(viewport.scrollTop).toBe(400);
    readAt(viewport, 125);
    const anchor = container.querySelector('[data-message-id="thread-A-1"]');
    messagesValue = [{ id: "older", sequence: -1 }, ...messagesValue];
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(viewport.scrollTop).toBe(225);
    expect(container.querySelector('[data-message-id="thread-A-1"]')).toBe(anchor);
    messagesValue = messagesValue.slice(1);
    act(() => rerender(<MessageList />));
    expect(viewport.scrollTop).toBe(125);
    expect(hasRememberedHistoryPosition("thread-A")).toBe(true);
  });

  it("restores a cached reading row without reusing the outgoing viewport", () => {
    messagesValue = transcriptRows();
    const { container, rerender } = render(<MessageList />, { wrapper: StrictMode });
    measureRows(container);
    const outgoing = screen.getByTestId("transcript-viewport");
    readAt(outgoing, 125);
    activeThreadIdValue = currentThreadIdValue = "thread-B";
    messagesValue = transcriptRows("thread-B");
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(screen.getByTestId("transcript-viewport")).not.toBe(outgoing);
    expect(screen.getByTestId("transcript-viewport").scrollTop).toBe(400);
    expect(container.querySelector('[data-thread-id="thread-A"]')).toBeNull();
    activeThreadIdValue = currentThreadIdValue = "thread-A";
    messagesValue = transcriptRows();
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(screen.getByTestId("transcript-viewport").scrollTop).toBe(125);
    expect(recallScrollPosition("thread-A")?.rowAnchor).toEqual({ key: "thread-A-1", offset: 25 });
  });

  it("keeps a restored offset that exceeds the row's provisional height", () => {
    messagesValue = transcriptRows();
    const { container, rerender } = render(<MessageList />, { wrapper: StrictMode });
    measureRows(container, 300);
    readAt(screen.getByTestId("transcript-viewport"), 500);
    activeThreadIdValue = currentThreadIdValue = "thread-B";
    messagesValue = transcriptRows("thread-B");
    act(() => rerender(<MessageList />));
    activeThreadIdValue = currentThreadIdValue = "thread-A";
    messagesValue = transcriptRows();
    act(() => rerender(<MessageList />));
    measureRows(container, 300);
    expect(screen.getByTestId("transcript-viewport").scrollTop).toBe(500);
    expect(recallScrollPosition("thread-A")?.rowAnchor).toEqual({ key: "thread-A-1", offset: 200 });
  });

  it("clips the prompt for the older turn in view", () => {
    messagesValue = transcriptRows().map((message, index) => index === 0 || index === 6
      ? { ...message, role: "user", content: index === 0 ? "Earlier request" : "Latest request" }
      : message);
    const { container } = render(<MessageList />);
    measureRows(container, 200);
    const viewport = screen.getByTestId("transcript-viewport");
    readAt(viewport, 400);
    expect(screen.getByTestId("sticky-user-message")).toHaveTextContent("Earlier request");
    readAt(viewport, 1210);
    expect(screen.queryByTestId("sticky-user-message")).not.toBeInTheDocument();
    readAt(viewport, 400);
    fireEvent.click(screen.getByRole("button", { name: "Jump to your message" }));
    expect(container.querySelector('[data-transcript-key="thread-A-0"] .animate-flash-highlight')).not.toBeNull();
    readAt(viewport, 1250);
    expect(screen.queryByTestId("sticky-user-message")).not.toBeInTheDocument();
    readAt(viewport, 1500);
    expect(screen.getByTestId("sticky-user-message")).toHaveTextContent("Latest request");
    readAt(viewport, 400);
    expect(screen.getByTestId("sticky-user-message")).toHaveTextContent("Earlier request");
  });

  it("does not apply the sticky prompt inset twice on a cached restore", () => {
    const history = [
      { id: "prompt", thread_id: "thread-A", sequence: -1, role: "user" as const, content: "Earlier request" },
      ...transcriptRows(),
    ];
    messagesValue = history;
    const { container, rerender } = render(<MessageList />, { wrapper: StrictMode });
    measureRows(container);
    readAt(screen.getByTestId("transcript-viewport"), 300);
    const before = recallScrollPosition("thread-A")?.rowAnchor;
    activeThreadIdValue = currentThreadIdValue = "thread-B";
    messagesValue = transcriptRows("thread-B");
    act(() => rerender(<MessageList />));
    activeThreadIdValue = currentThreadIdValue = "thread-A";
    messagesValue = history;
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(recallScrollPosition("thread-A")?.rowAnchor).toEqual(before);
  });

  it("unmounts off-screen thoughts inside one long turn and remounts them in order", () => {
    messagesValue = [{ id: "answer", sequence: 1, role: "assistant", content: "Final answer" }];
    const thoughts = Array.from({ length: 200 }, (_, index) => ({
      id: `thought-${index}`, message_id: "answer", text: `History thought ${index}`,
      started_at: new Date(index * 1000).toISOString(), ended_at: new Date(index * 1000 + 500).toISOString(), sort_order: index,
    }));
    recordOverridesByThread["thread-A"] = { narrativeByMessage: { answer: { tools: [], hooks: [], thoughts } } };
    const { container } = render(<MessageList />);
    measureRows(container);
    const tailRows = screen.getAllByText(/^History thought \d+$/);
    expect(tailRows.length).toBeLessThan(30);
    expect(screen.queryByText("History thought 0")).toBeNull();
    expect(screen.getByText("History thought 199")).toBeInTheDocument();
    readAt(screen.getByTestId("transcript-viewport"), 0);
    measureRows(container);
    const headRows = screen.getAllByText(/^History thought \d+$/).map((row) => row.textContent);
    expect(headRows.length).toBeLessThan(30);
    expect(headRows).toEqual(Array.from({ length: headRows.length }, (_, index) => `History thought ${index}`));
    expect(screen.queryByText("History thought 199")).toBeNull();
  });

  it("holds reading posture on append until the user returns to the tail", () => {
    messagesValue = transcriptRows();
    const { container, rerender } = render(<MessageList />);
    measureRows(container);
    const viewport = screen.getByTestId("transcript-viewport");
    readAt(viewport, 125);
    messagesValue = [...messagesValue, { id: "new", sequence: 12 }];
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(viewport.scrollTop).toBe(125);
    expect(recallScrollTop("thread-A")).toBe(125);
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    const tail = container.querySelector('[data-transcript-key="new"]')!;
    act(() => LayoutObserver.resize(tail, 180));
    expect(viewport.scrollTop).toBe(580);
  });

  it("waits for hydration and then positions the completed transcript at its measured tail", () => {
    loadingValue = true;
    messagesValue = [];
    const { container, rerender } = render(<MessageList />);
    expect(container.querySelector("[data-message-id]")).toBeNull();
    loadingValue = false;
    messagesValue = transcriptRows();
    act(() => rerender(<MessageList />));
    measureRows(container);
    expect(screen.getByTestId("transcript-viewport").scrollTop).toBe(400);
    expect(container.querySelector('[data-message-id="thread-A-11"]')).not.toBeNull();
  });

  it("loads older and newer history only after a gesture reaches its boundary", () => {
    messagesValue = transcriptRows();
    hasMoreMessagesValue = hasNewerMessagesValue = true;
    const { container } = render(<MessageList />);
    measureRows(container);
    const viewport = screen.getByTestId("transcript-viewport");
    expect(loadOlderMessagesSpy).not.toHaveBeenCalled();
    expect(loadNewerMessagesSpy).not.toHaveBeenCalled();
    readAt(viewport, 100);
    expect(loadOlderMessagesSpy).toHaveBeenCalledExactlyOnceWith("thread-A");
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(loadNewerMessagesSpy).not.toHaveBeenCalled();
    viewport.scrollTop = 350;
    fireEvent.scroll(viewport);
    expect(loadNewerMessagesSpy).toHaveBeenCalledExactlyOnceWith("thread-A");
  });
});
