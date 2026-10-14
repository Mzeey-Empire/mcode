import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelHeaderSlotScope } from "@/components/panels/shell/PanelHeader";
import { TooltipProvider } from "@/components/ui/tooltip";
import defaultKeybindings from "@/config/default-keybindings.json";
import { clearKeybindings, loadKeybindings } from "@/lib/keybinding-manager";
import { useToastStore } from "@/stores/toastStore";
import { BrowserToolbar, type BrowserToolbarProps } from "../BrowserToolbar";
import type {
  BrowserAction,
  BrowserAddress,
  BrowserNavigation,
  BrowserTakeover,
  BrowserTools,
} from "../browserToolbarModel";

const URL = "https://example.test/checkout";

function enabled(log: string[], name: string): BrowserAction {
  return { kind: "enabled", run: () => log.push(name) };
}

function navigation(log: string[], overrides: Partial<BrowserNavigation> = {}): BrowserNavigation {
  return { back: enabled(log, "back"), forward: enabled(log, "forward"), reload: enabled(log, "reload"), ...overrides };
}

function tools(log: string[], overrides: Partial<BrowserTools> = {}): BrowserTools {
  return {
    deviceToolbar: enabled(log, "device"),
    developerTools: enabled(log, "devtools"),
    forceReload: enabled(log, "force-reload"),
    zoom: { kind: "enabled", read: async () => 1, set: async (factor) => factor },
    clearCookies: enabled(log, "cookies"),
    clearCache: enabled(log, "cache"),
    takeover: { kind: "none" },
    ...overrides,
  };
}

function address(log: string[], overrides: Partial<BrowserAddress> = {}): BrowserAddress {
  return {
    url: URL,
    onNavigate: (input) => log.push(`navigate:${input}`),
    openExternal: enabled(log, "external"),
    onHumanFocus: () => log.push("focus"),
    ...overrides,
  };
}

function loadedProps(log: string[], overrides: Partial<BrowserToolbarProps> = {}): BrowserToolbarProps {
  return {
    page: {
      kind: "loaded",
      navigation: navigation(log),
      pageActions: {
        kind: "desktop",
        designActive: false,
        design: enabled(log, "design"),
        screenshotArmed: false,
        screenshot: enabled(log, "screenshot"),
      },
    },
    address: address(log),
    tools: tools(log),
    ...overrides,
  };
}

function renderToolbar(props: BrowserToolbarProps) {
  return render(<TooltipProvider><BrowserToolbar {...props} /></TooltipProvider>);
}

function buttonNames(): string[] {
  return screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
}

async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More" }));
  return screen.findByRole("menu");
}

