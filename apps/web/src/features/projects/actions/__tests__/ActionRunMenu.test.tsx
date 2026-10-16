import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActionRunMenu, type ActionRunMenuProps } from "../ActionRunMenu";

const dev: WorkspaceEnvironmentAction = { id: "dev", name: "Dev", command: { default: "bun run dev" } };
const test: WorkspaceEnvironmentAction = { id: "test", name: "Test", command: { default: "bun run test" } };

function runOf(actionId: string, status: WorkspaceEnvironmentActionRun["status"]): WorkspaceEnvironmentActionRun {
  return { actionId, status } as WorkspaceEnvironmentActionRun;
}

async function openMenu(overrides: Partial<ActionRunMenuProps> = {}) {
  const props: ActionRunMenuProps = {
    trigger: <button type="button">Actions</button>,
    actions: [dev, test],
    runsByActionId: new Map(),
    terminalCapReason: null,
    onRun: vi.fn(),
    onOpen: vi.fn(),
    onNewTerminal: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  render(<TooltipProvider><ActionRunMenu {...props} /></TooltipProvider>);
  await user.click(screen.getByRole("button", { name: "Actions" }));
  await screen.findByRole("menu");
  return { user, props };
}

describe("ActionRunMenu", () => {
  it("lists actions, then New terminal, then Edit actions", async () => {
    await openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.replace(/Run$/, "").trim())).toEqual([
      "Dev",
      "Test",
      "New terminal",
      "Edit actions",
    ]);
  });

  it("badges only a running action and opens its terminal instead of starting another", async () => {
    const { user, props } = await openMenu({
      runsByActionId: new Map([["dev", runOf("dev", "running")], ["test", runOf("test", "completed")]]),
    });
    expect(screen.getAllByTestId("action-menu-badge")).toHaveLength(1);

    await user.click(screen.getByTestId("project-action-dev"));
    expect(props.onOpen).toHaveBeenCalledWith("dev");
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("starts an idle action", async () => {
    const { user, props } = await openMenu();
    await user.click(screen.getByTestId("project-action-test"));
    expect(props.onRun).toHaveBeenCalledWith("test");
  });

  it("at the terminal cap blocks new terminals and idle actions but still opens a running one", async () => {
    const { user, props } = await openMenu({
      terminalCapReason: "8 terminals are open.",
      runsByActionId: new Map([["dev", runOf("dev", "running")]]),
    });

    await user.click(screen.getByRole("menuitem", { name: /New terminal/ }));
    await user.click(screen.getByTestId("project-action-test"));
    expect(props.onNewTerminal).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("project-action-dev"));
    expect(props.onOpen).toHaveBeenCalledWith("dev");
  });
});
