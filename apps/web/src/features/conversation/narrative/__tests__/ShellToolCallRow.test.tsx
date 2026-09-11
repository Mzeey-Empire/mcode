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

  it("opens during execution and closes on completion", () => {
    const { rerender } = render(<ShellToolCallRow toolCall={call} />);
    expect(screen.getByRole("button", { name: /^Running command/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("hello")).toBeVisible();
    rerender(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);
    const toggle = screen.getByRole("button", { name: /^Ran command/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle).toHaveAttribute("aria-controls");
    fireEvent.click(screen.getByRole("button", { name: /^Ran command/ }));
    expect(screen.getByRole("button", { name: /^Ran command/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a completed transcript through its collapse transition", () => {
    const { container, rerender } = render(<ShellToolCallRow toolCall={call} />);
    rerender(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);
    const toggle = screen.getByRole("button", { name: /^Ran command/ });
    const panel = container.querySelector<HTMLElement>('[aria-label="Shell output"]');
    expect(panel).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-controls", panel?.id);
    const collapsible = container.querySelector(".grid");
    if (!collapsible) throw new Error("Expected shell collapsible.");
    fireEvent.transitionEnd(collapsible, { propertyName: "grid-template-rows" });
    expect(container.querySelector('[aria-label="Shell output"]')).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("unmounts a completed transcript immediately when reduced motion is enabled", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    const { rerender } = render(<ShellToolCallRow toolCall={call} />);

    rerender(<ShellToolCallRow toolCall={{ ...call, isComplete: true }} />);

    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Ran command/ })).not.toHaveAttribute("aria-controls");
    matchMedia.mockRestore();
  });

  it("honors a manual close when output changes", () => {
    const { rerender } = render(<ShellToolCallRow toolCall={call} />);
    fireEvent.click(screen.getByRole("button", { name: /^Running command/ }));
    rerender(<ShellToolCallRow toolCall={{ ...call, output: "more output" }} />);
    expect(screen.getByRole("button", { name: /^Running command/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("uses the Shell transcript and active animation for a running narrative command", () => {
    const { container } = render(<ActiveToolRow toolCall={call} />);
    expect(screen.getByRole("region", { name: "Shell output" })).toBeVisible();
    expect(screen.getByText("Shell", { exact: true })).toBeVisible();
    expect(container.querySelector('[data-startup-activity-shimmer-text="Running command"]')).not.toBeNull();
  });
});

describe("Shell transcript controls", () => {
  it("copies command and output separately without changing whitespace", async () => {
    const user = userEvent.setup();
    const command = "printf 'a  b'\n\techo end";
    const output = "a  b\n\tend\n";
    render(<ShellToolCallRow toolCall={{ ...call, toolInput: { command }, output }} />);
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
    const toggle = screen.getByRole("button", { name: /^(Running|Ran) command/ });
    if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
    const panel = screen.getByRole("region", { name: "Shell output" });
    expect(within(panel).getByText(label)).toBeVisible();
    expect(within(panel).queryByText(label === "Success" ? "Running" : "Success")).toBeNull();
  });

  it("renders output-only content without a synthetic command or command copy action", async () => {
    const user = userEvent.setup();
    render(<ShellToolCallRow toolCall={{ ...call, toolInput: {}, output: "Completion event capture ready" }} />);
    expect(screen.getByText("plaintext")).toBeVisible();
    expect(screen.queryByText("Command unavailable")).toBeNull();
    expect(screen.queryByText("$")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(await navigator.clipboard.readText()).toBe("Completion event capture ready");
  });
});
