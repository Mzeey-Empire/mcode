import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThoughtRow } from "../ThoughtRow";
import type { ThoughtSegment } from "../types";

const brainRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  function CountingBrain() {
    brainRenders.count += 1;
    return <svg data-testid="brain-icon" />;
  }
  return { ...actual, Brain: CountingBrain };
});

vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

function reasoning(over: Partial<ThoughtSegment> = {}): ThoughtSegment {
  return { text: "Weighing options.", startedAt: 1_000, kind: "reasoning", isExplicitNonFinal: true, ...over };
}

describe("ThoughtRow", () => {
  beforeEach(() => {
    brainRenders.count = 0;
  });

  it("reads Thinking with no timer while active", () => {
    render(<ThoughtRow segment={reasoning()} isActive />);

    expect(screen.getByRole("button")).toHaveTextContent(/^Thinking$/);
  });

  it("reads Thought with its clock duration once settled", () => {
    render(<ThoughtRow segment={reasoning({ endedAt: 66_000 })} isActive={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(/^Thought1:05$/);
  });

  it("renders a static row with no chevron when there is no text", () => {
    render(<ThoughtRow segment={reasoning({ text: "  ", endedAt: 3_000 })} isActive={false} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Thought")).toBeInTheDocument();
  });

  it("shows the reasoning text only after the row is opened", async () => {
    render(<ThoughtRow segment={reasoning({ endedAt: 3_000 })} isActive={false} />);
    expect(screen.queryByText("Weighing options.")).toBeNull();

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Weighing options.")).toBeInTheDocument();
  });

  it("does not re-render the collapsed header while reasoning text grows", () => {
    const { rerender } = render(<ThoughtRow segment={reasoning({ text: "Weigh" })} isActive />);
    const rendersAfterMount = brainRenders.count;
    expect(rendersAfterMount).toBeGreaterThan(0);

    rerender(<ThoughtRow segment={reasoning({ text: "Weighing" })} isActive />);
    rerender(<ThoughtRow segment={reasoning({ text: "Weighing options." })} isActive />);

    expect(brainRenders.count).toBe(rendersAfterMount);
    expect(screen.queryByText(/Weigh/)).toBeNull();
  });

  it("updates the open body as text grows without re-rendering the header", async () => {
    const { rerender } = render(<ThoughtRow segment={reasoning({ text: "Weigh" })} isActive />);
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Weigh")).toBeInTheDocument();
    const rendersAfterOpen = brainRenders.count;

    rerender(<ThoughtRow segment={reasoning({ text: "Weighing options." })} isActive />);

    expect(await screen.findByText("Weighing options.")).toBeInTheDocument();
    expect(brainRenders.count).toBe(rendersAfterOpen);
  });
});
