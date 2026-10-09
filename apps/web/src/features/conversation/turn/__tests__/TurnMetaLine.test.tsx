import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TurnMetaLine, turnMetaLabel } from "../TurnMetaLine";

afterEach(cleanup);

describe("turnMetaLabel", () => {
  it.each([
    [{ steps: 7, subagents: 1 }, "7 steps · 1 sub-agent"],
    [{ steps: 1, subagents: 0 }, "1 step"],
    [{ steps: 3, subagents: 2 }, "3 steps · 2 sub-agents"],
    [{ steps: 0, subagents: 0 }, ""],
  ])("formats %o as %s", (counts, label) => {
    expect(turnMetaLabel(counts)).toBe(label);
  });
});

describe("TurnMetaLine", () => {
  it("shows only the counts", () => {
    const { getByTestId } = render(<TurnMetaLine steps={4} subagents={1} />);
    expect(getByTestId("turn-meta-line").textContent).toBe("4 steps · 1 sub-agent");
  });

  it("renders nothing for a turn with no steps", () => {
    const { container } = render(<TurnMetaLine steps={0} subagents={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
