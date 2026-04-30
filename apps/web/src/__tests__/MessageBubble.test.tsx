import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";

// Mock MarkdownContent to detect when it's used
vi.mock("../components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
  MarkdownContent: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
}));

const makeMessage = (content: string) => ({
  id: "msg-1",
  thread_id: "thread-1",
  role: "user" as const,
  content,
  timestamp: new Date().toISOString(),
  attachments: [],
  cost_usd: null,
  tokens_used: null,
  sequence: 1,
});

describe("MessageBubble user messages", () => {
  it("renders user message through MarkdownContent with variant='user'", async () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    await waitFor(() => {
      const md = container.querySelector("[data-testid='markdown-content']");
      expect(md).toBeInTheDocument();
      expect(md?.getAttribute("data-variant")).toBe("user");
    });
  });

  it("does not render user message as plain <p>", async () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    await waitFor(() => {
      const plainP = container.querySelector("p.whitespace-pre-wrap");
      expect(plainP).not.toBeInTheDocument();
    });
  });
});

describe("MessageBubble assistant plan-questions suppression", () => {
  const makeAssistantMessage = (content: string) => ({
    id: "msg-asst",
    thread_id: "thread-1",
    role: "assistant" as const,
    content,
    timestamp: new Date().toISOString(),
    attachments: [],
    cost_usd: null,
    tokens_used: null,
    sequence: 2,
  });

  it("renders nothing when the assistant body is exclusively a plan-questions block", () => {
    const planQuestionsOnly = [
      "```plan-questions",
      JSON.stringify([
        {
          id: "q1",
          category: "ARCHITECTURE",
          question: "Which approach?",
          options: [
            { id: "o1", title: "A", description: "First" },
            { id: "o2", title: "B", description: "Second" },
          ],
        },
      ]),
      "```",
    ].join("\n");

    const { container } = render(
      <MessageBubble message={makeAssistantMessage(planQuestionsOnly)} />,
    );
    // The wizard renders the questions; an empty assistant bubble must not show
    // up as a stray ASSISTANT header with no body.
    expect(container.textContent ?? "").not.toMatch(/assistant/i);
    expect(container.querySelector("[data-testid='markdown-content']")).toBeNull();
  });

  it("still renders the assistant bubble when prose surrounds the plan-questions block", () => {
    const mixed = [
      "Here are some questions:",
      "```plan-questions",
      "[]",
      "```",
      "Let me know.",
    ].join("\n");

    const { container } = render(
      <MessageBubble message={makeAssistantMessage(mixed)} />,
    );
    expect(container.querySelector("[data-testid='markdown-content']")).not.toBeNull();
  });

  it("renders nothing when the assistant body is only whitespace", () => {
    const { container } = render(
      <MessageBubble message={makeAssistantMessage("   \n  \n")} />,
    );
    expect(container.textContent ?? "").not.toMatch(/assistant/i);
  });
});
