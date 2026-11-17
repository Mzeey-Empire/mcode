import { CircleAlert } from "lucide-react";
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

  it("draws a passed icon in the state's colour, but a running mark keeps its spinner", () => {
    render(<><StatusMark state="error" label="Failed" icon={CircleAlert} /><StatusMark state="running" label="Running" icon={CircleAlert} /></>);

    expect(screen.getByRole("img", { name: "Failed" }).querySelector("svg")).toHaveClass("text-error");
    expect(screen.getByRole("img", { name: "Running" }).querySelector("svg")).toBeNull();
  });
});
