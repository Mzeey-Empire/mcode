import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationControllerState, BrowserAutomationPointerEvent } from "@mcode/contracts/models/browser-automation";
import { browserAutomationTargetKey, useBrowserAutomationStore } from "../../automation/browserAutomationStore";
import { AGENT_CURSOR_ACTIVE_MS, BrowserActingOverlay, mapAgentCursorPoint } from "../BrowserActingOverlay";

const WORKSPACE = "workspace";
const THREAD = "thread";
const TAB = "tab";
const KEY = browserAutomationTargetKey(WORKSPACE, THREAD, TAB);

function pointer(phase: BrowserAutomationPointerEvent["phase"], sequence: number, zoomFactor = 1): BrowserAutomationPointerEvent {
  return { tabId: TAB, phase, x: 100, y: 40, zoomFactor, sequence };
}

function setAgentState(controller: BrowserAutomationControllerState["controller"], point: BrowserAutomationPointerEvent | null) {
  useBrowserAutomationStore.setState({
    controllers: new Map([[KEY, { tabId: TAB, controller, controlEpoch: 1 }]]),
    actingTargets: new Set([KEY]),
    pointers: new Map(point ? [[KEY, point]] : []),
  });
}

/** Renders the overlay beside a page placed at (12, 8) and drawn at half size, as a responsive viewport does. */
function renderOverPlacedPage() {
  const view = render(
    <div>
      <div data-testid="preview-webview" data-thread-id={THREAD} data-tab-id={TAB} />
      <BrowserActingOverlay workspaceId={WORKSPACE} threadId={THREAD} tabId={TAB} coveredRight={0} />
    </div>,
  );
  const page = view.getByTestId("preview-webview");
  Object.defineProperty(page, "offsetWidth", { configurable: true, value: 800 });
  page.getBoundingClientRect = () => new DOMRect(12, 8, 400, 300);
  return view;
}

describe("mapAgentCursorPoint", () => {
  it("scales a page CSS point by page zoom and the drawn page size, then offsets it by the page position", () => {
    expect(mapAgentCursorPoint({ x: 100, y: 40, zoomFactor: 1.5 }, { left: 12, top: 8, scale: 0.5 })).toEqual({ x: 87, y: 38 });
  });
});

describe("BrowserActingOverlay agent cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useBrowserAutomationStore.setState({ controllers: new Map(), actingTargets: new Set(), pointers: new Map() });
  });

  it("lands on the agent's point through page zoom and the responsive page scale", () => {
    setAgentState("agent", null);
    renderOverPlacedPage();
    expect(screen.queryByTestId("browser-automation-pointer")).not.toBeInTheDocument();

    act(() => setAgentState("agent", pointer("move", 1, 1.5)));

    expect(screen.getByTestId("browser-automation-pointer")).toHaveStyle({ transform: "translate3d(87px, 38px, 0)" });
  });

  it("pings on a click but not on a move", () => {
    setAgentState("agent", pointer("move", 1));
    renderOverPlacedPage();
    expect(screen.queryByTestId("browser-automation-pointer-ping")).not.toBeInTheDocument();

    act(() => setAgentState("agent", pointer("click", 2)));

    expect(screen.getByTestId("browser-automation-pointer-ping")).toBeInTheDocument();
  });

  it("dims once the agent stops moving", () => {
    setAgentState("agent", pointer("move", 1));
    renderOverPlacedPage();
    expect(screen.getByTestId("browser-automation-pointer")).toHaveStyle({ opacity: "1" });

    act(() => {
      vi.advanceTimersByTime(AGENT_CURSOR_ACTIVE_MS);
    });

    expect(screen.getByTestId("browser-automation-pointer")).not.toHaveStyle({ opacity: "1" });
  });

  it("hides the cursor while the user holds control", () => {
    setAgentState("human", pointer("click", 1));
    renderOverPlacedPage();

    expect(screen.queryByTestId("browser-automation-pointer")).not.toBeInTheDocument();
  });
});
