import { CircleAlert } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusMark } from "../status-mark";
import { statusGlyph } from "@/features/thread-attention/__tests__/status-glyph";

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

  it("draws a passed icon, but a running mark keeps its spinner", () => {
    render(<><StatusMark state="error" label="Failed" icon={CircleAlert} /><StatusMark state="running" label="Running" icon={CircleAlert} /></>);

    expect(statusGlyph(screen.getByRole("img", { name: "Failed" }))).toBe("circle-alert");
    expect(statusGlyph(screen.getByRole("img", { name: "Running" }))).toBe("spinner");
  });
});
