import { createMockMessage, createMockThread } from "@mcode/contracts/testing";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessageBubble } from "@/features/conversation/messages/MessageBubble";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";

const HANDOFF_ID = "01J0000000000000000000000A";
const marker = createMockMessage({
  id: "switch-1",
  thread_id: "thread-1",
  role: "system",
  content: "Switched from Claude to Codex",
  providerSwitch: { fromProvider: "claude", toProvider: "codex", handoffId: HANDOFF_ID },
});

beforeEach(() => resetThreadStoreForTests({ records: new Map([["thread-1", createEmptyThreadRecord()]]) }));
afterEach(() => resetThreadStoreForTests());

describe("ProviderSwitchMarker", () => {
  it("names both providers in the timeline", () => {
    render(<MessageBubble message={marker} />);
    expect(screen.getByRole("note", { name: "Switched from Claude to Codex" })).toHaveTextContent("Claude→Codex");
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
