import { createMockThread } from "@mcode/contracts/testing";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createAgentModelState, type AgentTurn } from "@mcode/contracts/compat/agent-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore } from "@/stores/queueStore";
import { useTaskStore } from "@/stores/taskStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { clockTime } from "../../turn-ending/usage-limit";
import { ComposerTray } from "../ComposerTray";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

// The picker itself is ModelSelector's concern; the row owns only what a choice does.
vi.mock("@/components/chat/ModelSelector", () => ({
  ModelSelector: ({ trigger, onSelect, providerLocked }: { trigger: ReactElement; onSelect: (model: string, provider: string) => void; providerLocked: boolean }) => (
    <div data-testid="model-selector" data-provider-locked={String(providerLocked)}>
      {trigger}
      <button type="button" onClick={() => onSelect("gpt-5.5", "codex")}>Pick gpt-5.5</button>
    </div>
  ),
}));

const THREAD = "thread-limit";
const TURN = "turn-limited";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const RESETS_AT = "2026-10-11T14:05:00.000Z";

function seedLimitedTurn(usageLimit: { resetsAt?: string; limitType?: string } = { resetsAt: RESETS_AT, limitType: "five_hour" }): void {
  const state = createAgentModelState();
  state.threads[THREAD] = {
    id: THREAD, workspaceId: "workspace-1", rootThreadId: THREAD, providerId: "codex", providerIdentities: [],
    activityState: "Idle", conversationRevision: 1, rosterRevision: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
  const turn: AgentTurn = {
    id: TURN, threadId: THREAD, status: "Interrupted", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: "2026-10-11T11:00:00.000Z", providerStartedAt: "2026-10-11T11:00:00.000Z", endedAt: "2026-10-11T11:10:00.000Z",
    ending: { outcome: "interrupted", cause: "usage_limit", usageLimit },
    createdAt: "2026-10-11T11:00:00.000Z", updatedAt: "2026-10-11T11:10:00.000Z",
  };
  state.turns[TURN] = turn;
  const record = createEmptyThreadRecord();
  resetThreadStoreForTests({ records: new Map([[THREAD, { ...record, canonicalAgent: { ...record.canonicalAgent, state } }]]) });
}

const row = () => screen.getByTestId("usage-limit-row");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  useWorkspaceStore.setState({ threads: [createMockThread({ id: THREAD, provider: "codex", model: "gpt-5.4", scheduled_resume: null })] });
  useTaskStore.setState({ tasksByThread: {}, taskBubbleByThread: {}, pendingTaskBubbleReplacementByThread: {} });
  useQueueStore.setState({ queues: {} });
  seedLimitedTurn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("UsageLimitRow", () => {
  it("names the provider and limit window and offers a resume at the reset time", () => {
    render(<ComposerTray threadId={THREAD} running={false} queue={<p>queued rows</p>} />);

    expect(within(row()).getByText("Codex usage limit reached")).toBeInTheDocument();
    expect(within(row()).getByText("· 5-hour limit")).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Switch model" })).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: `Resume at ${clockTime(RESETS_AT)}` })).toBeInTheDocument();
    expect(screen.getByTestId("composer-tray").firstElementChild).toBe(row());
  });

  it("omits a limit window the provider did not name", () => {
    seedLimitedTurn({ resetsAt: RESETS_AT });
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    expect(within(row()).queryByText(/·/)).not.toBeInTheDocument();
  });

  it("schedules the resume at the reset time, then counts down to it with Cancel", async () => {
    const user = userEvent.setup();
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    await user.click(screen.getByRole("button", { name: `Resume at ${clockTime(RESETS_AT)}` }));

    expect(mockTransport.scheduleTurnResume).toHaveBeenCalledWith({ threadId: THREAD, turnId: TURN, at: RESETS_AT });
    expect(mockTransport.resumeInterruptedTurn).not.toHaveBeenCalled();
    expect(within(row()).getByText(`Resuming at ${clockTime(RESETS_AT)}`)).toBeInTheDocument();
    expect(within(row()).getByText("in 2h 5m")).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("cancels a scheduled resume and offers the limit's actions again", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.getState().applyScheduledResume(THREAD, { turnId: TURN, at: RESETS_AT });
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockTransport.unscheduleTurnResume).toHaveBeenCalledWith(THREAD);
    expect(within(row()).getByRole("button", { name: `Resume at ${clockTime(RESETS_AT)}` })).toBeInTheDocument();
  });

  it.each([
    ["missing", { limitType: "five_hour" }],
    ["already past", { resetsAt: "2026-10-11T11:59:00.000Z", limitType: "five_hour" }],
  ])("resumes now when the reset time is %s", async (_case, usageLimit) => {
    const user = userEvent.setup();
    seedLimitedTurn(usageLimit);
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    await user.click(within(row()).getByRole("button", { name: "Resume" }));

    expect(mockTransport.resumeInterruptedTurn).toHaveBeenCalledWith({ threadId: THREAD, turnId: TURN });
    expect(mockTransport.scheduleTurnResume).not.toHaveBeenCalled();
  });

  it("resumes on the model the user switches to, within the thread's provider", async () => {
    const user = userEvent.setup();
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    expect(screen.getByTestId("model-selector")).toHaveAttribute("data-provider-locked", "true");
    await user.click(screen.getByRole("button", { name: "Pick gpt-5.5" }));

    expect(mockTransport.resumeInterruptedTurn).toHaveBeenCalledWith({ threadId: THREAD, turnId: TURN, model: "gpt-5.5" });
  });

  it("shows the server's refusal in the row", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.scheduleTurnResume).mockRejectedValueOnce(new Error("Resume cannot be scheduled more than 31 days ahead"));
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    await user.click(screen.getByRole("button", { name: `Resume at ${clockTime(RESETS_AT)}` }));

    expect(within(row()).getByRole("alert")).toHaveTextContent("Resume cannot be scheduled more than 31 days ahead");
  });

  it("disappears once the resume runs", () => {
    const { container, rerender } = render(<ComposerTray threadId={THREAD} running={false} queue={null} />);
    expect(row()).toBeInTheDocument();

    rerender(<ComposerTray threadId={THREAD} running queue={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("moves the countdown on the next minute", () => {
    vi.useFakeTimers({ now: NOW });
    useWorkspaceStore.getState().applyScheduledResume(THREAD, { turnId: TURN, at: RESETS_AT });
    render(<ComposerTray threadId={THREAD} running={false} queue={null} />);
    expect(within(row()).getByText("in 2h 5m")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));

    expect(within(row()).getByText("in 2h 4m")).toBeInTheDocument();
  });
});
