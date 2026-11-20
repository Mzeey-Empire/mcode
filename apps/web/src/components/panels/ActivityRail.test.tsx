import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import {
  rightPanelSingletonId,
  rightPanelToolInstance,
  subagentTabInstance,
  type RightPanelTool,
} from "@/stores/diffStore";
import { clearKeybindings, loadKeybindings } from "@/lib/keybinding-manager";
import defaultKeybindings from "@/config/default-keybindings.json";
import { ActivityRail } from "./ActivityRail";

const EXPECTED_EXPAND_DELAY_MS = 140;
const EXPECTED_COLLAPSE_DELAY_MS = 250;

const handlers = {
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onReorder: vi.fn(),
  onCreate: vi.fn(),
};

function railElement(openTabs: readonly RightPanelTool[] = ["terminal", "changes"]) {
  return (
    <ActivityRail
      tabInstances={openTabs.map(rightPanelToolInstance)}
      activeTabId={rightPanelSingletonId("terminal")}
      scope="thread"
      changesCount={3}
      changesFresh={false}
      {...handlers}
    />
  );
}

function renderRail() {
  return render(
    railElement(),
  );
}

describe("ActivityRail expansion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses hover intent to expand and a grace period to collapse", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS - 1));
    expect(rail).toHaveAttribute("data-expanded", "false");

    act(() => vi.advanceTimersByTime(1));
    expect(rail).toHaveAttribute("data-expanded", "true");
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS - 1));
    expect(rail).toHaveAttribute("data-expanded", "true");

    act(() => vi.advanceTimersByTime(1));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("publishes expansion changes for Browser surface coverage", () => {
    const onExpandedChange = vi.fn();
    render(
      <ActivityRail
        {...railElement().props}
        onExpandedChange={onExpandedChange}
      />,
    );
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it("selects only the active entry", () => {
    renderRail();

    const selected = screen.getAllByRole("tab", { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("Terminal");
  });

  it("lists Browser and Terminal as one entry each, whatever they hold", () => {
    render(railElement(["preview", "terminal"]));

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelectorAll("[data-rail-instance]")).toHaveLength(2);
  });

  it("swaps only the Browser glyph for a pointer while the agent acts", () => {
    const { rerender } = render(<ActivityRail {...railElement(["preview", "terminal"]).props} browserActing />);

    expect(screen.getByRole("tab", { name: "Browser" })).toContainElement(screen.getByTestId("rail-browser-acting"));
    expect(screen.getAllByTestId("rail-browser-acting")).toHaveLength(1);

    rerender(<ActivityRail {...railElement(["preview", "terminal"]).props} browserActing={false} />);

    expect(screen.queryByTestId("rail-browser-acting")).not.toBeInTheDocument();
  });

  it("cancels expansion when the pointer only crosses the rail", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS - 1));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("expands immediately when a rail control receives keyboard focus", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.focus(screen.getByRole("tab", { name: "Terminal" }));

    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("keeps a collapsed entry under the pointer until its click selects it", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");
    const terminal = screen.getByRole("tab", { name: "Terminal" });

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    fireEvent.pointerDown(terminal, { pointerType: "mouse" });
    fireEvent.focus(terminal);
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS * 2));
    expect(rail).toHaveAttribute("data-expanded", "false");

    fireEvent.pointerUp(terminal, { pointerType: "mouse" });
    fireEvent.click(terminal);
    expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("terminal"));

    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  // The picked tool's header controls sit under the expanded rail, where the pointer heads next.
  it("narrows after a pointer pick and widens again only once the pointer leaves and returns", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");
    const review = screen.getByRole("tab", { name: /^Review/ });

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");

    fireEvent.pointerDown(review, { pointerType: "mouse" });
    fireEvent.pointerUp(review, { pointerType: "mouse" });
    fireEvent.click(review);
    expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("changes"));
    expect(rail).toHaveAttribute("data-expanded", "false");

    fireEvent.pointerMove(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS * 2));
    expect(rail).toHaveAttribute("data-expanded", "false");

    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("stays expanded after a keyboard pick, which needs the labels to keep going", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");
    const review = screen.getByRole("tab", { name: /^Review/ });

    fireEvent.keyDown(review, { key: "Enter" });
    act(() => review.focus());
    fireEvent.click(review);

    expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("changes"));
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("collapses once the pointer leaves after a click, though the clicked entry keeps focus", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");
    const changes = screen.getByRole("tab", { name: /^Review/ });

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    fireEvent.pointerDown(changes, { pointerType: "mouse" });
    act(() => changes.focus());
    fireEvent.pointerUp(changes, { pointerType: "mouse" });
    fireEvent.click(changes);
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(document.activeElement).toBe(changes);
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  // Picking a tool from the add menu with the mouse returns focus to the menu's trigger from outside the rail.
  it("collapses after a pointer pick outside the rail returns focus to a rail control", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    act(() => screen.getByRole("button", { name: "Open tool" }).focus());
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("stays expanded while keyboard focus is inside, after the pointer passes through", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    act(() => screen.getByRole("tab", { name: "Terminal" }).focus());
    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("leaves panel-level actions to the panel header", () => {
    renderRail();
    fireEvent.focus(screen.getByRole("tab", { name: "Terminal" }));

    expect(screen.queryByRole("button", { name: "Hide panel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Maximize|Restore|Expand/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Terminal (shells keep running)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open tool" })).toBeInTheDocument();
  });

  it("offers the add control before any tool is open, so the rail shows where tools will live", () => {
    render(railElement([]));
    fireEvent.click(screen.getByRole("button", { name: "Open tool" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(handlers.onCreate).toHaveBeenCalledWith("files");
  });

  // An item tab's × ends its shell or page, so the rail's hide must not wear the same glyph.
  it("says and shows that Terminal and Browser exits only hide them while other tools close", () => {
    render(railElement(["terminal", "preview", "files"]));

    const hides = [
      screen.getByRole("button", { name: "Hide Terminal (shells keep running)" }),
      screen.getByRole("button", { name: "Hide Browser (pages stay open)" }),
    ];
    const close = screen.getByRole("button", { name: "Close Files" });
    for (const hide of hides) expect(hide.querySelector("svg")?.getAttribute("class")).toContain("lucide-minus");
    expect(close.querySelector("svg")?.getAttribute("class")).toContain("lucide-x");
  });

  it("hosts a caption action in the top strip when the window leaves it free", () => {
    const onClosePanel = vi.fn();
    render(
      <ActivityRail
        tabInstances={[{ id: rightPanelSingletonId("terminal"), type: "terminal" }]}
        activeTabId={rightPanelSingletonId("terminal")}
        scope="thread"
        changesCount={0}
        changesFresh={false}
        {...handlers}
        captionAction={<button type="button" onClick={onClosePanel}>Hide panel</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));

    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("opens the remaining tab choices and creates the selected tab", () => {
    renderRail();

    fireEvent.click(screen.getByRole("button", { name: "Open tool" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));

    expect(handlers.onCreate).toHaveBeenCalledWith("preview");
  });

  it("offers Terminal in the add menu only while the tool is closed", () => {
    const { rerender } = render(railElement(["changes"]));
    fireEvent.click(screen.getByRole("button", { name: "Open tool" }));
    expect(screen.getByRole("menuitem", { name: "Terminal" })).not.toHaveAttribute("aria-disabled");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    rerender(railElement(["terminal", "changes"]));
    fireEvent.click(screen.getByRole("button", { name: "Open tool" }));
    expect(screen.queryByRole("menuitem", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("collapses after a focused rail control is removed", () => {
    const { rerender } = render(railElement(["terminal"]));
    const rail = screen.getByTestId("activity-rail");

    fireEvent.focus(screen.getByRole("button", { name: "Hide Terminal (shells keep running)" }));
    expect(rail).toHaveAttribute("data-expanded", "true");

    rerender(railElement([]));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("reorders only from a focused rail tab keyboard shortcut", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    act(() => terminal.focus());

    fireEvent.keyDown(terminal, { key: "ArrowDown", altKey: true, shiftKey: true });

    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    expect(terminal).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Open tool" }), {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
    });
    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
  });

  it("reorders only after crossing the adjacent top-level item boundary", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("tab", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 48,
      bottom: 88,
    } as DOMRect);

    terminal.focus();
    fireEvent.pointerDown(terminal, { button: 0, pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 47 });
    expect(handlers.onReorder).not.toHaveBeenCalled();

    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 48 });
    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    fireEvent.click(terminal);
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(terminal).toHaveFocus();
  });

  it("selects a tab when pointer jitter does not become a drag", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("tab", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 88,
    } as DOMRect);

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 4, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 4, clientY: 21 });
    fireEvent.pointerUp(terminal, { pointerId: 4, clientY: 21 });
    fireEvent.click(terminal);

    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).toHaveBeenCalledWith("singleton:terminal");
  });

  it("selects normally after a cancelled drag gesture", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("tab", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 48,
      bottom: 88,
    } as DOMRect);

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 5, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 5, clientY: 48 });
    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    fireEvent.pointerCancel(terminal, { pointerId: 5, clientY: 48 });

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 6, clientY: 20 });
    fireEvent.pointerUp(terminal, { pointerId: 6, clientY: 20 });
    fireEvent.click(terminal);

    expect(handlers.onSelect).toHaveBeenCalledWith("singleton:terminal");
  });

  it("excludes close presses from drag and click activation", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    fireEvent.pointerEnter(terminal);
    const close = screen.getByRole("button", { name: "Hide Terminal (shells keep running)" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 2, clientY: 20 });
    fireEvent.pointerMove(close, { pointerId: 2, clientY: 100 });
    fireEvent.click(close);

    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledWith("singleton:terminal");
  });

  it("moves the Terminal tool as a whole", () => {
    render(railElement(["terminal", "preview"]));
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const browserItem = screen
      .getByRole("tab", { name: "Browser" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(browserItem, "getBoundingClientRect").mockReturnValue({
      top: 48,
      bottom: 88,
    } as DOMRect);

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 3, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 3, clientY: 48 });

    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
    expect(handlers.onReorder).toHaveBeenCalledWith("singleton:terminal", 1);
  });

  it("leaves keyboard boundary handling to the store and does not intercept content", () => {
    renderRail();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(handlers.onReorder).toHaveBeenCalledWith("singleton:terminal", -1);

    const content = document.createElement("textarea");
    document.body.append(content);
    fireEvent.keyDown(content, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
    content.remove();
  });
});

