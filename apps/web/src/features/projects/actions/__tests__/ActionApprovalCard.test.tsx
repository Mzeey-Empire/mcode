import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionApprovalCard } from "../ActionApprovalCard";

function renderCard(overrides: Partial<React.ComponentProps<typeof ActionApprovalCard>> = {}) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  render(
    <ActionApprovalCard
      actionName="web"
      script={"bun install\nbun run dev"}
      starting={false}
      error={null}
      onRun={onRun}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onRun, onCancel };
}

describe("ActionApprovalCard", () => {
  it("names the action, says where it comes from, and shows the whole command to review", () => {
    renderCard();

    expect(screen.getByText("Run web?")).toBeInTheDocument();
    expect(screen.getByText("This action comes from .mcode/environment.json in the repo. It runs once you approve it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Command to approve").textContent).toBe("bun install\nbun run dev");
  });

  it("runs on Run and cancels on Cancel", () => {
    const { onRun, onCancel } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("blocks a second Run while the first is starting", () => {
    const { onRun } = renderCard({ starting: true });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(onRun).not.toHaveBeenCalled();
  });

  it("announces an error", () => {
    renderCard({ error: "The command changed." });

    expect(screen.getByRole("alert")).toHaveTextContent("The command changed.");
  });
});
