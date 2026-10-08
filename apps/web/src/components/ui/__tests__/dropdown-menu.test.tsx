import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pencil, Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";

const UNAVAILABLE = "No commits on this branch yet";

function ReviewMenu({ onPick }: { onPick: (name: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Review view</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem label="Rename" icon={<Pencil />} shortcut="F2" onClick={() => onPick("rename")} />
        <DropdownMenuItem label="Last turn" checked onClick={() => onPick("last")} />
        <DropdownMenuItem label="All turns" checked={false} onClick={() => onPick("all")} />
        <DropdownMenuItem label="Commit" disabledReason={UNAVAILABLE} onClick={() => onPick("commit")} />
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Delete" icon={<Trash2 />} destructive onClick={() => onPick("delete")} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function openMenu() {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<ReviewMenu onPick={onPick} />);
  await user.click(screen.getByRole("button", { name: "Review view" }));
  await screen.findByRole("menu");
  return { user, onPick };
}

describe("DropdownMenuItem", () => {
  it("draws 40px rows that fill on highlight, never with the selected fill", async () => {
    await openMenu();
    const row = screen.getByRole("menuitem", { name: "Rename" });
    expect(row.className).toContain("h-row-default");
    expect(row.className).toContain("data-highlighted:bg-hover");
    expect(row.className).not.toMatch(/bg-selected|bg-accent/);
  });

  it("marks the checked row as the current radio choice with a check, not a fill", async () => {
    await openMenu();
    const current = screen.getByRole("menuitemradio", { name: "Last turn" });
    const other = screen.getByRole("menuitemradio", { name: "All turns" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(other).toHaveAttribute("aria-checked", "false");
    expect(current.querySelector("svg")).not.toBeNull();
    expect(other.querySelector("svg")).toBeNull();
    expect(current.className).not.toMatch(/bg-selected/);
  });

  it("keeps a disabled row focusable, uninvocable, and described by its reason", async () => {
    const { user, onPick } = await openMenu();
    const commit = screen.getByRole("menuitem", { name: "Commit" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription(UNAVAILABLE);

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(commit).toHaveFocus());
    await user.keyboard("{Enter}");
    await user.click(commit);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("shows the reason in a tooltip when the disabled row is hovered", async () => {
    const { user } = await openMenu();
    await user.hover(screen.getByRole("menuitem", { name: "Commit" }));
    await waitFor(() => expect(screen.getAllByText(UNAVAILABLE).some((node) => !node.hidden)).toBe(true));
  });

  it("invokes an enabled row and closes", async () => {
    const { user, onPick } = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onPick).toHaveBeenCalledWith("delete");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user } = await openMenu();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Review view" })).toHaveFocus();
  });
});
