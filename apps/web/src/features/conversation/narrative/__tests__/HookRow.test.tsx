import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HookRow } from "../HookRow";
import type { HookExecution } from "@/transport/types";

function makeHook(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    hookName: "SessionStart:startup",
    hookType: "stop",
    status: "completed",
    outputLines: [],
    fullOutput: [],
    startedAt: 1_700_000_000_000,
    durationMs: 32,
    exitCode: 0,
    didBlock: false,
    ...overrides,
  };
}

describe("HookRow", () => {
  function closestCollapsible(element: HTMLElement): HTMLElement {
    const collapsible = element.closest(".grid");
    if (!(collapsible instanceof HTMLElement)) {
      throw new Error("Expected hook detail to be inside AnimatedCollapsible");
    }
    return collapsible;
  }

  it("reads a hook without output as a static row with its name and duration", () => {
    render(<HookRow hook={makeHook({ toolName: "Bash" })} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Ran hook").parentElement).toHaveTextContent(/^Ran hookSessionStart:startupon Bash32ms$/);
  });

  it("reads a blocked hook as blocked in its meta without error colors", () => {
    render(<HookRow hook={makeHook({ didBlock: true, durationMs: 1_200, outputLines: ["denied"], fullOutput: ["denied"] })} />);

    const row = screen.getByRole("button", { name: /SessionStart:startup/ });
    expect(within(row).getByText("blocked · 1.2s")).toHaveClass("text-muted");
    expect(screen.getByText("denied")).toHaveClass("text-ink/75");
  });

  it("renders expanded output at narrative text size", async () => {
    const user = userEvent.setup();
    render(<HookRow hook={makeHook({ outputLines: ["startup ok"], fullOutput: ["startup ok"] })} />);

    const detail = screen.getByText("startup ok");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(detail).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });

  it("previews live output lines and expands to full output", async () => {
    const user = userEvent.setup();
    render(
      <HookRow
        hook={makeHook({
          outputLines: ["preview line"],
          fullOutput: ["preview line", "full line"],
        })}
      />,
    );

    const detail = screen.getByText("preview line");
    expect(screen.getByText("full line")).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });

  it("renders persisted hook detail after expansion when stdout is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <HookRow
        hook={makeHook({
          outputLines: ["phase: stop", "tool: Bash", "blocked: yes"],
          fullOutput: ["phase: stop", "tool: Bash", "blocked: yes"],
          detailLines: ["phase: stop", "tool: Bash", "blocked: yes"],
          didBlock: true,
        })}
      />,
    );

    const detail = screen.getByText(/phase: stop/);
    expect(screen.getByText(/tool: Bash/)).toHaveClass("text-sm");
    expect(screen.getByText(/blocked: yes/)).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });
});
