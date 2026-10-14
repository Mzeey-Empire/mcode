import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ToolCallWrapper } from "../tool-renderers/ToolCallWrapper";
import { FileText } from "lucide-react";
describe("ToolCallWrapper active state", () => {
  it("replaces the tool icon with a spinner while active", () => {
    const { container } = render(<ToolCallWrapper icon={FileText} label="Reading file" isActive />);
    expect(screen.getByText("Reading file")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-text")).toBeNull();
  });

  it("shows the tool icon when inactive", () => {
    const { container } = render(<ToolCallWrapper icon={FileText} label="Reading file" isActive={false} />);
    expect(screen.getByText("Reading file")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-text")).toBeInTheDocument();
  });
});
