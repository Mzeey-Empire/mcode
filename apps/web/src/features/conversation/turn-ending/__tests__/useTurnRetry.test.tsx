import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useTurnRetry } from "../useTurnRetry";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const retryErroredTurn = mockTransport.retryErroredTurn as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

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
});
