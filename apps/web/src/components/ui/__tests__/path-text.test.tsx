import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PathText } from "../path-text";

function visibleParts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[aria-hidden]")].map((part) => part.textContent ?? "");
}

describe("PathText", () => {
  it("renders the file name before its folder", () => {
    const { container } = render(<PathText path="/Users/cj/src/mcode/README.md" />);

    expect(visibleParts(container)).toEqual(["README.md", "/Users/cj/src/mcode"]);
  });

  it("collapses the home directory in the folder", () => {
    const { container } = render(<PathText path="/Users/cj/src/mcode" home="/Users/cj" />);

    expect(visibleParts(container)).toEqual(["mcode", "~/src"]);
  });

  it("splits Windows paths and collapses a Windows home", () => {
    const { container } = render(
      <PathText path={"C:\\Users\\cj\\worktrees\\feature-a"} home={"C:\\Users\\cj"} />,
    );

    expect(visibleParts(container)).toEqual(["feature-a", "~\\worktrees"]);
  });

  it("keeps the root separator as the folder of a top-level path", () => {
    const { container } = render(<PathText path="/opt" />);

    expect(visibleParts(container)).toEqual(["opt", "/"]);
  });

  it("shows only the name when the path is the home directory", () => {
    const { container } = render(<PathText path="/Users/cj" home="/Users/cj" />);

    expect(visibleParts(container)).toEqual(["~"]);
  });

  it("fades the folder and keeps the name in ink", () => {
    const { container } = render(<PathText path="/Users/cj/src/mcode" />);
    const [name, folder] = container.querySelectorAll("[aria-hidden]");

    expect(name).toHaveClass("text-ink");
    expect(folder).toHaveClass("text-fade", "text-muted");
  });

  it("keeps the full path in the accessible text and the tooltip", async () => {
    const user = userEvent.setup();
    render(<PathText path="/Users/cj/src/mcode" home="/Users/cj" />);
    const fullPath = screen.getByText("/Users/cj/src/mcode");

    expect(fullPath).toHaveClass("sr-only");
    await user.hover(fullPath);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("/Users/cj/src/mcode");
    });
  });
});