describe("ActivityRail subagent tabs", () => {
  function subagent(status: SubagentRosterEntry["status"]): SubagentRosterEntry {
    return {
      id: "call:explore", provider: "codex", title: "Explore the rail", prompt: null,
      subagentType: null, model: null, reasoningEffort: null, stepCount: 0, status,
      startedAt: "2026-10-13T10:00:00.000Z", endedAt: null, tier: "steps", canStop: false,
      sourceToolCallId: "explore", childThreadId: null, sourceMessageId: null, parentEntryId: null,
    };
  }

  function subagentRail(status: SubagentRosterEntry["status"]) {
    return (
      <ActivityRail
        tabInstances={[
          rightPanelToolInstance("changes"),
          rightPanelToolInstance("subagents"),
          subagentTabInstance("call:explore"),
        ]}
        activeTabId={rightPanelSingletonId("changes")}
        subagentEntries={[subagent(status)]}
        scope="thread"
        changesCount={0}
        changesFresh={false}
        {...handlers}
      />
    );
  }

  it("divides the subagent tabs from the tools and names each by its title", () => {
    render(subagentRail("running"));
    const rail = screen.getByTestId("activity-rail-surface");
    const order = [...rail.querySelectorAll("[data-rail-tab], [data-testid='rail-subagent-divider']")]
      .map((node) => node.getAttribute("data-rail-tab") ?? "divider");
    expect(order).toEqual(["review", "subagents", "divider", "subagent:call:explore"]);
    expect(screen.getByRole("tab", { name: "Explore the rail, running" })).toBeInTheDocument();
  });

  it("drags a tool past the subagent group only once it crosses Subagents", () => {
    vi.clearAllMocks();
    render(
      <ActivityRail
        tabInstances={[rightPanelToolInstance("subagents"), subagentTabInstance("call:explore"), rightPanelToolInstance("terminal")]}
        activeTabId={rightPanelSingletonId("terminal")}
        subagentEntries={[subagent("finished")]}
        scope="thread"
        changesCount={0}
        changesFresh={false}
        {...handlers}
      />,
    );
    const rows = ["Subagents", "Explore the rail", "Terminal"].map((name, index) => {
      const item = screen.getByRole("tab", { name }).closest<HTMLElement>("[data-rail-instance]");
      if (!item) throw new Error(`no rail item for ${name}`);
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 48, 40, 40));
      return item;
    });
    const terminal = screen.getByRole("tab", { name: "Terminal" });

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 1, clientY: 116 });
    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 88 });
    expect(handlers.onReorder).not.toHaveBeenCalled();

    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: rows[0].getBoundingClientRect().bottom });
    expect(handlers.onReorder).toHaveBeenCalledExactlyOnceWith(rightPanelSingletonId("terminal"), -1);
  });

  it("drops the running dot once the subagent finishes", () => {
    const { rerender } = render(subagentRail("running"));
    expect(screen.getByTestId("rail-subagent-running")).toBeInTheDocument();
    rerender(subagentRail("finished"));
    expect(screen.queryByTestId("rail-subagent-running")).toBeNull();
    expect(screen.getByRole("tab", { name: "Explore the rail" })).toBeInTheDocument();
  });
});

