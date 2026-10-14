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
        <DropdownMenuItem label="Rename" icon={<Pencil />} shortcut={["F2"]} onClick={() => onPick("rename")} />
        <DropdownMenuItem label="Turn" checked onClick={() => onPick("turn")} />
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
  it("marks the checked row as the current radio choice with a check", async () => {
    await openMenu();
    const current = screen.getByRole("menuitemradio", { name: "Turn" });
    const other = screen.getByRole("menuitemradio", { name: "All turns" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(other).toHaveAttribute("aria-checked", "false");
    expect(current.querySelector("svg")).not.toBeNull();
    expect(other.querySelector("svg")).toBeNull();
  });

  it("keeps a checked row's trailing detail beside the check", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Device</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem label="iPhone 15 Pro" checked trailing="393 × 852" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Device" }));
    const row = await screen.findByRole("menuitemradio", { name: /^iPhone 15 Pro/ });
    expect(row).toHaveTextContent("393 × 852");
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("shows each shortcut key as its own keycap, hidden from the row's name", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Plan</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem label="Implement v1" shortcut={["Ctrl", "Shift", "Enter"]} />
          <DropdownMenuItem label="Implement in a new thread" shortcut={[]} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Plan" }));
    const bound = await screen.findByRole("menuitem", { name: "Implement v1" });
    const unbound = screen.getByRole("menuitem", { name: "Implement in a new thread" });
    expect([...bound.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["Ctrl", "Shift", "Enter"]);
    expect(unbound.querySelectorAll("kbd")).toHaveLength(0);
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
