import { createMockBackgroundCommand } from "@mcode/contracts/testing";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { BackgroundCommandList } from "../BackgroundCommandList";
import { useBackgroundCommandStore } from "../backgroundCommandStore";

vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => mockTransport,
}));

const list = vi.mocked(mockTransport.listBackgroundCommands);
const stop = vi.mocked(mockTransport.stopBackgroundCommand);
const build = createMockBackgroundCommand({ toolCallId: "build", label: "bun run build", awaited: true });
const devServer = createMockBackgroundCommand({ toolCallId: "dev", label: "bun run dev", awaited: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("BackgroundCommandList", () => {
  beforeEach(() => {
    list.mockReset();
    stop.mockReset();
    useBackgroundCommandStore.setState({ loads: new Map() });
    useConnectionStore.setState({ status: "connected" });
  });

  it("lists running commands with the Awaited tag only on awaited ones", async () => {    list.mockResolvedValue([build, devServer]);
    render(<BackgroundCommandList threadId="thread-1" />);
    const buildRow = await screen.findByRole("listitem", { name: "bun run build" });
    const devRow = screen.getByRole("listitem", { name: "bun run dev" });
    expect(within(buildRow).getByText("Awaited")).toBeTruthy();
    expect(within(devRow).queryByText("Awaited")).toBeNull();
    expect(list).toHaveBeenCalledWith("thread-1");
  });

  it("keeps a stopped row until the reload says it settled", async () => {
    list.mockResolvedValueOnce([build, devServer]).mockResolvedValueOnce([devServer]);
    const pending = deferred<"stopped" | "not-running">();
    stop.mockReturnValue(pending.promise);
    render(<BackgroundCommandList threadId="thread-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop bun run build" }));
    expect(stop).toHaveBeenCalledWith("thread-1", "build");
    expect((screen.getByRole("button", { name: "Stopping bun run build" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop bun run dev" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { pending.resolve("stopped"); await pending.promise; });
    expect(screen.getByRole("listitem", { name: "bun run build" })).toBeTruthy();
    act(() => { pushEmitter.emit("backgroundCommand.changed", { threadId: "thread-1" }); });
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "bun run build" })).toBeNull());
  });

  it("re-enables Stop with an error when the stop request fails", async () => {
    list.mockResolvedValue([build]);
    stop.mockRejectedValue(new Error("boom"));
    render(<BackgroundCommandList threadId="thread-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop bun run build" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Stop failed");
    expect((screen.getByRole("button", { name: "Stop bun run build" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("listitem", { name: "bun run build" })).toBeTruthy();
  });

  it("reloads on a push for its thread only", async () => {
    list.mockResolvedValue([build]);
    render(<BackgroundCommandList threadId="thread-1" />);
    await screen.findByRole("listitem", { name: "bun run build" });
    act(() => { pushEmitter.emit("backgroundCommand.changed", { threadId: "other-thread" }); });
    expect(list).toHaveBeenCalledTimes(1);
    act(() => { pushEmitter.emit("backgroundCommand.changed", { threadId: "thread-1" }); });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("drops a deleted thread's list", async () => {
    list.mockResolvedValue([build]);
    await useBackgroundCommandStore.getState().ensure("thread-1");
    pushEmitter.emit("thread.deleted", { threadId: "thread-1" });
    expect(useBackgroundCommandStore.getState().loads.has("thread-1")).toBe(false);
  });

  it("says a failed load failed instead of showing an empty list", async () => {
    list.mockRejectedValue(new Error("offline"));
    render(<BackgroundCommandList threadId="thread-1" />);
    expect((await screen.findByTestId("background-commands-failed")).textContent).toContain("Could not load");
  });

  it("shows nothing when the thread has no running commands", async () => {
    list.mockResolvedValue([]);
    const { container } = render(<BackgroundCommandList threadId="thread-1" />);
    await waitFor(() => expect(useBackgroundCommandStore.getState().loads.get("thread-1")?.kind).toBe("ready"));
    expect(container.textContent).toBe("");
  });
});
