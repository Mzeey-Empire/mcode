import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/stores/toastStore";
import { useTerminalStore } from "@/features/terminal";
import { createTerminalForScope } from "../ensure-terminal";

const terminalCreate = vi.fn();
const terminalKill = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({
    terminalCreate,
    terminalKill,
  }),
}));

describe("createTerminalForScope", () => {
  beforeEach(() => {
    vi.useRealTimers();
    terminalCreate.mockReset();
    useToastStore.setState({ toasts: [] });
    useTerminalStore.setState({ terminals: {} });
  });

  it("surfaces the failure and frees the scope for retry", async () => {
    terminalCreate.mockRejectedValue(new Error("PTY host is unhealthy"));

    createTerminalForScope("scope-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    createTerminalForScope("scope-a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminalCreate).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        level: "error",
        title: "Failed to create terminal",
        message: "PTY host is unhealthy",
      }),
    );
  });

  it("keeps the scope locked until terminalCreate reports its failure", async () => {
    vi.useFakeTimers();
    terminalCreate.mockReturnValue(new Promise(() => {}));

    createTerminalForScope("scope-b");
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(1);
  });
});