describe("BrowserToolbar", () => {
  beforeEach(() => {
    clearKeybindings();
    loadKeybindings(defaultKeybindings);
  });

  afterEach(() => {
    clearKeybindings();
  });

  it("offers only the address and More on a new page", () => {
    const log: string[] = [];
    renderToolbar({ page: { kind: "new" }, address: address(log, { url: "" }), tools: tools(log) });

    expect(buttonNames()).toEqual(["More"]);
    expect(screen.getByRole("textbox", { name: "Preview URL" })).toHaveAttribute("placeholder", "Search or enter URL");
  });

  it("keeps navigation on an errored page but drops the page tools", () => {
    const log: string[] = [];
    renderToolbar({ page: { kind: "error", navigation: navigation(log) }, address: address(log), tools: tools(log) });

    expect(buttonNames()).toEqual(["Back", "Forward", "Reload", "Open in browser", "More"]);
  });

  it("shows page tools on a loaded page and explains each disabled control", async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    renderToolbar(loadedProps(log, {
      page: {
        kind: "loaded",
        navigation: navigation(log, { back: { kind: "disabled", reason: "No earlier page" } }),
        pageActions: {
          kind: "desktop",
          designActive: true,
          design: enabled(log, "design"),
          screenshotArmed: false,
          screenshot: { kind: "disabled", reason: "Finish picking an element first" },
        },
      },
    }));

    expect(buttonNames()).toEqual(["Back", "Forward", "Reload", "Open in browser", "Design", "Screenshot", "More"]);
    const back = screen.getByRole("button", { name: "Back" });
    const screenshot = screen.getByRole("button", { name: "Screenshot" });
    expect(back).toHaveAttribute("aria-disabled", "true");
    expect(back).toHaveAccessibleDescription("No earlier page");
    expect(screenshot).toHaveAccessibleDescription("Finish picking an element first");
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "true");

    await user.click(back);
    await user.click(screenshot);
    await user.click(screen.getByRole("button", { name: "Design" }));
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(log).toEqual(["design", "reload"]);
  });

  it("shows the Screenshot as pressed while it is armed", () => {
    const log: string[] = [];
    renderToolbar(loadedProps(log, {
      page: {
        kind: "loaded",
        navigation: navigation(log),
        pageActions: {
          kind: "desktop",
          designActive: false,
          design: enabled(log, "design"),
          screenshotArmed: true,
          screenshot: enabled(log, "screenshot"),
        },
      },
    }));

    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a rejected address editable until the page URL actually changes", async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    const props = loadedProps(log);
    const { rerender } = renderToolbar(props);
    const input = screen.getByRole("textbox", { name: "Preview URL" });

    await user.clear(input);
    await user.type(input, "localhost:9999{Enter}");
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(input).toHaveValue("localhost:9999");

    rerender(
      <TooltipProvider>
        <BrowserToolbar {...props} address={address(log, { url: "https://example.test/next" })} />
      </TooltipProvider>,
    );
    expect(input).toHaveValue("https://example.test/next");
    expect(log).toEqual(["focus", "navigate:localhost:9999", "reload"]);
  });

  it("does not render a browser-local automation controller badge", () => {
    renderToolbar(loadedProps([], { tools: tools([], { takeover: { kind: "agent", busy: true, takeControl: vi.fn() } }) }));

    expect(screen.queryByTestId("browser-controller-badge")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop browser automation" })).not.toBeInTheDocument();
  });

  it.each<[string, BrowserTakeover["kind"], boolean]>([
    ["busy", "agent", true],
    ["idle", "agent", false],
  ])("takes control from a %s agent through More", async (_state, _kind, busy) => {
    const user = userEvent.setup();
    const takeControl = vi.fn();
    renderToolbar(loadedProps([], { tools: tools([], { takeover: { kind: "agent", busy, takeControl } }) }));

    const menu = await openMore(user);
    const row = within(menu).getByRole("menuitem", { name: "Take control" });
    expect(row.getAttribute("title")).toBe(busy ? "Stop the active operation and take control" : null);
    await user.click(row);

    expect(takeControl).toHaveBeenCalledOnce();
  });

  it("has no Take control row while the human controls the page", async () => {
    const user = userEvent.setup();
    renderToolbar(loadedProps([]));

    const menu = await openMore(user);

    expect(within(menu).getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "Device toolbarCtrl+Shift+M",
      "Developer toolsF12",
      "Force reloadCtrl+Shift+R",
      "Clear cookies",
      "Clear cache",
    ]);
  });

  it("opens developer tools from More", async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    renderToolbar(loadedProps(log));

    const menu = await openMore(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Developer tools" }));

    expect(log).toEqual(["devtools"]);
  });

  it("shows the user's own shortcut and none for an unbound command", async () => {
    clearKeybindings();
    loadKeybindings(defaultKeybindings, [
      { key: "mod+alt+i", command: "preview.guestDevTools.open" },
      { key: "", command: "-preview.forceReload" },
    ]);
    const user = userEvent.setup();
    renderToolbar(loadedProps([]));

    const menu = await openMore(user);

    const devTools = within(menu).getByRole("menuitem", { name: "Developer tools" });
    expect([...devTools.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["Ctrl+Alt+I"]);
    expect(within(menu).getByRole("menuitem", { name: "Force reload" }).textContent).toBe("Force reload");
  });

  it("explains every tool the web runtime cannot run", async () => {
    const user = userEvent.setup();
    const desktopOnly = { kind: "disabled", reason: "Available in the desktop app" } as const;
    renderToolbar(loadedProps([], {
      tools: tools([], { developerTools: desktopOnly, zoom: desktopOnly, clearCache: desktopOnly }),
    }));

    const menu = await openMore(user);

    expect(within(menu).getByRole("menuitem", { name: "Developer tools" })).toHaveAccessibleDescription("Available in the desktop app");
    expect(within(menu).getByRole("menuitem", { name: "Clear cache" })).toHaveAccessibleDescription("Available in the desktop app");
    expect(within(menu).getByRole("button", { name: "Zoom in" })).toBeDisabled();
  });

  it("steps the zoom by ten percent from the factor the page reports", async () => {
    const user = userEvent.setup();
    const applied: number[] = [];
    renderToolbar(loadedProps([], {
      tools: tools([], {
        zoom: {
          kind: "enabled",
          read: async () => 1,
          set: async (factor) => {
            applied.push(factor);
            return factor;
          },
        },
      }),
    }));

    const menu = await openMore(user);
    await within(menu).findByText("100%");
    await user.click(within(menu).getByRole("button", { name: "Zoom in" }));
    await within(menu).findByText("110%");
    await user.click(within(menu).getByRole("button", { name: "Zoom in" }));
    await within(menu).findByText("120%");

    expect(applied).toEqual([1.1, 1.2]);
  });

  it("reports a zoom the page refused and keeps the last applied factor", async () => {
    useToastStore.setState({ toasts: [] });
    const user = userEvent.setup();
    renderToolbar(loadedProps([], {
      tools: tools([], {
        zoom: { kind: "enabled", read: async () => 1, set: async () => Promise.reject(new Error("guest gone")) },
      }),
    }));

    const menu = await openMore(user);
    await within(menu).findByText("100%");
    await user.click(within(menu).getByRole("button", { name: "Zoom in" }));

    await waitFor(() => expect(useToastStore.getState().toasts.map(({ kind, title, meta }) => ({ kind, title, meta }))).toEqual([
      { kind: "failed", title: "Couldn't change zoom", meta: "guest gone" },
    ]));
    expect(within(menu).getByText("100%")).toBeInTheDocument();
  });

  it("closes More when another tool takes the panel header and keeps it closed on return", async () => {
    const elements = { leading: document.createElement("div"), row2: document.createElement("div"), row3: null };
    const toolbar = (active: boolean) => (
      <TooltipProvider>
        <PanelHeaderSlotScope active={active} elements={elements}>
          <BrowserToolbar {...loadedProps([])} />
        </PanelHeaderSlotScope>
      </TooltipProvider>
    );
    const { rerender } = render(toolbar(true));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Clear cache" })).toBeInTheDocument();

    rerender(toolbar(false));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Clear cache" })).not.toBeInTheDocument());

    rerender(toolbar(true));
    expect(screen.queryByRole("menuitem", { name: "Clear cache" })).not.toBeInTheDocument();
  });
});
