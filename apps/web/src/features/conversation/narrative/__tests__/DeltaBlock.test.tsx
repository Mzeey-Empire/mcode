import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeltaBlock } from "../DeltaBlock";

vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-content" data-streaming={String(isStreaming)}>
      {content}
    </div>
  ),
}));

vi.mock("@/components/chat/MermaidBlock", () => ({
  __esModule: true,
  default: ({ code, isStreaming }: { code: string; isStreaming?: boolean }) => (
    <div data-testid="mermaid-block" data-streaming={String(isStreaming)}>
      {code}
    </div>
  ),
}));

vi.mock("@/components/chat/CodeBlock", () => ({
  __esModule: true,
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <div data-testid="code-block" data-language={language}>
      {code}
    </div>
  ),
}));

function makeRectList(rect: Partial<DOMRect>): DOMRectList {
  const item = {
    right: rect.right ?? 12,
    top: rect.top ?? 4,
    height: rect.height ?? 16,
  } as DOMRect;
  return {
    0: item,
    length: 1,
    item: (index: number) => (index === 0 ? item : null),
    [Symbol.iterator]: function* () {
      yield item;
    },
  } as DOMRectList;
}

describe("DeltaBlock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses plain pre-wrapped text while streaming", () => {
    const { container } = render(
      <DeltaBlock text={"streaming text ".repeat(10)} isStreaming showCursor={false} />,
    );

    expect(screen.queryByTestId("markdown-content")).toBeNull();
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toContain(
      "streaming text",
    );
  });

  it("renders a closed mermaid fence as a diagram part while streaming", async () => {
    render(
      <DeltaBlock
        text={"before\n```mermaid\ngraph TD; A-->B;\n```\nafter"}
        isStreaming
        showCursor={false}
      />,
    );

    const block = await screen.findByTestId("mermaid-block");
    await waitFor(() => expect(block.getAttribute("data-streaming")).toBe("false"));
    await waitFor(() => expect(block.textContent).toBe("graph TD; A-->B;"));
  });

  it("shows a skeleton for a mermaid fence still streaming", async () => {
    render(
      <DeltaBlock text={"intro\n```mermaid\ngraph TD; A--"} isStreaming showCursor={false} />,
    );

    const skeleton = await screen.findByTestId("streaming-skeleton");
    await waitFor(() => expect(skeleton.getAttribute("aria-label")).toBe("diagram assembling"));
    expect(screen.queryByTestId("mermaid-block")).toBeNull();
  });

  it("renders a closed code fence with the code block chrome while streaming", async () => {
    render(
      <DeltaBlock
        text={"intro\n```ts\nconst x = 1;\n```\ntail"}
        isStreaming
        showCursor={false}
      />,
    );

    const block = await screen.findByTestId("code-block");
    await waitFor(() => expect(block.textContent).toBe("const x = 1;"));
    expect(block.getAttribute("data-language")).toBe("ts");
  });

  it("shows a skeleton for a table still receiving rows", async () => {
    render(
      <DeltaBlock text={"lead\n| A | B |\n| - | - |\n| 1 |"} isStreaming showCursor={false} />,
    );

    const skeleton = await screen.findByTestId("streaming-skeleton");
    await waitFor(() => expect(skeleton.getAttribute("aria-label")).toBe("table assembling"));
  });

  it("renders a real table once a non-table line closes it", async () => {
    render(
      <DeltaBlock
        text={"| A | B |\n| - | - |\n| 1 | 2 |\n\ndone"}
        isStreaming
        showCursor={false}
      />,
    );

    await waitFor(() => {
      const cells = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
      expect(cells).toEqual(["A", "B"]);
    });
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["1", "2"]);
  });

  it("uses the markdown adapter after settling", async () => {
    render(<DeltaBlock text="**settled**" isStreaming={false} showCursor={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content").textContent).toBe("**settled**");
      expect(screen.getByTestId("markdown-content").getAttribute("data-streaming")).toBe("false");
    });
  });

  it("does not re-measure the cursor when displayed text is unchanged", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const range = {
      setStart: vi.fn(),
      setEnd: vi.fn(),
      getClientRects: vi.fn(() => makeRectList({ right: 12, top: 4, height: 16 })),
    } as unknown as Range;
    const createRange = vi.spyOn(document, "createRange").mockReturnValue(range);

    const text = "x".repeat(140);
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor />);
    const firstMeasureCount = createRange.mock.calls.length;

    rerender(<DeltaBlock text={text} isStreaming showCursor />);

    expect(firstMeasureCount).toBeGreaterThan(0);
    expect(createRange).toHaveBeenCalledTimes(firstMeasureCount);
  });
});
