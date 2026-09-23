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

  it("frees the scope when the create RPC never answers", async () => {
    vi.useFakeTimers();
    terminalCreate.mockReturnValue(new Promise(() => {}));

    createTerminalForScope("scope-b");
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(2);
  });

  it("keeps a retried scope locked when the stale request resolves", async () => {
    vi.useFakeTimers();
    let resolveStale: ((value: { ptyId: string; shell: string }) => void) | undefined;
    terminalCreate
      .mockImplementationOnce(
        () =>
          new Promise<{ ptyId: string; shell: string }>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    createTerminalForScope("scope-c");
    await vi.advanceTimersByTimeAsync(20_000);
    createTerminalForScope("scope-c");
    expect(terminalCreate).toHaveBeenCalledTimes(2);

    // The stale request resolves after the retry re-acquired the scope lock:
    // its release must not unlock the in-flight retry.
    resolveStale?.({ ptyId: "pty-stale", shell: "pwsh" });
    await vi.advanceTimersByTimeAsync(0);
    createTerminalForScope("scope-c");
    expect(terminalCreate).toHaveBeenCalledTimes(2);
  });

  it("does not toast a stale rejection once a retry owns the scope", async () => {
    vi.useFakeTimers();
    let rejectStale: ((error: Error) => void) | undefined;
    terminalCreate
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
            rejectStale = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    createTerminalForScope("scope-d");
    await vi.advanceTimersByTimeAsync(20_000);
    createTerminalForScope("scope-d");
    rejectStale?.(new Error("PTY host is unhealthy"));
    await vi.advanceTimersByTimeAsync(0);

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
