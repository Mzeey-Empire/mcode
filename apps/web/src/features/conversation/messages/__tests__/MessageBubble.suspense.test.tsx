import { createMockMessage } from "@mcode/contracts/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
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

/** Renders, then lets the bubble's lazy chunks finish loading inside act(). */
async function renderSettled(ui: ReactElement): Promise<ReturnType<typeof render>> {
  const view = render(ui);
  await act(async () => {});
  return view;
}

describe("MessageBubble while MarkdownContent is suspended", () => {
  it("keeps the user text visible in the bubble instead of rendering it empty", async () => {
    const { container } = await renderSettled(<MessageBubble message={createMockMessage({ thread_id: "thread-1", role: "user", content: "hello there" })} />);
    const bubble = container.querySelector("[data-selected-text-content]");
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain("hello there");
  });

  it("keeps the assistant text visible instead of rendering it empty", async () => {
    const { container } = await renderSettled(<MessageBubble message={createMockMessage({ thread_id: "thread-1", role: "assistant", content: "done." })} />);
    const body = container.querySelector("[data-testid='assistant-response-text']");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("done.");
  });
});
