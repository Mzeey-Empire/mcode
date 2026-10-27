// @vitest-environment jsdom
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useSidebarModel } from "../use-sidebar-model";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY_MS = 86_400_000;
const OLDER_AFTER_MS = 14 * DAY_MS;

describe("useSidebarModel boundary timer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useSidebarUiStore.setState({ view: "projects", scope: "active", olderOpen: false, expandedProjects: new Set(["ws-1"]), showMore: new Set() });
  });

  afterEach(() => {
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspaces: [], threads: [] });
  });

  it("moves a thread into Older when its boundary passes with no store change", () => {
    const at = new Date(NOW - OLDER_AFTER_MS + 60_000).toISOString();
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: "ws-1" })],
      threads: [createMockThread({ id: "aging", workspace_id: "ws-1", last_activity_at: at, created_at: at, updated_at: at })],
    });
    const { result } = renderHook(() => useSidebarModel());
    const keys = () => result.current.model.items.map((item) => item.key);
    expect(keys()).toContain("thread:aging");
    expect(keys()).not.toContain("older-bar");

    act(() => vi.advanceTimersByTime(60_000));

    expect(keys()).toContain("older-bar");
    expect(keys()).not.toContain("thread:aging");
    expect(result.current.cause).toBe("clock");
  });
});
