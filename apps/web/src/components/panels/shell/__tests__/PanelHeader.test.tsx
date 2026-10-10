import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShellChromeProvider } from "@/components/shell/shell-chrome-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { PanelHeader, PanelHeaderSlot, PanelHeaderSlotScope } from "../PanelHeader";

function renderHeader(maximized: boolean, sidebarDocked: boolean) {
  return render(
    <ShellChromeProvider sidebarDocked={sidebarDocked} canGoBack canGoForward={false}>
      <PanelHeader
        maximized={maximized}
        leadingRef={null}
        row2Ref={null}
        onToggleMaximized={vi.fn()}
        onTogglePanel={vi.fn()}
      />
    </ShellChromeProvider>,
  );
}

function buttonNames(): string[] {
  return screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
}

describe("PanelHeader", () => {
  it("takes over the sidebar and history controls when a maximized panel replaces the canvas", () => {
    renderHeader(true, false);

    expect(buttonNames()).toEqual(["Expand sidebar", "Back", "Forward", "Restore", "Close panel"]);
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it.each([
    ["a docked panel", false, false, "Expand"],
    ["a maximized panel beside the docked sidebar", true, true, "Restore"],
  ])("keeps only the panel controls for %s", (_case, maximized, sidebarDocked, expandLabel) => {
    renderHeader(maximized, sidebarDocked);

    expect(buttonNames()).toEqual([expandLabel, "Close panel"]);
  });
});

describe("PanelHeaderSlot", () => {
  function renderSlot(active: boolean) {
    const leading = document.createElement("div");
    const row2 = document.createElement("div");
    render(
      <PanelHeaderSlotScope active={active} elements={{ leading, row2 }}>
        <PanelHeaderSlot slot="leading">title</PanelHeaderSlot>
        <PanelHeaderSlot slot="row2">controls</PanelHeaderSlot>
      </PanelHeaderSlotScope>,
    );
    return { leading, row2 };
  }

  it("portals an active tool's header into the shell rows", () => {
    const { leading, row2 } = renderSlot(true);

    expect(leading).toHaveTextContent("title");
    expect(row2).toHaveTextContent("controls");
  });

  it("renders nothing for a mounted but inactive tool", () => {
    const { leading, row2 } = renderSlot(false);

    expect(leading).toBeEmptyDOMElement();
    expect(row2).toBeEmptyDOMElement();
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("keeps a tool's header state while another tool owns the shell", () => {
    const leading = document.createElement("div");
    const row2 = document.createElement("div");
    const header = (active: boolean) => (
      <PanelHeaderSlotScope active={active} elements={{ leading, row2 }}>
        <PanelHeaderSlot slot="row2">
          <input aria-label="Address" />
        </PanelHeaderSlot>
      </PanelHeaderSlotScope>
    );
    const { rerender } = render(header(true));
    document.body.append(leading, row2);
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "localhost:5173" } });

    rerender(header(false));
    expect(row2).toBeEmptyDOMElement();
    rerender(header(true));

    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("localhost:5173");
    leading.remove();
    row2.remove();
  });

  it("leaves a row empty when the active tool puts nothing in it", () => {
    const leading = document.createElement("div");
    const row2 = document.createElement("div");
    render(
      <PanelHeaderSlotScope active elements={{ leading, row2 }}>
        <PanelHeaderSlot slot="leading">title</PanelHeaderSlot>
      </PanelHeaderSlotScope>,
    );

    expect(leading).toHaveTextContent("title");
    expect(row2).toBeEmptyDOMElement();
  });

  it("stays inline outside the panel shell", () => {
    render(<PanelHeaderSlot slot="row2">controls</PanelHeaderSlot>);

    expect(screen.getByText("controls")).toBeInTheDocument();
  });
});

describe("PanelHeaderSlotScope inside a closed panel", () => {
  function ScopedMenu({ panelVisible, row2 }: { readonly panelVisible: boolean; readonly row2: HTMLElement }) {
    return (
      <OverlayGateContext.Provider value={panelVisible}>
        <PanelHeaderSlotScope active elements={{ leading: null, row2 }}>
          <PanelHeaderSlot slot="row2">
            <DropdownMenu>
              <DropdownMenuTrigger>Review options</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem label="Refresh" />
              </DropdownMenuContent>
            </DropdownMenu>
          </PanelHeaderSlot>
        </PanelHeaderSlotScope>
      </OverlayGateContext.Provider>
    );
  }

  it("detaches the active tool's row and closes its menus when the panel closes", async () => {
    const row2 = document.body.appendChild(document.createElement("div"));
    const { rerender } = render(<ScopedMenu panelVisible row2={row2} />);
    await userEvent.click(screen.getByRole("button", { name: "Review options" }));
    expect(await screen.findByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();

    rerender(<ScopedMenu panelVisible={false} row2={row2} />);

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Refresh" })).not.toBeInTheDocument());
    expect(row2).toBeEmptyDOMElement();
    row2.remove();
  });
});
