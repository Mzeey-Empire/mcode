import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { fireEvent, render, screen } from "@testing-library/react";
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
import { highlightStyle, rowBoxInContent } from "../hover-glide";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });

describe("hover highlight geometry", () => {
  it("lands on the row's box measured from the scroll content, which already includes scroll", () => {
    // Content scrolled 200px up: its top sits above the scroller, so a row at viewport y=150 is 350 into it.
    const content = new DOMRect(10, -200, 240, 2000);
    const row = new DOMRect(14, 150, 232, 54);
    expect(rowBoxInContent(row, content)).toEqual({ top: 350, left: 4, width: 232, height: 54 });
  });

  it("glides between rows, jumps under reduced motion, and never slides while following a scroll", () => {
    const box = { top: 78, left: 0, width: 240, height: 54 };
    const glide = highlightStyle(box, "glide", false);
    expect(glide).toMatchObject({ transform: "translateY(78px)", height: "54px", opacity: "1" });
    expect(glide.transition).toMatch(/transform/);
    expect(glide.transition).toMatch(/height/);
    expect(highlightStyle(box, "glide", true).transition).not.toMatch(/transform|height/);
    expect(highlightStyle(box, "appear", false).transition).not.toMatch(/transform|height/);
    expect(highlightStyle(box, "snap", false).transition).toBe("none");
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
