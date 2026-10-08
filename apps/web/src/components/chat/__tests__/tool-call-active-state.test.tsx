import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ToolCallWrapper } from "../tool-renderers/ToolCallWrapper";
import { FileText } from "lucide-react";
describe("ToolCallWrapper active state", () => {
  it("does not use animate-shimmer-text when active", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("applies text-foreground and font-medium to the label when active", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive />);
    const label = screen.getByText("Reading file");
    expect(label.className).toContain("text-foreground");
    expect(label.className).toContain("font-medium");
  });

  it("applies text-foreground/70 to the label when inactive", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive={false} />);
    const label = screen.getByText("Reading file");
    expect(label.className).toContain("text-foreground/70");
  });
});
