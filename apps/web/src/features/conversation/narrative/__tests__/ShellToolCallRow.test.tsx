import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/transport/types";
import { ShellToolCallRow } from "../ShellToolCallRow";
import { ActiveToolRow } from "../ActiveToolRow";

const call: ToolCall = {
  id: "command", toolName: "Bash", toolInput: { command: "echo hello" },
  output: "hello", isError: false, isComplete: false,
};

describe("ShellToolCallRow automatic expansion", () => {
  it("does not construct a completed transcript before disclosure", () => {
    const { container } = render(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);
    const toggle = screen.getByRole("button", { name: /^Ran command/ });
    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    fireEvent.pointerEnter(screen.getByText("echo hello"));
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toHaveTextContent("echo hello");
    fireEvent.click(toggle);
    const panel = screen.getByRole("region", { name: "Shell output" });
    expect(panel).toBeVisible();
    expect(toggle).toHaveAttribute("aria-controls", panel.id);
  });

  it("stays collapsed while running until clicked", () => {
    render(<ShellToolCallRow toolCall={call} />);
    const toggle = screen.getByRole("button", { name: /^Running command/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("region", { name: "Shell output" })).toBeVisible();
  });

  it("keeps a manual open when output arrives", () => {
    const { rerender } = render(<ShellToolCallRow toolCall={{ ...call, output: null }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Running command/ }));
    rerender(<ShellToolCallRow toolCall={{ ...call, output: "more output" }} />);
    expect(screen.getByRole("button", { name: /^Running command/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("more output")).toBeVisible();
  });

  it("keeps a completed transcript through its collapse transition", () => {
    const { container } = render(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);
    const toggle = screen.getByRole("button", { name: /^Ran command/ });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    const panel = container.querySelector<HTMLElement>('[aria-label="Shell output"]');
    expect(panel).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-controls", panel?.id);
    const collapsible = container.querySelector(".grid");
    if (!collapsible) throw new Error("Expected shell collapsible.");
    fireEvent.transitionEnd(collapsible, { propertyName: "grid-template-rows" });
    expect(container.querySelector('[aria-label="Shell output"]')).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("unmounts a closed transcript immediately when reduced motion is enabled", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    render(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);
    const toggle = screen.getByRole("button", { name: /^Ran command/ });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-controls");
    matchMedia.mockRestore();
  });

  it("reads a finished command as duration then command", () => {
    render(<ShellToolCallRow toolCall={{ ...call, isComplete: true, durationMs: 2_000 }} />);
    expect(screen.getByRole("button", { name: /^Ran command/ })).toHaveTextContent(/^Ran command0:02echo hello$/);
  });

  it("reads a failed command as command then exit and duration", () => {
    render(<ShellToolCallRow toolCall={{ ...call, isComplete: true, isError: true, exitCode: 1, durationMs: 3_000 }} />);
    expect(screen.getByRole("button", { name: /^Ran command/ })).toHaveTextContent(/^Ran commandecho helloexit 1 · 0:03$/);
  });

  it("shows no duration for a running command", () => {
    render(<ActiveToolRow toolCall={{ ...call, durationMs: 4_000 }} />);
    expect(screen.getByRole("button", { name: /^Running command/ })).toHaveTextContent(/^Running commandecho hello$/);
  });
});

describe("Shell transcript controls", () => {
  it("copies command and output separately without changing whitespace", async () => {
    const user = userEvent.setup();
    const command = "printf 'a  b'\n\techo end";
    const output = "a  b\n\tend\n";
    render(<ShellToolCallRow toolCall={{ ...call, toolInput: { command }, output }} />);
    await user.click(screen.getByRole("button", { name: /^Running command/ }));
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe(command);
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(await navigator.clipboard.readText()).toBe(output);
    expect(screen.getAllByText("Copied")).toHaveLength(2);
  });

  it("reports a clipboard failure without claiming success and lets the user retry", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied"));
    render(<ShellToolCallRow toolCall={call} />);
    await user.click(screen.getByRole("button", { name: /^Running command/ }));
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    await waitFor(() => expect(screen.getByText("Copy failed. Try again.")).toBeInTheDocument());
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(await navigator.clipboard.readText()).toBe(call.output);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    write.mockRestore();
  });

  it.each([
    ["Running", { isComplete: false }],
    ["Success", { isComplete: true }],
    ["exit code 2", { isComplete: true, isError: true, exitCode: 2 }],
    ["cancelled", { isComplete: true, isCancelled: true }],
  ])("shows %s in the transcript footer", (label, state) => {
    render(<ShellToolCallRow toolCall={{ ...call, ...state }} />);
    fireEvent.click(screen.getByRole("button", { name: /^(Running|Ran) command/ }));
    const panel = screen.getByRole("region", { name: "Shell output" });
    expect(within(panel).getByText(label)).toBeVisible();
    expect(within(panel).queryByText(label === "Success" ? "Running" : "Success")).toBeNull();
  });

  it("renders output-only content without a synthetic command or command copy action", async () => {
    const user = userEvent.setup();
    render(<ShellToolCallRow toolCall={{ ...call, toolInput: {}, output: "Completion event capture ready" }} />);
    await user.click(screen.getByRole("button", { name: /^Running command/ }));
    expect(screen.getByText("plaintext")).toBeVisible();
    expect(screen.queryByText("Command unavailable")).toBeNull();
    expect(screen.queryByText("$")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(await navigator.clipboard.readText()).toBe("Completion event capture ready");
  });
});