describe("ActivityRail keyboard tabs", () => {
  beforeEach(() => vi.clearAllMocks());

  const threeTools = () =>
    render(
      <ActivityRail
        tabInstances={(["terminal", "changes", "preview"] as const).map(rightPanelToolInstance)}
        activeTabId={rightPanelSingletonId("changes")}
        scope="thread"
        changesCount={0}
        changesFresh={false}
        {...handlers}
      />,
    );

  it("names the tablist and makes only the selected tool a Tab stop", async () => {
    threeTools();
    const tablist = screen.getByRole("tablist", { name: "Panel tools" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(within(tablist).queryByRole("button", { name: "Open tool" })).toBeNull();

    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "Review" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Open tool" })).toHaveFocus();
  });

  it("moves focus with Up, Down, Home, and End without switching tools", async () => {
    threeTools();
    act(() => screen.getByRole("tab", { name: "Review" }).focus());

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();

    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onReorder).not.toHaveBeenCalled();
  });

  it("activates the focused tool on Enter or Space", async () => {
    threeTools();
    act(() => screen.getByRole("tab", { name: "Terminal" }).focus());

    await userEvent.keyboard("{Enter}");
    expect(handlers.onSelect).toHaveBeenLastCalledWith(rightPanelSingletonId("terminal"));
    await userEvent.keyboard("{ArrowDown}[Space]");
    expect(handlers.onSelect).toHaveBeenLastCalledWith(rightPanelSingletonId("changes"));
  });

  it("reorders on Alt+Shift+Arrow and keeps focus put", async () => {
    threeTools();
    const review = screen.getByRole("tab", { name: "Review" });
    act(() => review.focus());

    await userEvent.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
    expect(handlers.onReorder).toHaveBeenCalledExactlyOnceWith(rightPanelSingletonId("changes"), 1);
    expect(review).toHaveFocus();
  });

  it("closes the focused tool on Delete", async () => {
    threeTools();
    act(() => screen.getByRole("tab", { name: "Browser" }).focus());

    await userEvent.keyboard("{Delete}");
    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(rightPanelSingletonId("preview"));
  });

  // A shortcut chip in the expanded row squeezed the tool name to its first letter.
  it("keeps the expanded row to the tool name and offers the shortcut in its tooltip", async () => {
    clearKeybindings();
    loadKeybindings(defaultKeybindings);
    threeTools();
    const terminal = screen.getByRole("tab", { name: "Terminal" });

    act(() => terminal.focus());
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-expanded", "true");
    expect(terminal.querySelector("kbd")).toBeNull();

    await userEvent.hover(terminal);
    const keycaps = await screen.findAllByText("J", { selector: "kbd" }, { timeout: 2000 });
    expect(keycaps).not.toHaveLength(0);
    clearKeybindings();
  });
});
