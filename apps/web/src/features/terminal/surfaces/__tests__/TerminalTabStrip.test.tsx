import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalInstance } from "@/features/terminal/state/terminalStore";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { TerminalTabStrip } from "../TerminalTabStrip";

const { transport } = vi.hoisted(() => ({
  transport: {
    readWorkspaceEnvironment: vi.fn(),
    listWorkspaceActionRuns: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));
vi.mock("@/lib/ensure-terminal", () => ({ createTerminalForScope: vi.fn() }));

function terminal(id: string, label: string): TerminalInstance {
  return { id, threadId: "thread-1", label, kind: "shell" };
}

function renderStrip(threadId: string | null, terminals: readonly TerminalInstance[] = [terminal("a", "pwsh")]) {
  return render(
    <TooltipProvider>
      <TerminalTabStrip
        workspaceId="workspace-1"
        threadId={threadId}
        scopeId="scope-1"
        terminals={terminals}
        activeId="a"
        labels={new Map()}
        actionRuns={{}}
        onClose={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("TerminalTabStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listWorkspaceActionRuns.mockResolvedValue([]);
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [] },
      revision: null,
      status: "absent",
    });
  });

  it("shows each shell tab with its shell's icon", () => {
    renderStrip(null, [terminal("a", "pwsh"), terminal("b", "/bin/zsh")]);

    expect(screen.getAllByTestId("action-icon").map((icon) => icon.getAttribute("data-icon-id"))).toEqual([
      "powershell",
      "shell",
    ]);
  });

  it("opens a shell straight from + when the thread has no Project Actions", async () => {
    const user = userEvent.setup();
    renderStrip("thread-1");
    await waitFor(() => expect(screen.getByTestId("panel-tab-add")).not.toHaveAttribute("aria-haspopup"));

    await user.click(screen.getByTestId("panel-tab-add"));

    expect(createTerminalForScope).toHaveBeenCalledWith("scope-1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu, not a shell, when + is clicked before the Actions have loaded", async () => {
    const user = userEvent.setup();
    transport.readWorkspaceEnvironment.mockReturnValue(new Promise(() => {}));
    renderStrip("thread-1");

    await user.click(screen.getByTestId("panel-tab-add"));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(createTerminalForScope).not.toHaveBeenCalled();
  });

  it("keeps the menu when the Actions fail to load", async () => {
    const user = userEvent.setup();
    transport.readWorkspaceEnvironment.mockRejectedValue(new Error("offline"));
    renderStrip("thread-1");

    await waitFor(() => expect(screen.getByTestId("panel-tab-add")).toHaveAttribute("aria-haspopup", "menu"));
    await user.click(screen.getByTestId("panel-tab-add"));

    expect(await screen.findByText("Project Actions are unavailable.")).toBeInTheDocument();
    expect(createTerminalForScope).not.toHaveBeenCalled();
  });

  it("opens the Actions menu from + when the thread has Project Actions", async () => {
    const user = userEvent.setup();
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [{ id: "dev", name: "Dev", command: { default: "bun run dev" } }] },
      revision: "r1",
      status: "present",
    });
    renderStrip("thread-1");

    await waitFor(() => expect(screen.getByTestId("panel-tab-add")).toHaveAttribute("aria-haspopup", "menu"));
    await user.click(screen.getByTestId("panel-tab-add"));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByTestId("project-action-dev")).toBeInTheDocument();
    expect(createTerminalForScope).not.toHaveBeenCalled();
  });
});
