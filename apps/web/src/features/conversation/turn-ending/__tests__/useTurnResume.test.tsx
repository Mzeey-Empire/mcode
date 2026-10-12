import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnResumeResult } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useTurnResume } from "../useTurnResume";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const resumeInterruptedTurn = mockTransport.resumeInterruptedTurn as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe("useTurnResume", () => {
  it("resumes the notice's own turn and stays pending until the server answers", async () => {
    let answer!: (value: TurnResumeResult) => void;
    resumeInterruptedTurn.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useTurnResume("thread-1", "turn-7"));

    act(() => result.current.resume());

    expect(resumeInterruptedTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-7" });
    expect(result.current.pending).toBe(true);
    await act(async () => answer({ turnId: "turn-8", mode: "seeded-session" }));
    expect(result.current).toMatchObject({ pending: false, error: null });
  });

  it("shows the server's refusal", async () => {
    resumeInterruptedTurn.mockRejectedValueOnce(new Error("This turn was already resumed."));
    const { result } = renderHook(() => useTurnResume("thread-1", "turn-7"));

    await act(async () => result.current.resume());

    expect(result.current).toMatchObject({ pending: false, error: "This turn was already resumed." });
  });
});
