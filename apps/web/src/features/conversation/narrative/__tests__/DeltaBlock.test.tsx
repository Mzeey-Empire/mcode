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
  it("hides every streamed plan prefix before the typewriter or code skeleton can render it", async () => {
    const summary = "A short summary.\n";
    const fence = "````mcode-plan\n# Hidden\n```ts\nsecret();\n```\n````";
    const { container, rerender } = render(<DeltaBlock text={summary} isStreaming showCursor={false} />);
    await waitFor(() => expect(container.textContent).toBe(summary));
    for (let end = 1; end <= fence.length; end++) {
      rerender(<DeltaBlock text={summary + fence.slice(0, end)} isStreaming showCursor={false} />);
      expect(container.textContent).toBe(summary);
      expect(container.querySelector('[data-testid="streaming-skeleton"]')).toBeNull();
    }
    rerender(<DeltaBlock text={summary + fence} isStreaming={false} showCursor={false} />);
    await waitFor(() => expect(container.textContent).toBe(summary));
  });
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

  it("swaps a trailing assembling skeleton for settled content once the stream ends", async () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |";
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor={false} />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    await waitFor(() => expect(skeleton.getAttribute("aria-label")).toBe("table assembling"));

    rerender(<DeltaBlock text={text} isStreaming={false} showCursor={false} />);

    const settled = await screen.findByTestId("markdown-content");
    await waitFor(() => expect(settled.textContent).toBe(text));
    expect(screen.queryByTestId("streaming-skeleton")).toBeNull();
  });

  it("uses the markdown adapter after settling", async () => {
    render(<DeltaBlock text="**settled**" isStreaming={false} showCursor={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content").textContent).toBe("**settled**");
      expect(screen.getByTestId("markdown-content").getAttribute("data-streaming")).toBe("false");
    });
  });

  it("renders streaming and settled text as 16/28 prose", async () => {
    const { container, rerender } = render(<DeltaBlock text="answer" isStreaming showCursor={false} />);
    const root = container.firstElementChild;
    expect(root?.classList.contains("text-prose")).toBe(true);
    await waitFor(() => expect(container.querySelector("p.whitespace-pre-wrap")).not.toBeNull());
    expect(container.querySelector("p.whitespace-pre-wrap")?.classList.contains("text-sm")).toBe(false);

    rerender(<DeltaBlock text="answer" isStreaming={false} showCursor={false} />);
    await waitFor(() => expect(screen.getByTestId("markdown-content")).toBeTruthy());
    expect(container.firstElementChild?.classList.contains("text-prose")).toBe(true);
  });

  it("streams blank-line paragraphs as the same spaced paragraphs markdown settles to", async () => {
    const { container: streaming } = render(
      <DeltaBlock text={"First paragraph.\n\nSecond paragraph.\n\n \n\n "} isStreaming showCursor={false} />,
    );

    await waitFor(() =>
      expect([...streaming.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
        "First paragraph.",
        "Second paragraph.",
      ]),
    );
    const paragraphs = [...streaming.querySelectorAll("p")];
    expect(paragraphs.every((p) => p.classList.contains("mb-2"))).toBe(true);
  });

  it("parks a 2x18 caret after the last word, centred on its line", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 56, width: 400, height: 56, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart: vi.fn(),
      setEnd: vi.fn(),
      getClientRects: vi.fn(() => makeRectList({ right: 120, top: 28, height: 28 })),
    } as unknown as Range);

    const { container } = render(<DeltaBlock text={"word ".repeat(40)} isStreaming showCursor />);
    const caret = container.querySelector<HTMLElement>(".typing-cursor");

    expect(caret?.style.width).toBe("2px");
    expect(caret?.style.height).toBe("18px");
    expect(caret?.style.transform).toBe("translate3d(122px, 33px, 0)");
    // Trap 4: the caret is an overlay sibling of the text, never moved into React-owned paragraphs.
    expect(caret?.parentElement).toBe(container.firstElementChild);
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
