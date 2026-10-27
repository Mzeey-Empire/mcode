import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";

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
import { useProjectTreeMenus } from "../../ProjectTree";
import { SidebarList } from "../SidebarList";
import { useSidebarModel } from "../use-sidebar-model";
import { FakeVirtualViewport } from "./fake-virtual-viewport";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY_MS = 86_400_000;
const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });

function threadAt(id: string, daysAgo: number): Thread {
  const at = new Date(NOW - daysAgo * DAY_MS).toISOString();
  return createMockThread({ id, workspace_id: "ws-1", title: `Title ${id}`, provider: "claude", last_activity_at: at, created_at: at, updated_at: at });
}

function Harness() {
  const { model } = useSidebarModel();
  const { ctx, overlays } = useProjectTreeMenus();
  return (
    <>
      <SidebarList items={model.items} ctx={ctx} />
      {overlays}
    </>
  );
}

function renderedThreadIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='thread-item']")].map((row) => row.dataset.threadId ?? "");
}

function olderBars(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Older/ });
}

function seed(threads: Thread[], activeThreadId: string | null = null): void {
  useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads, activeWorkspaceId: "ws-1", activeThreadId });
}

describe("SidebarList Older section", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useSidebarUiStore.setState({ view: "projects", scope: "active", olderOpen: false, expandedProjects: new Set(["ws-1"]), showMore: new Set(), collapsedOlderProjects: new Set() });
  });

  afterEach(() => {
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("shows exactly one bar, and opening it lists the Older threads and rises the bar", () => {
    seed([threadAt("recent", 1), threadAt("stale-1", 20), threadAt("stale-2", 30)]);
    render(<Harness />);
    expect(olderBars()).toHaveLength(1);
    expect(olderBars()[0]).toHaveAccessibleName(/^Older\s*2/);
    expect(renderedThreadIds()).toEqual(["recent"]);

    fireEvent.click(olderBars()[0]!);

    expect(olderBars()).toHaveLength(1);
    expect(olderBars()[0]).toHaveAttribute("aria-expanded", "true");
    expect(renderedThreadIds()).toEqual(["recent", "stale-1", "stale-2"]);
    expect(FakeVirtualViewport.latest?.moves.at(-1)?.position).toEqual({ kind: "target", key: "older-bar", align: "start" });
  });

  it("has no bar when no thread is Older", () => {
    seed([threadAt("recent", 1), threadAt("week-old", 7)]);
    render(<Harness />);
    expect(olderBars()).toHaveLength(0);
  });

  it("still shows the selected Older thread while the section is closed", () => {
    seed([threadAt("recent", 1), threadAt("stale-1", 20), threadAt("stale-2", 30)], "stale-2");
    render(<Harness />);
    expect(olderBars()[0]).toHaveAttribute("aria-expanded", "false");
    expect(renderedThreadIds()).toEqual(["recent", "stale-2"]);
  });
});
