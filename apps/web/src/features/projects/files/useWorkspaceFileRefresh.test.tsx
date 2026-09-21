import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread } from "@/__tests__/mocks/transport";

const refreshWorkspaceFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/transport", () => ({
  getTransport: () => ({ refreshWorkspaceFiles }),
}));

import { useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

function RefreshSubscriber() {
  useWorkspaceFileRefresh("workspace-1", "thread-1");
  return null;
}

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("useWorkspaceFileRefresh", () => {
  // The refresh throttle is module state, so each test runs at a later fake
  // time and always starts outside the previous test's throttle window.
  let now = 1_000_000;
  const advancePastThrottle = () => vi.setSystemTime(now += 60_000);

  beforeEach(() => {
    refreshWorkspaceFiles.mockClear();
    refreshWorkspaceFiles.mockResolvedValue(undefined);
    // Fake only Date so throttle windows advance while waitFor keeps real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    advancePastThrottle();
    act(() => useWorkspaceStore.setState({ threads: [] }));
    act(() => useConnectionStore.getState().setStatus("connecting"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes when the connection opens and again after reconnect", async () => {
    render(<RefreshSubscriber />);
    expect(refreshWorkspaceFiles).not.toHaveBeenCalled();

    act(() => useConnectionStore.getState().setStatus("connected"));
    await waitFor(() => expect(refreshWorkspaceFiles).toHaveBeenCalledTimes(1));
    expect(refreshWorkspaceFiles).toHaveBeenLastCalledWith("workspace-1", "thread-1");

    advancePastThrottle();
    act(() => useConnectionStore.getState().setStatus("reconnecting"));
    act(() => useConnectionStore.getState().setStatus("connected"));
    await waitFor(() => expect(refreshWorkspaceFiles).toHaveBeenCalledTimes(2));
  });

  it("refreshes on window focus but throttles bursts", async () => {
    render(<RefreshSubscriber />);
    act(() => useConnectionStore.getState().setStatus("connected"));
    await waitFor(() => expect(refreshWorkspaceFiles).toHaveBeenCalledTimes(1));

    // Inside the throttle window the focus event is a no-op.
    focusWindow();
    expect(refreshWorkspaceFiles).toHaveBeenCalledTimes(1);

    advancePastThrottle();
    focusWindow();
    expect(refreshWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it("reports a refresh failure that is not caused by a disconnected transport", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshWorkspaceFiles.mockRejectedValueOnce(new Error("Workspace is unavailable"));

    render(<RefreshSubscriber />);
    act(() => useConnectionStore.getState().setStatus("connected"));

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      "[files] Failed to refresh workspace files",
      expect.objectContaining({ message: "Workspace is unavailable" }),
    ));
    consoleError.mockRestore();
  });

  it("refreshes the workspace scope while the thread is a client-only placeholder", async () => {
    act(() => useWorkspaceStore.setState({
      threads: [{ ...createMockThread({ id: "thread-1" }), clientPreparing: true }],
    }));

    render(<RefreshSubscriber />);
    act(() => useConnectionStore.getState().setStatus("connected"));

    await waitFor(() => expect(refreshWorkspaceFiles).toHaveBeenLastCalledWith("workspace-1", undefined));

    // The optimistic swap persists the row; the thread scope attaches on the
    // flag change even if the component kept the same threadId prop.
    advancePastThrottle();
    act(() => useWorkspaceStore.setState({
      threads: [createMockThread({ id: "thread-1" })],
    }));
    await waitFor(() => expect(refreshWorkspaceFiles).toHaveBeenLastCalledWith("workspace-1", "thread-1"));
  });
});
