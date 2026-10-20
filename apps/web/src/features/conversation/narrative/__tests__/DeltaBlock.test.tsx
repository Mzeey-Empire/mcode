import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeltaBlock } from "../DeltaBlock";

vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-content" data-streaming={String(isStreaming)}>
      <p>{content}</p>
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
  it("hides every streamed plan prefix before the reveal or code skeleton can render it", async () => {
    const summary = "A short summary.\n\n";
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

  it("hides an unfinished paragraph while streaming", () => {
    const { container } = render(<DeltaBlock text="Still typing the first par" isStreaming showCursor={false} />);

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("markdown-content")).toBeNull();
  });

  it("renders finished paragraphs through markdown and holds back the one still streaming", async () => {
    render(<DeltaBlock text={"**First** paragraph.\n\nSecond par"} isStreaming showCursor={false} />);

    const markdown = await screen.findByTestId("markdown-content");
    expect(markdown.textContent).toBe("**First** paragraph.\n\n");
    expect(markdown.getAttribute("data-streaming")).toBe("false");
  });

  it("shows everything once the stream settles", async () => {
    const text = "First paragraph.\n\nSecond par";
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor={false} />);
    await screen.findByTestId("markdown-content");

    rerender(<DeltaBlock text={text} isStreaming={false} showCursor={false} />);

    await waitFor(() => expect(screen.getByTestId("markdown-content").textContent).toBe(text));
  });

  it("shows a skeleton for a code fence still streaming in the tail", async () => {
    render(<DeltaBlock text={"Intro.\n\n```ts\nconst a = 1;\n\nconst b"} isStreaming showCursor={false} />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("ts assembling");
    expect((await screen.findByTestId("markdown-content")).textContent).toBe("Intro.\n\n");
  });

  it("shows a skeleton for a mermaid fence still streaming", async () => {
    render(<DeltaBlock text={"intro\n```mermaid\ngraph TD; A--"} isStreaming showCursor={false} />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("diagram assembling");
  });

  it("shows a skeleton for a table still receiving rows", async () => {
    render(<DeltaBlock text={"lead\n| A | B |\n| - | - |\n| 1 |"} isStreaming showCursor={false} />);

    const skeleton = await screen.findByTestId("streaming-skeleton");
    expect(skeleton.getAttribute("aria-label")).toBe("table assembling");
  });

  it("swaps a trailing assembling skeleton for settled content once the stream ends", async () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |";
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor={false} />);
    await screen.findByTestId("streaming-skeleton");

    rerender(<DeltaBlock text={text} isStreaming={false} showCursor={false} />);

    const settled = await screen.findByTestId("markdown-content");
    await waitFor(() => expect(settled.textContent).toBe(text));
    expect(screen.queryByTestId("streaming-skeleton")).toBeNull();
  });

  it("parks the caret at the start of the first line before anything commits", () => {
    const { container } = render(<DeltaBlock text="Still typ" isStreaming showCursor />);
    const caret = container.querySelector<HTMLElement>(".typing-cursor");

    expect(caret?.style.transform).toBe("translate3d(0px, 0px, 0)");
    expect(caret?.style.opacity).toBe("1");
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

    const { container } = render(<DeltaBlock text={`${"word ".repeat(40)}\n\n`} isStreaming showCursor />);
    const caret = container.querySelector<HTMLElement>(".typing-cursor");

    expect(caret?.style.width).toBe("2px");
    expect(caret?.style.height).toBe("18px");
    expect(caret?.style.transform).toBe("translate3d(122px, 33px, 0)");
    // Trap 4: the caret is an overlay sibling of the text, never moved into React-owned paragraphs.
    expect(caret?.parentElement).toBe(container.firstElementChild);
  });

  it("does not re-measure the cursor when only the uncommitted tail grows", () => {
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

    const text = "Committed paragraph.\n\n";
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor />);
    const firstMeasureCount = createRange.mock.calls.length;

    rerender(<DeltaBlock text={`${text}Uncommitted tail that keeps growi`} isStreaming showCursor />);

    expect(firstMeasureCount).toBeGreaterThan(0);
    expect(createRange).toHaveBeenCalledTimes(firstMeasureCount);
  });
});
