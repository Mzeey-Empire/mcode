import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Notice } from "../notice";

describe("Notice", () => {
  it("runs its one action and its dismiss", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Notice
        tone="warning"
        title="Provider unavailable"
        detail="Claude CLI was not found."
        action={{ label: "Open Settings", onClick: onOpenSettings }}
        onDismiss={onDismiss}
        dismissLabel="Dismiss error"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    await user.click(screen.getByRole("button", { name: "Dismiss error" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("keeps a collapsible detail hidden until the user opens it", async () => {
    const user = userEvent.setup();
    render(<Notice tone="warning" collapsible title="Post-checkout hook encountered an error" detail="exited with code 1" />);

    expect(screen.queryByText("exited with code 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show details" }));

    expect(screen.getByText("exited with code 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    ["error", "alert"],
    ["warning", "status"],
    ["info", "status"],
    ["success", "status"],
  ] as const)("announces a %s notice as %s", (tone, role) => {
    render(<Notice tone={tone} title="Command failed" />);

    expect(screen.getByRole(role)).toHaveTextContent("Command failed");
  });
});
