import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyButton } from "../copy-button";

// The sr-only status span repeats the message, so the tooltip is told apart by its slot.
const TOOLTIP = "[data-slot='tooltip-content']";

describe("CopyButton", () => {
  it("keeps its Copied tooltip open after the click that copies", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<CopyButton text="/some/path" label="Copy path" />);

    await user.click(screen.getByRole("button", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("/some/path");
    expect(await screen.findByText("Copied", { selector: TOOLTIP })).toBeVisible();
  });

  it("tells the user when the copy fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<CopyButton text="/some/path" label="Copy path" />);

    await user.click(screen.getByRole("button", { name: "Copy path" }));

    expect(await screen.findByText("Copy failed. Try again.", { selector: TOOLTIP })).toBeVisible();
  });
});
