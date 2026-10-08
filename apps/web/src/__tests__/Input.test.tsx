import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders the 40px default control height", () => {
    const { container } = render(<Input placeholder="test" />);
    expect(container.querySelector("input")!.className).toContain("h-control-default");
  });

  it("renders compact and comfortable on Paper's 32 and 48 scale", () => {
    const { container } = render(
      <>
        <Input size="compact" placeholder="compact" />
        <Input size="comfortable" placeholder="comfortable" />
      </>
    );
    const [compact, comfortable] = Array.from(container.querySelectorAll("input"));
    expect(compact.className).toContain("h-control-compact");
    expect(comfortable.className).toContain("h-control-comfortable");
  });

  it("lets a caller's height override the size", () => {
    const { container } = render(<Input size="compact" className="h-7 w-40" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-7");
    expect(input.className).not.toContain("h-control-compact");
    expect(input.className).toContain("w-40");
  });
});
