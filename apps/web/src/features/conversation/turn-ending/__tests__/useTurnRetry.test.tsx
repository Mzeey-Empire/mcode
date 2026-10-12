import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTurnRetry } from "../useTurnRetry";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const retryErroredTurn = mockTransport.retryErroredTurn as ReturnType<typeof vi.fn>;

const scheduledResume = () => useWorkspaceStore.getState().threads.find((thread) => thread.id === "thread-1")?.scheduled_resume;
const NOW = new Date("2026-10-11T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useTurnRetry", () => {
  it("retries the notice's own turn and stays pending until the server answers", async () => {
    let answer!: (value: { turnId: string }) => void;
    retryErroredTurn.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));

    act(() => result.current.retry());

    expect(retryErroredTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-7" });
    expect(result.current.pending).toBe(true);
    await act(async () => answer({ turnId: "turn-8" }));
    expect(result.current).toMatchObject({ pending: false, error: null });
  });

  it("shows the server's refusal and clears it on the next attempt", async () => {
    retryErroredTurn.mockRejectedValueOnce(new Error("The turn is no longer the latest."));
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));

    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ pending: false, error: "The turn is no longer the latest." });

    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ pending: false, error: null });
  });

  it("retries on the model the user switched to", async () => {
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));
    await act(async () => result.current.retry("gpt-5.5"));
    expect(retryErroredTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-7", model: "gpt-5.5" });
  });

  it("schedules a retry at the reset time and shows it on the thread", async () => {
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));
    await act(async () => result.current.retryAt("2026-10-11T14:05:00.000Z"));
    expect(mockTransport.scheduleTurnResume).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-7", at: "2026-10-11T14:05:00.000Z" });
    expect(scheduledResume()).toEqual({ turnId: "turn-7", at: "2026-10-11T14:05:00.000Z" });
  });

  it("retries now when the reset time has already passed", async () => {
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));
    await act(async () => result.current.retryAt("2026-10-11T08:59:00.000Z"));
    expect(mockTransport.scheduleTurnResume).not.toHaveBeenCalled();
    expect(retryErroredTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-7" });
  });

  it("cancels the scheduled retry and clears it from the thread", async () => {
    useWorkspaceStore.getState().applyScheduledResume("thread-1", { turnId: "turn-7", at: "2026-10-11T14:05:00.000Z" });
    const { result } = renderHook(() => useTurnRetry("thread-1", "turn-7"));
    await act(async () => result.current.cancelRetry());
    expect(mockTransport.unscheduleTurnResume).toHaveBeenCalledWith("thread-1");
    expect(scheduledResume()).toBeNull();
  });
});
