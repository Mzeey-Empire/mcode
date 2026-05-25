import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DiffPreviewMarkdown from "../DiffPreviewMarkdown";

/**
 * End-to-end test of the diff-preview render path. Confirms the remark
 * plugin's data attribute reaches the DOM and that only the qualifying
 * blocks carry it — that's the whole point of the preview overlay.
 */
describe("DiffPreviewMarkdown", () => {
  it("renders the content and tags blocks containing added lines", () => {
    const content = ["# Heading", "", "Untouched paragraph.", "", "New paragraph."].join(
      "\n",
    );
    // Lines (1-based): 1=heading, 3=untouched, 5=new
    render(<DiffPreviewMarkdown content={content} addedLines={new Set([5])} />);

    expect(screen.getByRole("heading", { name: /heading/i })).toBeInTheDocument();
    const newPara = screen.getByText(/new paragraph/i);
    const untouchedPara = screen.getByText(/untouched paragraph/i);

    expect(newPara).toHaveAttribute("data-diff-added", "true");
    expect(untouchedPara).not.toHaveAttribute("data-diff-added");
  });

  it("tags individual list items, not the surrounding list", () => {
    const content = ["- item one", "- item two", "- item three"].join("\n");
    const { container } = render(
      <DiffPreviewMarkdown content={content} addedLines={new Set([2])} />,
    );

    const list = container.querySelector("ul");
    const items = container.querySelectorAll("li");

    expect(list).not.toHaveAttribute("data-diff-added");
    expect(items).toHaveLength(3);
    expect(items[0]).not.toHaveAttribute("data-diff-added");
    expect(items[1]).toHaveAttribute("data-diff-added", "true");
    expect(items[2]).not.toHaveAttribute("data-diff-added");
  });

  it("tags code blocks that contain added lines", () => {
    const content = ["intro", "", "```sh", "mcode update", "```"].join("\n");
    const { container } = render(
      <DiffPreviewMarkdown content={content} addedLines={new Set([4])} />,
    );

    const pre = container.querySelector("pre");
    // The remark-diff-markers plugin tags the code node; react-markdown
    // renders <code> inside <pre>. The data attribute lands on the <code>.
    const code = pre?.querySelector("code");
    expect(code).toHaveAttribute("data-diff-added", "true");
  });

  it("renders without any data-diff-added markers when no lines were added", () => {
    const content = "Just an unchanged paragraph.";
    const { container } = render(
      <DiffPreviewMarkdown content={content} addedLines={new Set()} />,
    );
    expect(container.querySelector("[data-diff-added]")).toBeNull();
  });

  it("uses innermost-only selectors so nested marked blocks do not stack gutters", () => {
    const content = ["> **Superseded:** This plan used a Pinia auth store."].join("\n");
    const { container } = render(
      <DiffPreviewMarkdown content={content} addedLines={new Set([1])} />,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    const blockquote = container.querySelector("blockquote");
    const paragraph = container.querySelector("blockquote p");

    expect(blockquote).toHaveAttribute("data-diff-added", "true");
    expect(paragraph).toHaveAttribute("data-diff-added", "true");

    // Accent styles target innermost matches only — both container and child
    // carry the attribute, but CSS must not stack on the outer blockquote.
    expect(wrapper.className).toContain("[data-diff-added]:not(:has([data-diff-added]))");
  });
});
