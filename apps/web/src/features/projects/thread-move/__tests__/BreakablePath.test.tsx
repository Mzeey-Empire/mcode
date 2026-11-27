import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BreakablePath } from "../BreakablePath";

function wrapPieces(path: string): string[] {
  const { container } = render(<BreakablePath path={path} />);
  return Array.from(container.querySelectorAll("span > span"), (piece) => piece.textContent ?? "");
}

describe("BreakablePath", () => {
  it.each([
    ["a Windows path with forward slashes", "F:/dev/worktrees/mcode-2242/.dev", ["F:/", "dev/", "worktrees/", "mcode-2242/", ".dev"]],
    ["a Windows path with backslashes", "D:\\work\\new-projects\\notes", ["D:\\", "work\\", "new-projects\\", "notes"]],
    ["a POSIX path", "/home/cj/src", ["/", "home/", "cj/", "src"]],
  ])("offers a wrap point only after a separator in %s, and never inside a name", (_case, path, pieces) => {
    expect(wrapPieces(path)).toEqual(pieces);
  });

  it("keeps the path's text whole for copying", () => {
    const path = "F:/dev/worktrees/mcode-2242/.dev/new-projects/gitfail-08";
    const { container } = render(<BreakablePath path={path} />);

    expect(container.textContent).toBe(path);
  });
});
