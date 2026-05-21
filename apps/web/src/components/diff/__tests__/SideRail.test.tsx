import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SideRail } from "../SideRail";

describe("SideRail", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders Diff and Copy path for non-markdown files (no Preview)", () => {
    render(
      <SideRail
        filePath="src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show rendered preview/i })).toBeNull();
    expect(screen.getByRole("button", { name: /copy file path/i })).toBeInTheDocument();
  });

  it("renders Preview when isMarkdown is true", () => {
    render(
      <SideRail
        filePath="x.md"
        isMarkdown
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toBeInTheDocument();
  });

  it("marks Diff as pressed when not in preview, Preview when in preview", () => {
    const { rerender } = render(
      <SideRail filePath="x.md" isMarkdown previewMode={false} onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    rerender(
      <SideRail filePath="x.md" isMarkdown previewMode onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("calls onTogglePreview only when switching to a different mode", async () => {
    const onToggle = vi.fn();
    render(
      <SideRail filePath="x.md" isMarkdown previewMode={false} onTogglePreview={onToggle} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /show raw diff/i }));
    expect(onToggle).not.toHaveBeenCalled(); // already in diff mode
    await userEvent.click(screen.getByRole("button", { name: /show rendered preview/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Copy path writes the filePath to the clipboard", async () => {
    render(
      <SideRail
        filePath="apps/web/src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /copy file path/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("apps/web/src/x.ts");
  });
});
