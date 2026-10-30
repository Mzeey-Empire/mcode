import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("reads steps, the status label and a duration, with no parens or shimmer", () => {
    const { container } = render(
      <NarrativeIndicator stepCount={3} status={lint} startTime={Date.now() - 23000} />,
    );
    expect(screen.getByText("3 steps ·")).toBeInTheDocument();
    expect(screen.getByText("Running bun run lint")).toBeInTheDocument();
    expect(screen.getByText("23s")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[()]/);
    expect(container.querySelector("[data-startup-activity-shimmer-text]")).toBeNull();
    expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  });

  it("shows steps only once the count is positive and never counts subagents", () => {
    const props = { status: { label: "Thinking", icon: "layers" } as RunStatus, startTime: Date.now() };
    const { rerender, container } = render(<NarrativeIndicator {...props} stepCount={0} />);
    expect(screen.queryByText(/steps?/)).not.toBeInTheDocument();
    rerender(<NarrativeIndicator {...props} stepCount={1} />);
    expect(screen.getByText("1 step ·")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/subagent/i);
  });

  it("drops steps and the timer while the turn waits on the user", () => {
    render(
      <NarrativeIndicator stepCount={3} status={{ label: "Waiting for approval", icon: "dot" }} startTime={Date.now() - 23000} />,
    );
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.queryByText(/steps?/)).not.toBeInTheDocument();
    expect(screen.queryByText("23s")).not.toBeInTheDocument();
  });

  it("draws animated layers for working rows and a spinner for holding rows", () => {
    const { rerender, container } = render(<NarrativeIndicator stepCount={1} status={lint} />);
    expect(container.querySelector('[data-run-status-icon="layers"]')).not.toBeNull();
    expect(container.querySelector('[data-run-status-icon="spinner"]')).toBeNull();

    rerender(<NarrativeIndicator stepCount={1} status={stopping} />);
    expect(container.querySelector('[data-run-status-icon="spinner"]')).not.toBeNull();
    expect(container.querySelector('[data-run-status-icon="layers"]')).toBeNull();
  });

  it("keeps file facts out of the narrative status line", () => {
    const misplacedFileEffects = {
      fileEffects: { revision: 1, fileCount: 1, additions: 4, deletions: 2, effects: [] },
    };
    render(<NarrativeIndicator stepCount={2} status={lint} {...misplacedFileEffects} />);
    expect(screen.queryByText("1 file changed")).not.toBeInTheDocument();
    expect(screen.queryByText("+4")).not.toBeInTheDocument();
    expect(screen.queryByText("−2")).not.toBeInTheDocument();
  });
});
