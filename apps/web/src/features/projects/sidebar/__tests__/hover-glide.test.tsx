import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

vi.mock("@/components/ui/virtual-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/virtual-viewport")>()),
  VirtualViewport: (await import("./fake-virtual-viewport")).FakeVirtualViewport,
}));

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  schedulePrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  prefetchOnPointerDown: vi.fn(),
}));

import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { ProjectSidebar } from "../ProjectSidebar";
import { HOVER_ROW_ATTRIBUTE, HoverGlide, highlightStyle, rowBoxInContent } from "../hover-glide";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });

describe("hover highlight geometry", () => {
  it("lands on the row's box measured from the scroll content, which already includes scroll", () => {
    // Content scrolled 200px up: its top sits above the scroller, so a row at viewport y=150 is 350 into it.
    const content = new DOMRect(10, -200, 240, 2000);
    const row = new DOMRect(14, 150, 232, 54);
    expect(rowBoxInContent(row, content)).toEqual({ top: 350, left: 4, width: 232, height: 54 });
  });

  it("glides x, y, width and height between rows, and never slides while following a scroll", () => {
    const box = { top: 78, left: 18, width: 222, height: 54 };
    const glide = highlightStyle(box, "glide", false);
    expect(glide).toMatchObject({ transform: "translate(18px, 78px)", width: "222px", height: "54px", opacity: "1" });
    expect(glide.transition).toMatch(/transform/);
    expect(glide.transition).toMatch(/width/);
    expect(glide.transition).toMatch(/height/);
    expect(highlightStyle(box, "appear", false).transition).not.toMatch(/transform|width|height/);
    expect(highlightStyle(box, "snap", false).transition).toBe("none");
  });
});

describe("HoverGlide", () => {
  // The fill lives in content coordinates; content starts at viewport (10, 100).
  const CONTENT = new DOMRect(10, 100, 240, 400);
  const ROW_BOXES = [new DOMRect(10, 100, 240, 32), new DOMRect(28, 132, 222, 54), new DOMRect(28, 186, 222, 54)];

  function mountList({ inertRow }: { inertRow?: number } = {}) {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    scroller.append(content);
    content.getBoundingClientRect = () => CONTENT;
    const rows = ROW_BOXES.map((box, index) => {
      const row = document.createElement("div");
      row.setAttribute(HOVER_ROW_ATTRIBUTE, "");
      row.getBoundingClientRect = () => box;
      if (index === inertRow) row.setAttribute("inert", "");
      content.append(row);
      return row;
    });
    document.body.append(scroller);
    const glide = new HoverGlide(scroller, content, () => () => {});
    return { scroller, rows, glide, fill: glide.element };
  }

  function setReducedMotion(reduced: boolean) {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: reduced && query.includes("reduce"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  afterEach(() => {
    // Unmount before resetting state so the resets do not re-render a live tree outside act().
    cleanup();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("lands on the hovered row, sliding sideways from a header to an indented row", () => {
    setReducedMotion(false);
    const { rows, fill } = mountList();

    fireEvent.pointerMove(rows[0]!);
    fireEvent.pointerMove(rows[1]!);

    expect(fill.style).toMatchObject({ transform: "translate(18px, 32px)", width: "222px", height: "54px", opacity: "1" });
    expect(fill.style.transition).toMatch(/transform/);
  });

  it("keeps the fill on a row whose menu is open after the pointer leaves, and drops it when the menu closes", async () => {
    setReducedMotion(false);
    const { scroller, rows, fill } = mountList();

    fireEvent.pointerMove(rows[1]!);
    rows[1]!.setAttribute("data-menu-open", "");
    fireEvent.pointerLeave(scroller);
    await Promise.resolve();
    expect(fill.style).toMatchObject({ transform: "translate(18px, 32px)", opacity: "1" });

    rows[1]!.removeAttribute("data-menu-open");
    await vi.waitFor(() => expect(fill.style.opacity).toBe("0"));
  });

  it("skips an inert row, which is closing and takes no hover", () => {
    setReducedMotion(false);
    const { rows, fill } = mountList({ inertRow: 2 });

    fireEvent.pointerMove(rows[1]!);
    fireEvent.pointerMove(rows[2]!);

    expect(fill.style.opacity).toBe("0");
  });

  it("shows, moves and hides with no transition under reduced motion", () => {
    setReducedMotion(true);
    const { scroller, rows, fill } = mountList();

    fireEvent.pointerMove(rows[0]!);
    expect(fill.style.transition).toBe("none");
    fireEvent.pointerMove(rows[1]!);
    expect(fill.style.transition).toBe("none");
    fireEvent.pointerLeave(scroller);
    expect(fill.style).toMatchObject({ transition: "none", opacity: "0" });
  });

  it("adds no scrollable overflow when hidden with a stale box, because a layer filling the content clips it", () => {
    setReducedMotion(false);
    const { scroller, rows, fill } = mountList();
    const content = rows[0]!.parentElement;
    fireEvent.pointerMove(rows[2]!);

    // Leaving before any fade starts means no transitionend ever fires, so the box stays.
    fireEvent.pointerLeave(scroller);
    expect(fill.style).toMatchObject({ opacity: "0", height: "54px" });

    const layer = fill.parentElement;
    if (!layer) throw new Error("fill has no layer");
    expect(layer.parentElement).toBe(content);
    expect(layer.hasAttribute("data-index")).toBe(false);
    const clip = getComputedStyle(layer);
    expect({ position: clip.position, top: clip.top, right: clip.right, bottom: clip.bottom, left: clip.left, overflow: clip.overflow })
      .toEqual({ position: "absolute", top: "0px", right: "0px", bottom: "0px", left: "0px", overflow: "hidden" });
  });
});

describe("SidebarList hover highlight", () => {
  beforeEach(() => {
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    useWorkspaceStore.setState({
      workspaces: [WORKSPACE],
      threads: ["One", "Two", "Three"].map((title, index) => createMockThread({ id: `t${index}`, workspace_id: "ws-1", title, last_activity_at: new Date().toISOString() })),
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      loadWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    // Unmount before resetting state so the resets do not re-render a live tree outside act().
    cleanup();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("moves across rows without committing a single React render", () => {
    let commits = 0;
    render(<Profiler id="sidebar" onRender={() => { commits += 1; }}><ProjectSidebar /></Profiler>);
    const rows = ["One", "Two", "Three"].map((title) => screen.getByRole("button", { name: new RegExp(`^${title}`) }));
    const highlight = screen.getByTestId("sidebar-hover-highlight");
    const before = commits;

    fireEvent.pointerMove(screen.getByTestId("project-row-ws-1"));
    for (const row of rows) fireEvent.pointerMove(row);

    expect(commits).toBe(before);
    expect(highlight.style.opacity).toBe("1");
    fireEvent.pointerLeave(screen.getByTestId("project-tree-viewport"));
    expect(highlight.style.opacity).toBe("0");
  });
});
