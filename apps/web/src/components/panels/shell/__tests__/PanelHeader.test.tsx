import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellChromeProvider } from "@/components/shell/shell-chrome-context";
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

  it("stays inline outside the panel shell", () => {
    render(<PanelHeaderSlot slot="row2">controls</PanelHeaderSlot>);

    expect(screen.getByText("controls")).toBeInTheDocument();
  });
});
