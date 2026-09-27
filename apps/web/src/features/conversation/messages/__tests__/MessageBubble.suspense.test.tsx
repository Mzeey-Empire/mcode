import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Message, StoredAttachment } from "@/transport";
import { MessageBubble } from "../MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";

vi.mock("@/components/chat/MarkdownContent", () => {
  const SuspendedMarkdownContent = () => {
    throw new Promise(() => {});
  };
  return {
    __esModule: true,
    default: SuspendedMarkdownContent,
    MarkdownContent: SuspendedMarkdownContent,
  };
});

beforeEach(() => {
  resetThreadStoreForTests({ records: new Map([["thread-1", createEmptyThreadRecord()]]) });
});

afterEach(() => {
  cleanup();
});

function makeMessage(content: string, role: "user" | "assistant" = "user"): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role,
    content,
    timestamp: new Date().toISOString(),
    attachments: [] as StoredAttachment[],
    cost_usd: null,
    tokens_used: null,
    sequence: 1,
    tool_calls: null,
    files_changed: null,
  };
}

describe("MessageBubble while MarkdownContent is suspended", () => {
  it("keeps the user text visible in the bubble instead of rendering it empty", () => {
    const { container } = render(<MessageBubble message={makeMessage("hello there")} />);
    const bubble = container.querySelector(".bg-accent");
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain("hello there");
  });

  it("keeps the assistant text visible instead of rendering it empty", () => {
    const { container } = render(<MessageBubble message={makeMessage("done.", "assistant")} />);
    const body = container.querySelector("[data-testid='assistant-response-text']");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("done.");
  });
});
