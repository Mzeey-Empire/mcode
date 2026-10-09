import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanelCaptionStrip } from "../CanvasHeader";
import { ShellChromeProvider } from "../shell-chrome-context";

function renderStrip(maximized: boolean, sidebarDocked: boolean) {
  return render(
    <ShellChromeProvider sidebarDocked={sidebarDocked} canGoBack canGoForward={false}>
      <PanelCaptionStrip maximized={maximized} />
    </ShellChromeProvider>,
  );
}

describe("PanelCaptionStrip", () => {
  it("takes over the sidebar and history controls when a maximized panel replaces the canvas", () => {
    renderStrip(true, false);

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["a docked panel", false, false],
    ["a maximized panel beside the docked sidebar", true, true],
  ])("stays an empty caption strip for %s", (_case, maximized, sidebarDocked) => {
    renderStrip(maximized, sidebarDocked);

    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
