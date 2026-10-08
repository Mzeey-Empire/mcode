import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("reports a mixed value to assistive tech", () => {
    render(<Checkbox checked="mixed" aria-label="src" />);
    expect(screen.getByRole("checkbox", { name: "src" })).toHaveAttribute("aria-checked", "mixed");
  });

  it("asks to check every child when a mixed row is toggled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox checked="mixed" aria-label="src" onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("checkbox", { name: "src" }));

    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("keeps plain checked and unchecked values", () => {
    render(
      <>
        <Checkbox checked aria-label="on" />
        <Checkbox checked={false} aria-label="off" />
      </>,
    );
    expect(screen.getByRole("checkbox", { name: "on" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "off" })).toHaveAttribute("aria-checked", "false");
  });
});
