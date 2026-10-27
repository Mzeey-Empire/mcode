import { createMockMessage } from "@mcode/contracts/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

describe("MessageBubble while MarkdownContent is suspended", () => {
  it("keeps the user text visible in the bubble instead of rendering it empty", () => {
    const { container } = render(<MessageBubble message={createMockMessage({ thread_id: "thread-1", role: "user", content: "hello there" })} />);
    const bubble = container.querySelector("[data-selected-text-content]");
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain("hello there");
  });

  it("keeps the assistant text visible instead of rendering it empty", () => {
    const { container } = render(<MessageBubble message={createMockMessage({ thread_id: "thread-1", role: "assistant", content: "done." })} />);
    const body = container.querySelector("[data-testid='assistant-response-text']");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("done.");
  });
});
