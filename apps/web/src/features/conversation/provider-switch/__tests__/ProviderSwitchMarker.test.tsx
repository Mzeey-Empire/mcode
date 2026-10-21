import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { MessageBubble } from "@/features/conversation/messages/MessageBubble";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";

const transport = vi.hoisted(() => ({ readHandoff: vi.fn() }));
vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => transport,
}));

const HANDOFF_ID = "01J0000000000000000000000A";
const marker = createMockMessage({
  id: "switch-1",
  thread_id: "thread-1",
  role: "system",
  content: "Switched from Claude to Codex",
  providerSwitch: { fromProvider: "claude", toProvider: "codex", handoffId: HANDOFF_ID },
});
const meta = {
  schemaVersion: 2 as const,
  kind: "switch" as const,
  fromProvider: "claude",
  toProvider: "codex",
  coveredSequences: [1, 2, 3],
  omittedSequences: [4],
  budgetBytes: 1000,
  droppedOptions: [{ option: "effort", value: "max", reason: "Codex has no max effort" }],
};

beforeEach(() => {
  transport.readHandoff.mockReset();
  resetThreadStoreForTests({ records: new Map([["thread-1", createEmptyThreadRecord()]]) });
});

afterEach(() => resetThreadStoreForTests());

describe("ProviderSwitchMarker", () => {
  const messages = [
    { role: "user" as const, provider: null, text: "fix the => arrow" },
    { role: "assistant" as const, provider: "claude", text: "Fixed in parser.ts" },
  ];
  const toggle = () => screen.getByRole("button", { name: "What Codex saw" });

  it("names both providers and reads the handoff once when expanded", async () => {
    transport.readHandoff.mockResolvedValue({ meta, history: "RAW HISTORY", messages });
    const user = userEvent.setup();
    render(<MessageBubble message={marker} />);
    expect(screen.getByRole("note", { name: "Switched from Claude to Codex" })).toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("fix the => arrow")).toBeInTheDocument();
    expect(screen.getByText("Fixed in parser.ts")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Dropped effort: Codex has no max effort")).toBeInTheDocument();
    expect(screen.getByText("1 message left out to fit")).toBeInTheDocument();
    expect(screen.queryByText("RAW HISTORY")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Raw prompt" }));
    expect(screen.getByText("RAW HISTORY")).toBeInTheDocument();

    await user.click(toggle());
    await user.click(toggle());
    expect(transport.readHandoff).toHaveBeenCalledTimes(1);
    expect(transport.readHandoff).toHaveBeenCalledWith("thread-1", HANDOFF_ID);
  });

  it("shows the raw history when it could not be split into messages", async () => {
    transport.readHandoff.mockResolvedValue({ meta, history: "RAW HISTORY", messages: [] });
    const user = userEvent.setup();
    render(<MessageBubble message={marker} />);
    await user.click(toggle());
    expect(await screen.findByText("RAW HISTORY")).toBeInTheDocument();
  });

  it("says the record is unavailable when the read returns null", async () => {
    transport.readHandoff.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<MessageBubble message={marker} />);
    await user.click(toggle());
    expect(await screen.findByText("Handoff record unavailable")).toBeInTheDocument();
  });
});

describe("thread.providerSwitched push", () => {
  const push = () => pushEmitter.emit("thread.providerSwitched", {
    threadId: "thread-1", provider: "codex", model: "gpt-5.6", providersUsed: ["claude", "codex"], marker,
  });
  const markerCount = () => useThreadStore.getState().records.get("thread-1")?.messages.filter((m) => m.id === "switch-1").length;

  beforeEach(() => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1", provider: "claude" })] });
    startPushListeners();
  });
  afterEach(() => stopPushListeners());

  it("patches the thread row with the new provider and providers used", () => {
    act(() => push());
    expect(useWorkspaceStore.getState().threads[0]).toMatchObject({ provider: "codex", model: "gpt-5.6", providers_used: ["claude", "codex"] });
  });

  it("appends the marker once after an in-flight load settles", () => {
    useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), loading: true }]]) });
    act(() => push());
    expect(markerCount()).toBe(0);
    act(() => useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), loading: false }]]) }));
    expect(markerCount()).toBe(1);
  });

  it("does not duplicate a marker the load already holds", () => {
    useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), loading: true }]]) });
    act(() => push());
    act(() => useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), messages: [marker], loading: false }]]) }));
    expect(markerCount()).toBe(1);
  });
});
