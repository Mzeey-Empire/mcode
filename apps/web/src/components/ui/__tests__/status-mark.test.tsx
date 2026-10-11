import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusMark } from "../status-mark";

describe("StatusMark", () => {
  it.each([
    ["running", "Running"],
    ["attention", "Approval required"],
    ["success", "Finished"],
    ["error", "Failed"],
    ["info", "Info"],
  ] as const)("names the %s mark with its label", (state, label) => {
    render(<StatusMark state={state} label={label} />);

    const mark = screen.getByRole("img", { name: label });
    expect(mark).toHaveAttribute("data-status-mark", state);
    expect(mark).not.toHaveTextContent(/./);
  });
});
