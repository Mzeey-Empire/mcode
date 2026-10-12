import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("lets a caller's height override the size", () => {
    const { container } = render(<Input size="compact" className="h-7 w-40" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-7");
    expect(input.className).not.toContain("h-control-compact");
    expect(input.className).toContain("w-40");
  });
});
