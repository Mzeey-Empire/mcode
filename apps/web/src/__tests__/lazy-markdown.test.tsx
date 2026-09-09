import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";

vi.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));
vi.mock("remark-gfm", () => ({ __esModule: true, default: () => {} }));
vi.mock("../../hooks/useHighlighter", () => ({
  useHighlighter: vi.fn(() => ({ html: null })),
}));
vi.mock("../../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

import { MessageBubble } from "@/features/conversation";

const assistantMsg = {
  id: "msg-1",
  thread_id: "t-1",
  role: "assistant" as const,
  content: "Hello world",
  cost_usd: null,
  tokens_used: null,
  timestamp: new Date().toISOString(),
  sequence: 0,
  attachments: [],
  tool_calls: null,
  files_changed: null,
};

describe("MessageBubble lazy MarkdownContent", () => {
  beforeEach(() => {
    resetThreadStoreForTests({ records: new Map([["t-1", {
      ...createEmptyThreadRecord(),
      narrativeByMessage: { "msg-1": { tools: [], thoughts: [], hooks: [] } },
    }]]) });
  });

  afterEach(() => {
    cleanup();
    resetThreadStoreForTests();
  });

  it("renders assistant message content via lazy-loaded MarkdownContent", async () => {
    render(<MessageBubble message={assistantMsg} />);
    expect(await screen.findByTestId("markdown")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });
});
