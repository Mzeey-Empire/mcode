import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnEndNotice } from "../TurnEndNotice";
import type { FilledNotice } from "../turn-ending-notice";

afterEach(cleanup);

const FAILED: FilledNotice = {
  style: "filled",
  icon: "failed",
  title: "Codex stopped responding",
  detail: "Overloaded after 3 retries",
  details: "upstream said no\nturn exec1234",
  primary: { action: "retry", label: "Retry" },
};

const USAGE_LIMIT: FilledNotice = {
  style: "filled",
  icon: "usage_limit",
  title: "Codex usage limit reached",
  detail: "5-hour limit · resets 14:05",
  secondary: { action: "switch_model", label: "Switch model" },
  primary: { action: "retry_at", label: "Retry at 14:05", at: "2026-10-11T13:05:00.000Z" },
};

describe("TurnEndNotice", () => {
  it("renders a quiet notice as title and detail with no buttons", () => {
    render(<TurnEndNotice notice={{ style: "quiet", title: "Stopped by Mcode", detail: "Mcode couldn't answer an approval request" }} />);
    expect(screen.getByTestId("turn-end-notice").textContent).toBe("Stopped by McodeMcode couldn't answer an approval request");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("calls the Retry handler", () => {
    const retry = vi.fn();
    render(<TurnEndNotice notice={FAILED} actions={{ retry }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("disables Retry while the request is pending", () => {
    render(<TurnEndNotice notice={FAILED} actions={{ retry: vi.fn() }} pending />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("toggles the raw details", () => {
    render(<TurnEndNotice notice={FAILED} />);
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/turn exec1234/)).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/turn exec1234/).textContent).toBe("upstream said no\nturn exec1234");

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByText(/turn exec1234/)).toBeNull();
  });

  it("copies the exact raw details", async () => {
    // userEvent installs its own clipboard, so read back what was copied.
    const user = userEvent.setup();
    render(<TurnEndNotice notice={FAILED} />);

    await user.click(screen.getByRole("button", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: "Copy details" }));

    await expect(navigator.clipboard.readText()).resolves.toBe(FAILED.details);
  });

  it("announces a filled notice politely and a quiet one not at all", () => {
    const { unmount } = render(<TurnEndNotice notice={FAILED} />);
    expect(screen.getByRole("status")).toHaveTextContent("Codex stopped responding");
    unmount();

    render(<TurnEndNotice notice={{ style: "quiet", title: "You stopped" }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders only the actions that have handlers", () => {
    render(<TurnEndNotice notice={USAGE_LIMIT} actions={{ retry: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry at 14:05" })).toBeNull();
    expect(screen.getByText("Codex usage limit reached")).toBeInTheDocument();
  });

  it("hands the Switch model button to the picker that wraps it", () => {
    const opened = vi.fn();
    render(<TurnEndNotice notice={USAGE_LIMIT} actions={{ switch_model: (trigger) => <span onClick={opened}>{trigger}</span> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("disables Switch model while a request is pending", () => {
    render(<TurnEndNotice notice={USAGE_LIMIT} actions={{ switch_model: (trigger) => trigger }} pending />);
    expect(screen.getByRole("button", { name: "Switch model" })).toBeDisabled();
  });

  it("shows why the last action failed", () => {
    render(<TurnEndNotice notice={FAILED} actions={{ retry: vi.fn() }} error="The turn is no longer the latest." />);
    expect(screen.getByRole("alert").textContent).toBe("The turn is no longer the latest.");
  });
});
