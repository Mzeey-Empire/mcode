import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../dropdown-menu";
import { OverlayGateContext } from "../overlay-gate";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

function GatedMenu({ gateOpen }: { readonly gateOpen: boolean }) {
  return (
    <OverlayGateContext.Provider value={gateOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem label="Refresh" />
        </DropdownMenuContent>
      </DropdownMenu>
    </OverlayGateContext.Provider>
  );
}

function GatedPopover({ gateOpen }: { readonly gateOpen: boolean }) {
  return (
    <OverlayGateContext.Provider value={gateOpen}>
      <Popover open>
        <PopoverTrigger>Jump</PopoverTrigger>
        <PopoverContent>Jump to file</PopoverContent>
      </Popover>
    </OverlayGateContext.Provider>
  );
}

describe("OverlayGateContext", () => {
  it("closes an uncontrolled menu when the gate shuts and keeps it closed when the gate reopens", async () => {
    const { rerender } = render(<GatedMenu gateOpen />);
    await userEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();

    rerender(<GatedMenu gateOpen={false} />);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Refresh" })).not.toBeInTheDocument());

    rerender(<GatedMenu gateOpen />);
    expect(screen.queryByRole("menuitem", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("holds a controlled popover closed while the gate is shut", async () => {
    const { rerender } = render(<GatedPopover gateOpen={false} />);
    expect(screen.queryByText("Jump to file")).not.toBeInTheDocument();

    rerender(<GatedPopover gateOpen />);
    expect(await screen.findByText("Jump to file")).toBeInTheDocument();
  });
});
