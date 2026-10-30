import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { WorkFold, workFoldLabel } from "../WorkFold";

afterEach(cleanup);

describe("workFoldLabel", () => {
  it.each([
    ["completed", "Worked for 1m 42s"],
    ["cancelled", "Stopped after 1m 42s"],
    ["interrupted", "Interrupted after 1m 42s"],
    ["errored", "Failed after 1m 42s"],
    [undefined, "Worked for 1m 42s"],
  ] as const)("names a %s turn by how it ended", (outcome, label) => {
    expect(workFoldLabel(outcome, 102_000)).toBe(label);
  });

  it.each([
    ["cancelled", "Stopped"],
    ["interrupted", "Interrupted"],
    ["errored", "Failed"],
    ["completed", "Worked"],
  ] as const)("retains the %s outcome when wall time is unknown", (outcome, label) => {
    expect(workFoldLabel(outcome, null)).toBe(label);
    expect(workFoldLabel(outcome, -1)).toBe(label);
  });

  it("rounds a sub-second turn up to one second", () => {
    expect(workFoldLabel("completed", 300)).toBe("Worked for 1s");
  });
});

describe("WorkFold", () => {
  it("reports its open state and toggles on click", () => {
    const onToggle = vi.fn();
    const { getByRole, rerender } = render(<WorkFold label="Worked for 3s" expanded={false} onToggle={onToggle} />);

    const button = getByRole("button", { name: "Worked for 3s" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<WorkFold label="Worked for 3s" expanded onToggle={onToggle} />);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
});
