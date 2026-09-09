import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HookExecution } from "@/transport/types";
import { TurnHooksPopover } from "../TurnHooksPopover";

const hook: HookExecution = {
  hookName: "SessionStart:startup", hookType: "stop", status: "completed",
  outputLines: ["Loaded instructions"], fullOutput: ["Loaded instructions"],
  startedAt: 1000, durationMs: 32, exitCode: 0, didBlock: false,
};

describe("turn hooks", () => {
  it("shows the trigger, name, and count on hover without exposing output", async () => {
    const user = userEvent.setup();
    render(<TurnHooksPopover hooks={[hook]} />);
    expect(screen.queryByText(hook.hookName)).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "Hooks" }));
    const dialog = await screen.findByRole("dialog", { name: "Hooks" });
    expect(dialog).toHaveTextContent("SessionStart");
    expect(dialog).toHaveTextContent("startup");
    expect(dialog).toHaveTextContent("1 run");
    await user.hover(dialog);
    expect(screen.queryByText("Loaded instructions")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("counts consecutive matching runs while preserving trigger order", async () => {
    const user = userEvent.setup();
    const guard = { ...hook, hookName: "PreToolUse:git-guardrails check" };
    render(<TurnHooksPopover hooks={[guard, guard, { ...hook, hookName: "PostToolUse:Check UI" }, guard]} />);
    await user.hover(screen.getByRole("button", { name: "Hooks" }));
    const dialog = await screen.findByRole("dialog", { name: "Hooks" });
    expect(Array.from(dialog.querySelectorAll("dt"), (node) => node.textContent)).toEqual(["PreToolUse", "PostToolUse", "PreToolUse"]);
    expect(Array.from(dialog.querySelectorAll("dd"), (node) => node.textContent)).toEqual(["2 runsgit-guardrails check", "1 runCheck UI", "1 rungit-guardrails check"]);
  });

  it("supports click and keyboard access without reopening after Escape", async () => {
    const user = userEvent.setup();
    render(<TurnHooksPopover hooks={[hook]} />);
    await user.tab();
    expect(await screen.findByRole("dialog", { name: "Hooks" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Hooks" }));
    expect(await screen.findByRole("dialog", { name: "Hooks" })).toBeVisible();
  });

  it("updates the closed icon for running, failed, and blocked hooks and removes empty turns", () => {
    const view = render(<TurnHooksPopover hooks={[{ ...hook, status: "running" }]} />);
    expect(screen.getByRole("button", { name: "Hooks: running" })).toBeInTheDocument();
    view.rerender(<TurnHooksPopover hooks={[{ ...hook, exitCode: 1 }]} />);
    expect(screen.getByRole("button", { name: "Hooks: attention required" })).toBeInTheDocument();
    view.rerender(<TurnHooksPopover hooks={[{ ...hook, didBlock: true }]} />);
    expect(screen.getByRole("button", { name: "Hooks: attention required" })).toBeInTheDocument();
    view.rerender(<TurnHooksPopover hooks={[]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
