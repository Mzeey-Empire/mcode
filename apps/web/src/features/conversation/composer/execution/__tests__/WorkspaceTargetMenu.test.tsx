import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTargetMenu } from "../WorkspaceTargetMenu";
import type { ComposerMode } from "../composer-mode";

function renderMenu(mode: ComposerMode, isGitRepo = true) {
  const onModeChange = vi.fn();
  render(<WorkspaceTargetMenu mode={mode} isGitRepo={isGitRepo} folder="mcode" onModeChange={onModeChange} />);
  return { onModeChange };
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("workspace-target-trigger"));
  await screen.findByRole("menu");
  return user;
}

describe("WorkspaceTargetMenu", () => {
  it("names the current workspace on the trigger", () => {
    renderMenu("existing-worktree");
    expect(screen.getByTestId("workspace-target-trigger")).toHaveTextContent("Existing worktree");
  });

  it("lists the three workspaces under a Workspace label and checks the current one", async () => {
    renderMenu("worktree");
    await openMenu();

    expect(screen.getByRole("group", { name: "Workspace" })).toBeInTheDocument();
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["New worktree", "Existing worktree", "Localmcode"]);
    expect(screen.getByRole("menuitemradio", { name: /New worktree/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Local/ })).toHaveAttribute("aria-checked", "false");
  });

  it("shows the project folder in mono beside Local", async () => {
    renderMenu("direct");
    await openMenu();

    const folder = screen.getByText("mcode");
    expect(folder).toHaveClass("font-code");
    expect(screen.getByRole("menuitemradio", { name: /Local/ })).toContainElement(folder);
  });

  it("switches only the mode when a row is chosen", async () => {
    const { onModeChange } = renderMenu("worktree");
    const user = await openMenu();

    await user.click(screen.getByRole("menuitemradio", { name: /Existing worktree/ }));

    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("existing-worktree");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers no menu outside a git repo, only a static Local", () => {
    renderMenu("worktree", false);

    const trigger = screen.getByTestId("workspace-target-trigger");
    expect(trigger).toHaveTextContent("Local");
    expect(trigger.tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
