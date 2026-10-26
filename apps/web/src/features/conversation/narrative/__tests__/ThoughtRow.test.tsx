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

    expect(screen.getByRole("button")).toHaveTextContent(/^ThinkingWeighing options\.$/);
  });

  it("reads Thought with its duration in words once settled", () => {
    render(<ThoughtRow segment={reasoning({ endedAt: 66_000 })} isActive={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(/^Thought for 1m 5sWeighing options\.$/);
  });

  it("rounds a sub-second thought up to one second", () => {
    render(<ThoughtRow segment={reasoning({ endedAt: 1_300 })} isActive={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(/^Thought for 1sWeighing options\.$/);
  });

  it("renders a static row with no chevron when there is no text", () => {
    render(<ThoughtRow segment={reasoning({ text: "  ", endedAt: 3_000 })} isActive={false} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Thought for 2s")).toBeInTheDocument();
  });

  it("shows the reasoning text only after the row is opened", async () => {
    render(<ThoughtRow segment={reasoning({ endedAt: 3_000 })} isActive={false} />);
    expect(screen.queryByTestId("markdown-content")).toBeNull();

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Weighing options.")).toBeInTheDocument();
  });

  it("does not re-render the collapsed header while text grows past the first line", () => {
    const { rerender } = render(<ThoughtRow segment={reasoning({ text: "Weighing options.\nFirst" })} isActive />);
    const rendersAfterMount = brainRenders.count;
    expect(rendersAfterMount).toBeGreaterThan(0);

    rerender(<ThoughtRow segment={reasoning({ text: "Weighing options.\nFirst, the" })} isActive />);
    rerender(<ThoughtRow segment={reasoning({ text: "Weighing options.\nFirst, the cache." })} isActive />);

    expect(brainRenders.count).toBe(rendersAfterMount);
    expect(screen.queryByText(/First/)).toBeNull();
  });

  it("previews the first line of a collapsed thought without markdown markers", () => {
    render(
      <ThoughtRow segment={reasoning({ text: "**Checking conventions**\nmore detail", endedAt: 5_000 })} isActive={false} />,
    );

    const header = screen.getByRole("button");
    expect(header).toHaveTextContent(/^Thought for 4sChecking conventions$/);
    expect(header).not.toHaveTextContent("**");
    expect(screen.queryByText("more detail")).toBeNull();
  });

  it("skips leading blank lines and list markers for the preview", () => {
    render(<ThoughtRow segment={reasoning({ text: "\n  \n- Reading the flagged comments\nrest" })} isActive />);

    expect(screen.getByRole("button")).toHaveTextContent(/^ThinkingReading the flagged comments$/);
  });

  it("hides the preview once opened and shows the full text in the linked panel", async () => {
    render(<ThoughtRow segment={reasoning({ text: "## Plan\nStep one.", endedAt: 3_000 })} isActive={false} />);
    expect(screen.getByRole("button")).toHaveTextContent(/^Thought for 2sPlan$/);

    await userEvent.click(screen.getByRole("button"));

    const header = screen.getByRole("button");
    expect(header).toHaveTextContent(/^Thought for 2s$/);
    const panelId = header.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId ?? "")).toHaveTextContent("## Plan Step one.");
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
