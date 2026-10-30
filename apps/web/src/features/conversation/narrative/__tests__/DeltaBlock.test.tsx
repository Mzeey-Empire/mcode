import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeltaBlock } from "../DeltaBlock";

vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-content" data-streaming={String(isStreaming)}>
      <p>{content}</p>
    </div>
  ),
}));

describe("DeltaBlock", () => {
  it("hides every streamed plan prefix before the reveal or code skeleton can render it", async () => {
    const summary = "A short summary.\n\n";
    const fence = "````mcode-plan\n# Hidden\n```ts\nsecret();\n```\n````";
    const { container, rerender } = render(<DeltaBlock text={summary} isStreaming />);
    await waitFor(() => expect(container.textContent).toBe(summary));
    for (let end = 1; end <= fence.length; end++) {
      rerender(<DeltaBlock text={summary + fence.slice(0, end)} isStreaming />);
      expect(container.textContent).toBe(summary);
      expect(container.querySelector('[data-testid="streaming-skeleton"]')).toBeNull();
    }
    rerender(<DeltaBlock text={summary + fence} isStreaming={false} />);
    await waitFor(() => expect(container.textContent).toBe(summary));
  });
  it("hides an unfinished paragraph while streaming", () => {
    const { container } = render(<DeltaBlock text="Still typing the first par" isStreaming />);

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("markdown-content")).toBeNull();
  });

  it("renders finished paragraphs through markdown and holds back the one still streaming", async () => {
    render(<DeltaBlock text={"**First** paragraph.\n\nSecond par"} isStreaming />);

    const markdown = await screen.findByTestId("markdown-content");
    expect(markdown.textContent).toBe("**First** paragraph.\n\n");
    expect(markdown.getAttribute("data-streaming")).toBe("false");
  });

  it("shows everything once the stream settles", async () => {
    const text = "First paragraph.\n\nSecond par";
    const { rerender } = render(<DeltaBlock text={text} isStreaming />);
    await screen.findByTestId("markdown-content");

    rerender(<DeltaBlock text={text} isStreaming={false} />);

    await waitFor(() => expect(screen.getByTestId("markdown-content").textContent).toBe(text));
  });

  it("shows a skeleton for a code fence still streaming in the tail", async () => {
    render(<DeltaBlock text={"Intro.\n\n```ts\nconst a = 1;\n\nconst b"} isStreaming />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("ts assembling");
    expect((await screen.findByTestId("markdown-content")).textContent).toBe("Intro.\n\n");
  });

  it("shows a skeleton for a mermaid fence still streaming", async () => {
    render(<DeltaBlock text={"intro\n```mermaid\ngraph TD; A--"} isStreaming />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("diagram assembling");
  });

  it("shows a skeleton for a table still receiving rows", async () => {
    render(<DeltaBlock text={"lead\n| A | B |\n| - | - |\n| 1 |"} isStreaming />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("table assembling");
  });

  it("swaps a trailing assembling skeleton for settled content once the stream ends", async () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |";
    const { rerender } = render(<DeltaBlock text={text} isStreaming />);
    await screen.findByTestId("streaming-skeleton");

    rerender(<DeltaBlock text={text} isStreaming={false} />);

    const settled = await screen.findByTestId("markdown-content");
    await waitFor(() => expect(settled.textContent).toBe(text));
    expect(screen.queryByTestId("streaming-skeleton")).toBeNull();
  });

  it("streams finished paragraphs without a typing caret", async () => {
    const { container } = render(<DeltaBlock text={"Finished paragraph.\n\nStill typ"} isStreaming />);

    const markdown = await screen.findByTestId("markdown-content");
    expect(markdown.textContent).toBe("Finished paragraph.\n\n");
    expect(container.querySelector(".typing-cursor")).toBeNull();
  });
});
