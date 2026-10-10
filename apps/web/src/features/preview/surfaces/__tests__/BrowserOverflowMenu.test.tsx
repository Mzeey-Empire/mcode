import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelHeaderSlotScope } from "@/components/panels/shell/PanelHeader";
import { BrowserOverflowMenu } from "../BrowserOverflowMenu";

function menu(active: boolean, elements: { leading: HTMLElement; row2: HTMLElement }) {
  return (
    <PanelHeaderSlotScope active={active} elements={elements}>
      <BrowserOverflowMenu
        hasLoadedPage
        onNewPage={vi.fn()}
        onForceReload={vi.fn()}
        onDumpContent={vi.fn()}
        onRegionCapture={vi.fn()}
        onClearCookies={vi.fn()}
        onClearCache={vi.fn()}
        onGetZoom={vi.fn(async () => 1)}
        onSetZoom={vi.fn(async (factor: number) => factor)}
        onOpenDevTools={vi.fn()}
      />
    </PanelHeaderSlotScope>
  );
}

describe("BrowserOverflowMenu in the panel shell", () => {
  it("closes when another tool takes the panel header and stays closed on return", async () => {
    const elements = { leading: document.createElement("div"), row2: document.createElement("div") };
    const { rerender } = render(menu(true, elements));
    fireEvent.click(screen.getByRole("button", { name: "More browser tools" }));
    expect(await screen.findByRole("menuitem", { name: /New page/ })).toBeInTheDocument();

    rerender(menu(false, elements));
    expect(screen.queryByRole("menuitem", { name: /New page/ })).not.toBeInTheDocument();

    rerender(menu(true, elements));
    expect(screen.queryByRole("menuitem", { name: /New page/ })).not.toBeInTheDocument();
  });
});
