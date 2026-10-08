import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ToolCallWrapper } from "../tool-renderers/ToolCallWrapper";
import { Terminal } from "lucide-react";
describe("ToolCallWrapper — border-l stripe removal", () => {
  it("does not use border-l when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).not.toContain("border-l");
  });

  it("does not use glow-primary when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).not.toContain("glow-primary");
  });

  it("uses bg-primary fill when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).toContain("bg-primary");
  });

  it("does not use border-l when inactive", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive={false} />,
    );
    expect(container.firstElementChild?.className).not.toContain("border-l");
  });
});
