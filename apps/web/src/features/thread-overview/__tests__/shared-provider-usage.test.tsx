import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts/providers/usage";
import { mockTransport } from "@/__tests__/mocks/transport";
import { Composer } from "@/features/conversation/composer/Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { OverviewContext, useOverviewState } from "@/features/thread-overview/overview-state";
import { UsageEntryBlock } from "@/features/thread-overview/entries/usage";
import { UsagePopover } from "@/components/chat/UsagePopover";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { resetProviderUsageForTests, seedProviderUsageForTests } from "@/stores/providerUsageStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import type { Thread } from "@/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/components/chat/lexical", () => ({
  ComposerEditor: ({ ariaLabel }: { ariaLabel?: string }) => <textarea aria-label={ariaLabel} />,
  $createTypedMentionNode: vi.fn(),
  extractComposerMessage: vi.fn(() => ({ text: "", mentions: [] })),
  insertMentionNode: vi.fn(),
  insertSlashCommandNode: vi.fn(),
}));

vi.mock("@/components/chat/useFileAutocomplete", () => ({
  clearFileListCache: vi.fn(),
  useFileAutocomplete: () => ({
    suggestions: [],
    query: "",
    isOpen: false,
    triggerStart: 0,
    selectSuggestion: vi.fn(),
    handleInputChange: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/components/chat/useSlashCommand", () => ({
  useSlashCommand: () => ({
    state: null,
    selectedIndex: 0,
    anchorRect: null,
    isOpen: false,
    onInputChange: vi.fn(),
    onDismiss: vi.fn(),
    onSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onRetry: vi.fn(),
  }),
}));

vi.mock("@/components/chat/ModelSelector", () => ({ ModelSelector: () => <div /> }));
vi.mock("@/components/chat/FileTagPopup", () => ({
  FileTagPopup: () => <div />,
  useFileTagPopup: () => ({ listRef: { current: null }, selectedIndex: 0, onKeyDown: vi.fn() }),
}));
vi.mock("@/components/chat/SpellcheckContextMenu", () => ({ SpellcheckContextMenu: () => <div /> }));
vi.mock("@/components/chat/ComposerQueueList", () => ({ ComposerQueueList: () => <div /> }));
vi.mock("@/components/chat/SlashCommandTray", () => ({ SlashCommandTray: () => <div /> }));
vi.mock("@/hooks/useBranchPr", () => ({ useBranchPr: vi.fn().mockReturnValue(null) }));
vi.mock("@/hooks/useHasCommitsAhead", () => ({ useHasCommitsAhead: vi.fn().mockReturnValue(null) }));

const getProviderUsage = vi.mocked(mockTransport.getProviderUsage);

const THREAD_A = createMockThread({ id: "thread-a", workspace_id: "ws-1", mode: "direct", provider: "claude" });
const THREAD_B = createMockThread({ id: "thread-b", workspace_id: "ws-1", mode: "direct", provider: "claude" });

function fiveHour(usedPercent: number): QuotaCategory {
  return {
    label: "5-hour limit",
    used: usedPercent,
    total: 100,
    remainingPercent: 1 - usedPercent / 100,
    resetDate: "2099-07-03T14:14:00.000Z",
    isUnlimited: false,
  };
}

function claudeUsage(usedPercent: number, extra: Partial<ProviderUsageInfo> = {}): ProviderUsageInfo {
  return {
    providerId: "claude",
    quotaCategories: [fiveHour(usedPercent)],
    usageStatus: "ready",
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function claudeTurnEnd(threadId: string, extra: Partial<Extract<AgentEvent, { type: "quotaUpdate" }>> = {}): void {
  act(() => {
    useThreadStore.getState().handleAgentEvent({
      type: "quotaUpdate",
      threadId,
      providerId: "claude",
      categories: [],
      ...extra,
    });
  });
}

function OverviewUsage({ thread }: { thread: Thread }) {
  const state = useOverviewState(thread, true, () => {});
  return (
    <OverviewContext.Provider value={state}>
      <div data-testid={`overview-${thread.id}`}>
        <UsageEntryBlock subject={{ kind: "thread", thread }} />
      </div>
    </OverviewContext.Provider>
  );
}

function overviewOf(threadId: string) {
  return within(screen.getByTestId(`overview-${threadId}`));
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("shared provider usage across threads", () => {
  beforeAll(() => {
    if (typeof window.ResizeObserver === "undefined") {
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  beforeEach(() => {
    getProviderUsage.mockReset();
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: "ws-1", is_git_repo: true })],
      activeWorkspaceId: "ws-1",
      threads: [THREAD_A, THREAD_B],
      activeThreadId: THREAD_A.id,
      newThreadMode: "direct",
      newThreadBranch: "main",
      selectedWorktree: null,
    });
  });

  afterEach(() => {
    resetProviderUsageForTests();
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("shows one refresh on thread A's Composer and thread B's Overview", async () => {
    getProviderUsage.mockResolvedValue(claudeUsage(85));

    render(
      <>
        <Composer threadId={THREAD_A.id} workspaceId="ws-1" />
        <OverviewUsage thread={THREAD_B} />
      </>,
    );

    expect(await screen.findByRole("img", { name: "Low provider quota" })).toBeInTheDocument();
    expect(overviewOf(THREAD_B.id).getByTestId("thread-overview-usage-value")).toHaveTextContent("85%");
    expect(getProviderUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps session cost on the thread that reported it", async () => {
    getProviderUsage.mockResolvedValue(claudeUsage(20, { billingMode: "api_key", sessionCostUsd: 0.42 }));
    claudeTurnEnd(THREAD_A.id, { billingMode: "api_key", sessionCostUsd: 0.42 });

    render(
      <>
        <OverviewUsage thread={THREAD_A} />
        <OverviewUsage thread={THREAD_B} />
      </>,
    );

    expect(await overviewOf(THREAD_B.id).findByText("20%")).toBeInTheDocument();
    expect(overviewOf(THREAD_A.id).getByText("$0.42")).toBeInTheDocument();
    expect(overviewOf(THREAD_B.id).queryByText("Session cost")).not.toBeInTheDocument();
  });

  it("shows a Claude turn end's session cost when its refresh fails before any succeeds", async () => {
    getProviderUsage.mockRejectedValue(new Error("offline"));
    claudeTurnEnd(THREAD_A.id, { billingMode: "api_key", sessionCostUsd: 0.42 });
    await flush();

    render(<OverviewUsage thread={THREAD_A} />);
    await flush();

    expect(overviewOf(THREAD_A.id).getByText("$0.42")).toBeInTheDocument();
  });

  it("keeps quota on screen while a Claude turn end refreshes it", async () => {
    seedProviderUsageForTests({ providerId: "claude", quotaCategories: [fiveHour(12)], usageStatus: "ready", fetchedAt: new Date().toISOString() });
    const pending = deferred<ProviderUsageInfo>();
    getProviderUsage.mockReturnValue(pending.promise);
    render(<OverviewUsage thread={THREAD_B} />);

    claudeTurnEnd(THREAD_A.id);

    expect(overviewOf(THREAD_B.id).getByTestId("thread-overview-usage-value")).toHaveTextContent("12%");
    await act(async () => pending.resolve(claudeUsage(30)));
    expect(overviewOf(THREAD_B.id).getByTestId("thread-overview-usage-value")).toHaveTextContent("30%");
  });

  it("fetches once when the popover and the Overview open on a stale snapshot together", async () => {
    seedProviderUsageForTests({ providerId: "claude", quotaCategories: [fiveHour(12)], usageStatus: "ready", fetchedAt: "2026-01-01T00:00:00.000Z" });
    getProviderUsage.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(
      <>
        <UsagePopover threadId={THREAD_A.id}>
          <button type="button">Usage</button>
        </UsagePopover>
        <OverviewUsage thread={THREAD_B} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Usage" }));

    expect(await screen.findByText("Quota")).toBeInTheDocument();
    expect(getProviderUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good quota on every thread, marked stale, when a refresh fails", async () => {
    getProviderUsage
      .mockResolvedValueOnce(claudeUsage(40, { billingMode: "api_key" }))
      .mockRejectedValueOnce(new Error("offline"));
    render(
      <>
        <OverviewUsage thread={THREAD_A} />
        <OverviewUsage thread={THREAD_B} />
      </>,
    );
    expect(await overviewOf(THREAD_B.id).findByText("40%")).toBeInTheDocument();

    claudeTurnEnd(THREAD_A.id, { billingMode: "api_key", sessionCostUsd: 0.42 });
    await flush();

    for (const threadId of [THREAD_A.id, THREAD_B.id]) {
      expect(overviewOf(threadId).getByText("5-hour · stale")).toBeInTheDocument();
      expect(overviewOf(threadId).getByTestId("thread-overview-usage-value")).toHaveTextContent("40%");
    }
    expect(overviewOf(THREAD_A.id).getByText("$0.42")).toBeInTheDocument();
  });

  it("refreshes a mounted Composer every 5 minutes only while the window is visible", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-23T10:00:00.000Z"), toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    getProviderUsage.mockImplementation(async () => claudeUsage(85));
    const view = render(<Composer threadId={THREAD_A.id} workspaceId="ws-1" />);
    await flush();
    expect(screen.getByRole("img", { name: "Low provider quota" })).toBeInTheDocument();

    getProviderUsage.mockImplementation(async () => claudeUsage(10));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(getProviderUsage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img", { name: "Low provider quota" })).not.toBeInTheDocument();

    act(() => setVisibility("hidden"));
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60_000));
    expect(getProviderUsage).toHaveBeenCalledTimes(2);

    act(() => setVisibility("visible"));
    await flush();
    expect(getProviderUsage).toHaveBeenCalledTimes(3);

    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60_000));
    expect(getProviderUsage).toHaveBeenCalledTimes(3);
  });
});
