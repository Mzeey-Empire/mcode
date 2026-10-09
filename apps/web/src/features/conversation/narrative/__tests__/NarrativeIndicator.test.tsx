import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { NarrativeIndicator } from "../NarrativeIndicator";
import type { RunStatus } from "../run-status";

const lint: RunStatus = { label: "Running bun run lint", icon: "layers" };
const stopping: RunStatus = { label: "Stopping", icon: "spinner" };

describe("NarrativeIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads steps, the status label and a clock, with no parens or shimmer", () => {
    const { container } = render(
      <NarrativeIndicator stepCount={3} status={lint} startTime={Date.now() - 23000} isAgentRunning />,
    );
    expect(screen.getByText("3 steps ·")).toBeInTheDocument();
    expect(screen.getByText("Running bun run lint")).toBeInTheDocument();
    expect(screen.getByText("0:23")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[()]/);
    expect(container.querySelector("[data-startup-activity-shimmer-text]")).toBeNull();
    expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  });

  it("shows steps only once the count is positive and never counts subagents", () => {
    const props = { status: { label: "Thinking", icon: "layers" } as RunStatus, startTime: Date.now(), isAgentRunning: true };
    const { rerender, container } = render(<NarrativeIndicator {...props} stepCount={0} />);
    expect(screen.queryByText(/steps?/)).not.toBeInTheDocument();
    rerender(<NarrativeIndicator {...props} stepCount={1} />);
    expect(screen.getByText("1 step ·")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/subagent/i);
  });

  it("draws animated layers for working rows and a spinner for holding rows", () => {
    const { rerender, container } = render(<NarrativeIndicator stepCount={1} status={lint} isAgentRunning />);
    expect(container.querySelector('svg.stacked-layers-animated[data-run-status-icon="layers"]')).not.toBeNull();
    expect(container.querySelector('[data-run-status-icon="spinner"]')).toBeNull();

    rerender(<NarrativeIndicator stepCount={1} status={stopping} isAgentRunning />);
    expect(container.querySelector('[data-run-status-icon="spinner"] .spinner-tail-fade')).not.toBeNull();
    expect(container.querySelector("svg.stacked-layers-animated")).toBeNull();
  });

  it("fades out with the last running label, then renders nothing", () => {
    const { rerender, container } = render(<NarrativeIndicator stepCount={3} status={lint} isAgentRunning />);

    rerender(<NarrativeIndicator stepCount={3} status={{ label: "Thinking", icon: "layers" }} isAgentRunning={false} />);
    const exiting = container.querySelector('[data-state="exiting"]');
    expect(exiting?.classList.contains("narrative-indicator-exit")).toBe(true);
    expect(exiting).toHaveTextContent("Running bun run lint");
    expect(exiting).not.toHaveTextContent("Done");
    expect(exiting?.querySelector("svg")).not.toBeNull();
    expect(exiting?.querySelector(".stacked-layers-animated")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("renders nothing when mounted with the agent already stopped", () => {
    const { container } = render(<NarrativeIndicator stepCount={3} status={lint} isAgentRunning={false} />);
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("returns to the running state when a new turn starts mid-exit", () => {
    const { rerender, container } = render(<NarrativeIndicator stepCount={3} status={lint} isAgentRunning />);
    rerender(<NarrativeIndicator stepCount={3} status={lint} isAgentRunning={false} />);
    expect(container.querySelector('[data-state="exiting"]')).not.toBeNull();

    rerender(<NarrativeIndicator stepCount={0} status={stopping} isAgentRunning />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-state="running"]')).toHaveTextContent("Stopping");
  });

  it("keeps file facts out of the narrative status line", () => {
    const misplacedFileEffects = {
      fileEffects: { revision: 1, fileCount: 1, additions: 4, deletions: 2, effects: [] },
    };
    render(<NarrativeIndicator stepCount={2} status={lint} isAgentRunning {...misplacedFileEffects} />);
    expect(screen.queryByText("1 file changed")).not.toBeInTheDocument();
    expect(screen.queryByText("+4")).not.toBeInTheDocument();
    expect(screen.queryByText("−2")).not.toBeInTheDocument();
  });
});
