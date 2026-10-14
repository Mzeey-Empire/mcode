import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCommands, registerCommand } from "@/lib/command-registry";

const mocks = vi.hoisted(() => ({
  palette: { query: ">", close: () => undefined },
  workspace: { workspaces: [], setActiveWorkspace: () => undefined, setActiveThread: () => undefined },
  recent: { threads: [], fetch: () => undefined },
}));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: typeof mocks.palette) => unknown) => selector(mocks.palette),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.workspace) => unknown) => selector(mocks.workspace),
}));

vi.mock("@/stores/recentThreadsStore", () => ({
  useRecentThreadsStore: (selector: (state: typeof mocks.recent) => unknown) => selector(mocks.recent),
}));

vi.mock("@/lib/platform", () => ({ isMac: false, isWindows: true }));

vi.mock("@/components/ui/command", () => ({
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <section aria-label={heading}>{children}</section>
  ),
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
}));

import { RootView } from "../RootView";

describe("RootView", () => {
  afterEach(() => clearCommands());

  it("renames an open action when its command is registered again with a new title", () => {
    const dispose = registerCommand({ id: "plan.implement", title: "Implement v2", category: "Plan", handler: () => undefined });
    render(<RootView />);
    expect(screen.getByText("Implement v2")).toBeInTheDocument();

    act(() => {
      dispose();
      registerCommand({ id: "plan.implement", title: "Implement v3", category: "Plan", handler: () => undefined });
    });

    expect(screen.getByText("Implement v3")).toBeInTheDocument();
    expect(screen.queryByText("Implement v2")).toBeNull();
  });
});
