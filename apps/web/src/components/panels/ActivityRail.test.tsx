import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts";
import {
  rightPanelSingletonId,
  rightPanelToolInstance,
  subagentTabInstance,
  type RightPanelTool,
} from "@/stores/diffStore";
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

    const selected = screen.getAllByRole("button", { pressed: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("Terminal");
    expect(screen.getAllByTestId("rail-active-edge")).toHaveLength(1);
  });

  it("lists Browser and Terminal as one entry each, whatever they hold", () => {
    render(railElement(["preview", "terminal"]));

    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll("[data-rail-instance]")).toHaveLength(2);
    expect(screen.getAllByTestId("rail-active-edge")).toHaveLength(1);
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

    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("keeps a collapsed entry under the pointer until its click selects it", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");
    const terminal = screen.getByRole("button", { name: "Terminal" });

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    fireEvent.pointerDown(terminal, { pointerType: "mouse" });
    fireEvent.focus(terminal);
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS * 2));
    expect(rail).toHaveAttribute("data-expanded", "false");

    fireEvent.pointerUp(terminal, { pointerType: "mouse" });
    fireEvent.click(terminal);
    expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("terminal"));

    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("leaves panel-level actions to the panel header", () => {
    renderRail();
    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.queryByRole("button", { name: "Close panel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Maximize|Restore|Expand/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New tab" })).toBeInTheDocument();
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
        captionAction={<button type="button" onClick={onClosePanel}>Close panel</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));

    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("opens the remaining tab choices and creates the selected tab", () => {
    renderRail();

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));

    expect(handlers.onCreate).toHaveBeenCalledWith("preview");
  });

  it("offers Terminal in the add menu only while the tool is closed", () => {
    const { rerender } = render(railElement(["changes"]));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.getByRole("menuitem", { name: "Terminal" })).not.toHaveAttribute("aria-disabled");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    rerender(railElement(["terminal", "changes"]));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.queryByRole("menuitem", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("collapses after a focused rail control is removed", () => {
    const { rerender } = render(railElement(["terminal"]));
    const rail = screen.getByTestId("activity-rail");

    fireEvent.focus(screen.getByRole("button", { name: "Close Terminal" }));
    expect(rail).toHaveAttribute("data-expanded", "true");

    rerender(railElement([]));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("keeps the renderer guest visible and clickable beside the expanded rail", () => {
    const guestPointerDown = vi.fn();
    render(
      <div
        data-testid="preview-compositing-root"
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <div
          data-testid="renderer-guest"
          className="absolute inset-0 z-(--layer-base)"
          onPointerDown={guestPointerDown}
        />
        <div
          data-testid="browser-automation-overlay"
          className="pointer-events-none absolute inset-0 z-(--layer-dropdown)"
        />
        <span
          data-testid="browser-automation-pointer"
          className="pointer-events-none absolute z-(--layer-floating-panel)"
        />
        {railElement()}
      </div>,
    );

    const rail = screen.getByTestId("activity-rail");
    const guest = screen.getByTestId("renderer-guest");
    const terminal = screen.getByRole("button", { name: "Terminal" });

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "true");
    expect(guest).toBeVisible();
    fireEvent.click(terminal);
    expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("terminal"));
    fireEvent.pointerDown(guest, { clientX: 300, clientY: 200 });
    expect(guestPointerDown).toHaveBeenCalledTimes(1);

    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });
  it("reorders only from a focused rail tab keyboard shortcut", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    act(() => terminal.focus());

    fireEvent.keyDown(terminal, { key: "ArrowDown", altKey: true, shiftKey: true });

    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    expect(terminal).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "New tab" }), {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
    });
    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
  });

  it("reorders only after crossing the adjacent top-level item boundary", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
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
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
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
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
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
    const terminal = screen.getByRole("button", { name: "Terminal" });
    fireEvent.pointerEnter(terminal);
    const close = screen.getByRole("button", { name: "Close Terminal" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 2, clientY: 20 });
    fireEvent.pointerMove(close, { pointerId: 2, clientY: 100 });
    fireEvent.click(close);

    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledWith("singleton:terminal");
  });

  it("moves the Terminal tool as a whole", () => {
    render(railElement(["terminal", "preview"]));
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const browserItem = screen
      .getByRole("button", { name: "Browser" })
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
    const terminal = screen.getByRole("button", { name: "Terminal" });
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
    expect(screen.getByRole("button", { name: "Explore the rail, running" })).toBeInTheDocument();
  });

  it("drags a tool past the subagent group only once it crosses Subagents", () => {
    vi.clearAllMocks();
    render(
      <ActivityRail
        tabInstances={[rightPanelToolInstance("subagents"), subagentTabInstance("call:explore"), rightPanelToolInstance("terminal")]}
        activeTabId={rightPanelSingletonId("terminal")}
        subagentEntries={[subagent("done")]}
        scope="thread"
        changesCount={0}
        changesFresh={false}
        {...handlers}
      />,
    );
    const rows = ["Subagents", "Explore the rail", "Terminal"].map((name, index) => {
      const item = screen.getByRole("button", { name }).closest<HTMLElement>("[data-rail-instance]");
      if (!item) throw new Error(`no rail item for ${name}`);
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 48, 40, 40));
      return item;
    });
    const terminal = screen.getByRole("button", { name: "Terminal" });

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 1, clientY: 116 });
    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 88 });
    expect(handlers.onReorder).not.toHaveBeenCalled();

    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: rows[0].getBoundingClientRect().bottom });
    expect(handlers.onReorder).toHaveBeenCalledExactlyOnceWith(rightPanelSingletonId("terminal"), -1);
  });

  it("drops the running dot once the subagent finishes", () => {
    const { rerender } = render(subagentRail("running"));
    expect(screen.getByTestId("rail-subagent-running")).toBeInTheDocument();
    rerender(subagentRail("done"));
    expect(screen.queryByTestId("rail-subagent-running")).toBeNull();
    expect(screen.getByRole("button", { name: "Explore the rail" })).toBeInTheDocument();
  });
});
