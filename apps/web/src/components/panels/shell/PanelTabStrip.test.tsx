import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelTabStrip, type PanelTabStripItem } from "./PanelTabStrip";

const ITEMS: readonly PanelTabStripItem[] = [
  { id: "a", label: "Terminal", icon: null },
  { id: "b", label: "Terminal (2)", icon: null },
  { id: "c", label: "Terminal (3)", icon: null },
];

/**
 * jsdom has no layout, so the strip gets a fixed width and the active tab a fixed width. Every other box reads 0,
 * which the strip treats as absent, so only the 9.6rem inactive-tab floor decides how many tabs fit.
 */
function stubLayout({ stripWidth, activeTabWidth = 120 }: { stripWidth: number; activeTabWidth?: number }) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(stripWidth);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.active === "true" ? activeTabWidth : 0;
  });
}

const FIVE: readonly PanelTabStripItem[] = ["1", "2", "3", "4", "5"].map((n) => ({ id: n, label: `${n} · pwsh`, icon: null }));

function FiveTabs({ activeId, onSelect = () => {} }: { readonly activeId: string; readonly onSelect?: (id: string) => void }) {
  return (
    <PanelTabStrip items={FIVE} activeId={activeId} label="Terminals" addLabel="New terminal" onSelect={onSelect} onClose={() => {}} onAdd={() => {}} />
  );
}

const shownTabs = () => within(screen.getByRole("tablist", { name: "Terminals" })).getAllByRole("tab").map((tab) => tab.textContent);

function renderStrip({
  onSelect = () => {},
  onClose = () => {},
}: {
  readonly onSelect?: (id: string) => void;
  readonly onClose?: (id: string) => void;
} = {}) {
  return render(
    <PanelTabStrip
      items={ITEMS}
      activeId="a"
      label="Terminals"
      addLabel="New terminal"
      onSelect={onSelect}
      onClose={onClose}
      onAdd={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PanelTabStrip overflow", () => {
  it("shows every tab and no overflow menu while all fit at their minimum width", () => {
    stubLayout({ stripWidth: 600 });
    renderStrip();
    expect(shownTabs()).toEqual(["Terminal", "Terminal (2)", "Terminal (3)"]);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
  });

  it("shows only whole tabs around the active one and counts the rest on the menu button", async () => {
    stubLayout({ stripWidth: 330 });
    const onSelect = vi.fn();
    render(<FiveTabs activeId="5" onSelect={onSelect} />);

    expect(shownTabs()).toEqual(["4 · pwsh", "5 · pwsh"]);
    await userEvent.click(screen.getByRole("button", { name: "All terminals, 3 more" }));
    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["1 · pwsh", "2 · pwsh", "3 · pwsh", "4 · pwsh", "5 · pwsh"]);
    expect(rows[4]).toHaveAttribute("aria-checked", "true");

    await userEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("holds the shown tabs still while the active tab stays among them, and moves just enough to show a hidden one", () => {
    stubLayout({ stripWidth: 330 });
    const { rerender } = render(<FiveTabs activeId="5" />);
    rerender(<FiveTabs activeId="4" />);
    expect(shownTabs()).toEqual(["4 · pwsh", "5 · pwsh"]);
    rerender(<FiveTabs activeId="2" />);
    expect(shownTabs()).toEqual(["2 · pwsh", "3 · pwsh"]);
  });
});

describe("PanelTabStrip tabs", () => {
  it("selects and closes tabs", () => {
    const events: string[] = [];
    renderStrip({
      onSelect: (id) => events.push(`select:${id}`),
      onClose: (id) => events.push(`close:${id}`),
    });

    fireEvent.click(screen.getByRole("tab", { name: "Terminal (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal (3)" }));

    expect(events).toEqual(["select:b", "close:c"]);
  });

  it("announces a tablist whose active tab is selected and is the only tab stop", () => {
    renderStrip();
    const tabs = within(screen.getByRole("tablist", { name: "Terminals" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
  });

  it("points every tab at the content panel when one is given", () => {
    render(
      <PanelTabStrip
        items={ITEMS}
        activeId="a"
        label="Terminals"
        addLabel="New terminal"
        panelId="terminal-body"
        onSelect={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    for (const tab of screen.getAllByRole("tab")) expect(tab).toHaveAttribute("aria-controls", "terminal-body");
  });

  it("moves focus with the arrows, Home, and End without selecting", async () => {
    const onSelect = vi.fn();
    renderStrip({ onSelect });
    const tab = (name: string) => screen.getByRole("tab", { name });
    tab("Terminal").focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(tab("Terminal (2)")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(tab("Terminal (3)")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(tab("Terminal")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(tab("Terminal (3)")).toHaveFocus();

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects the focused tab on Enter", async () => {
    const onSelect = vi.fn();
    renderStrip({ onSelect });
    screen.getByRole("tab", { name: "Terminal" }).focus();

    await userEvent.keyboard("{ArrowRight}{Enter}");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("closes the focused tab on Delete and keeps focus in the strip", async () => {
    const closed: string[] = [];
    function Strip() {
      const [items, setItems] = useState(ITEMS);
      return (
        <PanelTabStrip
          items={items}
          activeId="a"
          label="Terminals"
          addLabel="New terminal"
          onSelect={() => {}}
          onClose={(id) => {
            closed.push(id);
            setItems((current) => current.filter((item) => item.id !== id));
          }}
          onAdd={() => {}}
        />
      );
    }
    render(<Strip />);
    screen.getByRole("tab", { name: "Terminal" }).focus();

    await userEvent.keyboard("{ArrowRight}{Delete}");

    expect(closed).toEqual(["b"]);
    expect(screen.queryByRole("tab", { name: "Terminal (2)" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
  });

  it("says in a tooltip what each tab's close button does, per tab", async () => {
    render(
      <PanelTabStrip
        items={[ITEMS[0]!, { ...ITEMS[1]!, closeTooltip: "End shell" }]}
        activeId="a"
        label="Terminals"
        addLabel="New terminal"
        onSelect={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    const shownTooltip = (text: string) => screen.queryAllByText(text).some((node) => node.closest('[data-slot="tooltip-content"]'));

    await userEvent.hover(screen.getByRole("button", { name: "Close Terminal" }));
    await waitFor(() => expect(shownTooltip("Close tab")).toBe(true));
    // Both buttons share one tooltip, so moving to the next tab must swap its text.
    await userEvent.hover(screen.getByRole("button", { name: "Close Terminal (2)" }));
    await waitFor(() => expect(shownTooltip("End shell")).toBe(true));
  });

  it("keeps each close button outside its tab and out of the tab order", () => {
    renderStrip();
    for (const tab of screen.getAllByRole("tab")) {
      expect(within(tab).queryByRole("button")).toBeNull();
      const close = screen.getByRole("button", { name: `Close ${tab.textContent}` });
      expect(close.tabIndex).toBe(-1);
    }
  });
});
