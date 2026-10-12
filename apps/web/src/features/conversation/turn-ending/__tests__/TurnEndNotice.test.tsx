import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useTerminalStore } from "@/features/terminal";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { ThreadTurnEndNotice } from "../ThreadTurnEndNotice";
import { TurnEndNotice } from "../TurnEndNotice";
import type { FilledNotice } from "../turn-ending-notice";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

afterEach(() => {
  cleanup();
  useProviderStatusStore.setState({ statuses: [] });
  useTerminalStore.setState({ terminals: {}, ptyToThread: {}, terminalPanelByThread: {} });
});

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
  primary: { action: "retry_at", label: "Retry at 14:05" },
};

const INTERRUPTED: FilledNotice = {
  style: "filled",
  icon: "interrupted",
  title: "Interrupted",
  detail: "Mcode closed while Codex was working",
  primary: { action: "resume", label: "Resume" },
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

  it("calls the Resume handler on an interrupted notice", () => {
    const resume = vi.fn();
    render(<TurnEndNotice notice={INTERRUPTED} actions={{ retry: vi.fn(), resume }} />);
    expect(screen.getByRole("status")).toHaveTextContent("InterruptedMcode closed while Codex was working");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("shows why the last action failed", () => {
    render(<TurnEndNotice notice={FAILED} actions={{ retry: vi.fn() }} error="The turn is no longer the latest." />);
    expect(screen.getByRole("alert").textContent).toBe("The turn is no longer the latest.");
  });
});

describe("ThreadTurnEndNotice", () => {
  const SIGNED_OUT_NOTICE: FilledNotice = {
    style: "filled",
    icon: "failed",
    title: "Claude is signed out",
    detail: "Threads on Claude can't run until you sign in",
    primary: { action: "sign_in", label: "Sign in" },
  };

  it("runs the provider's sign-in command from the status store when Sign in is clicked", () => {
    vi.mocked(mockTransport.terminalWrite).mockClear();
    useProviderStatusStore.setState({ statuses: [{
      providerId: "claude",
      auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["claude", "/login"] } },
      cli: null, rateLimit: null, newModels: [], checkedAt: "2026-10-11T12:00:00.000Z",
    }] });
    useTerminalStore.getState().addTerminal("home", "pty-home-live", "pwsh", { state: "running" });

    render(<ThreadTurnEndNotice threadId="thread-1" turnId="turn-1" providerId="claude" notice={SIGNED_OUT_NOTICE} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mockTransport.terminalWrite).toHaveBeenCalledWith("pty-home-live", "claude /login\r");
  });

  it("hides Sign in when the thread's provider is unknown", () => {
    render(<ThreadTurnEndNotice threadId="thread-1" turnId="turn-1" providerId={null} notice={SIGNED_OUT_NOTICE} />);

    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("retries the notice's turn", () => {
    vi.mocked(mockTransport.retryErroredTurn).mockClear();
    render(<ThreadTurnEndNotice threadId="thread-1" turnId="turn-1" providerId="claude" notice={FAILED} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(mockTransport.retryErroredTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1" });
  });
});
