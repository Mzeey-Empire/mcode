// @vitest-environment jsdom
import { expect, it, vi, onTestFinished } from "vitest";
import { render, act } from "@testing-library/react";
import { createElement } from "react";
import { createMockMessage } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useThreadStore } from "@/stores/threadStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useTaskStore, coerceTaskStatus } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { clearScrollMemory, rememberScrollTop } from "@/components/chat/scrollPositionMemory";
import { MessageList } from "../../messages/MessageList";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createThreadHydrator } from "../thread-hydrator";
import { cacheRecord, clearRecordCache, projectConversationCacheState } from "../record-cache";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

it("returns to a retained viewport without shrinking or remounting, positioning it once at the saved offset", async () => {
  vi.useFakeTimers();
  clearRecordCache();
  clearScrollMemory();
  resetThreadStoreForTests({ currentThreadId: "other" });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    const padding = (Number.parseFloat(this.style.paddingTop) || 0) + (Number.parseFloat(this.style.paddingBottom) || 0);
    return padding + (Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "0") || 200);
  });
  const messages = Array.from({ length: 12 }, (_, row) => createMockMessage({
    id: `warm-${row}`, thread_id: "warm", sequence: row + 1,
  }));
  cacheRecord("warm", projectConversationCacheState({
    ...createEmptyThreadRecord(), messages, oldestLoadedSequence: 1, newestLoadedSequence: 12,
  }));
  resetThreadStoreForTests({ currentThreadId: "other", records: new Map([["warm", {
    ...createEmptyThreadRecord(), messages, oldestLoadedSequence: 1, newestLoadedSequence: 12,
  }]]) });
  useWorkspaceStore.setState({ activeThreadId: "other" });
  const { container, unmount } = render(createElement(MessageList, { displayThreadId: "warm" }));
  const viewport = container.querySelector('[data-testid="transcript-viewport"]');
  if (!(viewport instanceof HTMLElement)) throw new Error("Missing retained viewport");
  const originalHosts = [...container.querySelectorAll('[data-message-id]')];
  expect(originalHosts.map(host => host.getAttribute("data-message-id"))).toContain("warm-11");
  const originalTop = viewport.scrollTop;
  rememberScrollTop("warm", originalTop, true);
  const setScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")?.set;
  if (!setScrollTop) throw new Error("Missing native scroll setter");
  const writeStacks: string[] = [];
  const writes = vi.spyOn(viewport, "scrollTop", "set").mockImplementation(function (this: HTMLElement, top: number) {
    writeStacks.push(new Error("scroll positioning").stack ?? "");
    setScrollTop.call(this, top);
  });
  const lengths: number[] = [];
  const unsubscribe = useThreadStore.subscribe(state => {
    if (state.currentThreadId !== "warm") return;
    const record = state.records.get("warm");
    if (!record) return;
    lengths.push(record.messages.length);
  });
  onTestFinished(() => {
    unsubscribe(); unmount();
    clearRecordCache(); clearScrollMemory(); vi.restoreAllMocks(); vi.useRealTimers();
  });
  const plans = usePlanStore.getState();
  const hydrator = createThreadHydrator({
    getTransport: () => mockTransport,
    getState: useThreadStore.getState,
    setState: partial => useThreadStore.setState(state => typeof partial === "function" ? partial(state) : partial),
    getWorkspaceThread: () => undefined,
    flushPendingTextDeltas: () => {},
    loadNarrativeForMessage: useThreadStore.getState().loadNarrativeForMessage,
    getTasksForThread: threadId => useTaskStore.getState().tasksByThread[threadId] ?? [],
    setTasksForThread: (threadId, tasks) => useTaskStore.getState().setTasks(threadId, tasks),
    addPlanForThread: plans.addPlan,
    reconcilePlanQuestions: () => {},
    getPlanQuestionsRevision: () => 0,
    setPlanCommentsForThread: plans.setComments,
    beginPendingImplementRead: plans.beginPendingImplementRead,
    shallowEqualBy, coerceTaskStatus,
    getWorkspaceThreadSettings: () => ({ permissionMode: "full", interactionMode: "build" }),
  });
  onTestFinished(() => hydrator.invalidateConversation("warm"));
  await act(async () => {
    useWorkspaceStore.setState({ activeThreadId: "warm" });
    await hydrator.hydrate("warm", "active");
  });
  expect({ lengths: [...new Set(lengths)], removed: originalHosts.filter(host => !host.isConnected).length,
    scrollWrites: writes.mock.calls }).toEqual({ lengths: [12], removed: 0, scrollWrites: [[originalTop]] });
  console.log("warm return positioning", { savedTop: originalTop, writes: writes.mock.calls, writeStacks });
  for (const host of originalHosts) expect(container.contains(host)).toBe(true);
  expect(viewport.scrollTop).toBe(originalTop);
});
