import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearIconCache } from "@/lib/vscode-icons";
import { ActionIcon } from "../ActionIcon";
import { ActionIconPicker } from "../ActionIconPicker";

beforeEach(() => {
  clearIconCache();
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue("blob:action-icon");
});

function cdnReturnsSvg() {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
  });
}

describe("ActionIcon", () => {
  it("swaps the tool's vscode icon in once the CDN answers, inside the same slot", async () => {
    cdnReturnsSvg();
    render(<ActionIcon command="bun run dev" size={14} />);

    const slot = screen.getByTestId("action-icon");
    expect(slot).toHaveStyle({ width: "14px", height: "14px" });
    await waitFor(() => expect(slot.querySelector("img")).toHaveAttribute("src", "blob:action-icon"));
    expect(slot).toHaveAttribute("data-icon-id", "bun");
    expect(slot).toHaveStyle({ width: "14px", height: "14px" });
  });

  it("keeps the Lucide glyph in the fixed slot when offline", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    render(<ActionIcon command="bun run dev" size={16} />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const slot = screen.getByTestId("action-icon");
    await waitFor(() => expect(slot.querySelector("svg")).not.toBeNull());
    expect(slot.querySelector("img")).toBeNull();
    expect(slot).toHaveStyle({ width: "16px", height: "16px" });
  });

  it("draws the derived default for an id this build does not know", () => {
    cdnReturnsSvg();
    render(<ActionIcon iconId="from-a-newer-build" command="cargo test" />);

    expect(screen.getByTestId("action-icon")).toHaveAttribute("data-icon-id", "rust");
  });

  it("does not show the previous tool's image after the command changes tools", async () => {
    cdnReturnsSvg();
    const { rerender } = render(<ActionIcon command="bun run dev" />);
    await waitFor(() => expect(screen.getByTestId("action-icon").querySelector("img")).not.toBeNull());

    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined));
    rerender(<ActionIcon command="cargo test" />);

    expect(screen.getByTestId("action-icon")).toHaveAttribute("data-icon-id", "rust");
    expect(screen.getByTestId("action-icon").querySelector("img")).toBeNull();
  });

  it("draws general glyphs without a network request", () => {
    globalThis.fetch = vi.fn();
    render(<ActionIcon iconId="rocket" command="bun run dev" />);

    expect(screen.getByTestId("action-icon")).toHaveAttribute("data-icon-id", "rocket");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("ActionIconPicker", () => {
  it("lists Tools then General and reports the chosen id", async () => {
    cdnReturnsSvg();
    const onChange = vi.fn();
    render(<ActionIconPicker value={undefined} command="bun run dev" onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Action icon" }));
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Tools", "General"]);

    await userEvent.click(screen.getByRole("button", { name: "Rocket" }));
    expect(onChange).toHaveBeenCalledWith("rocket");
    expect(screen.queryByRole("heading", { name: "Tools" })).not.toBeInTheDocument();
  });

  it("fills the icon in use and clears an explicit choice when it is chosen again", async () => {
    cdnReturnsSvg();
    const onChange = vi.fn();
    render(<ActionIconPicker value="rocket" command="bun run dev" onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Action icon" }));
    expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bun" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Rocket" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("fills the derived icon for an automatic action and stores it when chosen", async () => {
    cdnReturnsSvg();
    const onChange = vi.fn();
    render(<ActionIconPicker value="from-a-newer-build" command="cargo test" onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Action icon" }));
    expect(screen.getByRole("button", { name: "Rust" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Rust" }));
    expect(onChange).toHaveBeenCalledWith("rust");
  });
});
