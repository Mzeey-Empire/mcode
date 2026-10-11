import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProviderStatus } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { deriveProviderBellRows } from "@/features/providers/provider-bell-rows";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { ProvidersBell } from "../ProvidersBell";

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));
vi.mock("@/features/providers/sign-in", () => ({ signInToProvider: signInMock }));

// Local wall-clock times, so the expected "HH:MM" holds in any machine timezone.
const NOW = new Date(2026, 0, 1, 15, 0);
const FOUR_PM = new Date(2026, 0, 1, 16, 0).toISOString();

function status(providerId: ProviderStatus["providerId"], overrides: Partial<ProviderStatus>): ProviderStatus {
  return { providerId, auth: { state: "signed_in" }, rateLimit: null, checkedAt: NOW.toISOString(), ...overrides };
}

const DEVIN_SIGNED_OUT = status("devin", {
  auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["devin", "auth", "login"] } },
});

function serve(statuses: ProviderStatus[]) {
  useProviderStatusStore.setState({ statuses });
  vi.mocked(mockTransport.listProviderStatus).mockResolvedValue(statuses);
}

function openBell() {
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  return screen.findByTestId("providers-popover");
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.mocked(mockTransport.listProviderStatus).mockClear();
  vi.mocked(mockTransport.getProviderUsage).mockClear();
  signInMock.mockClear();
  useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
});

afterEach(() => {
  vi.useRealTimers();
  useProviderStatusStore.setState({ statuses: [] });
  useWorkspaceStore.setState({ activeWorkspaceId: null });
});

describe("ProvidersBell", () => {
  it("shows only the header and no dot when nothing needs attention", async () => {
    serve([status("claude", {})]);
    render(<ProvidersBell />);

    expect(screen.queryByTestId("providers-bell-dot")).toBeNull();
    const popover = await openBell();
    expect(within(popover).getByText("Providers")).toBeInTheDocument();
    expect(within(popover).queryAllByRole("listitem")).toHaveLength(0);
    expect(mockTransport.listProviderStatus).toHaveBeenCalledWith(false);
    expect(mockTransport.getProviderUsage).not.toHaveBeenCalled();
  });

  it("is named exactly Providers", () => {
    serve([DEVIN_SIGNED_OUT]);
    render(<ProvidersBell />);
    expect(screen.getByRole("button", { name: "Providers" })).toHaveAccessibleName("Providers");
  });

  it("lists a signed-out Devin with a Sign in action that runs its login command", async () => {
    serve([DEVIN_SIGNED_OUT]);
    render(<ProvidersBell />);

    expect(screen.getByTestId("providers-bell-dot")).toBeInTheDocument();
    const popover = await openBell();
    expect(within(popover).getByText("Devin")).toBeInTheDocument();
    expect(within(popover).getByText("Signed out · threads on Devin can't start")).toBeInTheDocument();
    fireEvent.click(within(popover).getByRole("button", { name: "Sign in" }));
    expect(signInMock).toHaveBeenCalledWith(["devin", "auth", "login"]);
    expect(mockTransport.getProviderUsage).not.toHaveBeenCalled();
  });

  it("re-checks past the cache when opened while a provider reads signed out", async () => {
    serve([DEVIN_SIGNED_OUT]);
    render(<ProvidersBell />);
    await openBell();
    expect(mockTransport.listProviderStatus).toHaveBeenCalledWith(true);
  });

  it("enables Sign in without an open project, runs the row's login command and closes the popover", async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    serve([DEVIN_SIGNED_OUT]);
    render(<ProvidersBell />);

    const signIn = within(await openBell()).getByRole("button", { name: "Sign in" });
    expect(signIn).not.toHaveAttribute("aria-disabled");
    expect(signIn).toBeEnabled();
    fireEvent.click(signIn);
    expect(signInMock).toHaveBeenCalledWith(["devin", "auth", "login"]);
    await waitFor(() => expect(screen.queryByTestId("providers-popover")).toBeNull());
  });

  it("describes rate limits with their label and local reset time", async () => {
    serve([
      status("claude", { rateLimit: { resetsAt: FOUR_PM, limitType: "five_hour" } }),
      status("codex", { rateLimit: { resetsAt: null, limitType: null } }),
    ]);
    render(<ProvidersBell />);

    const popover = await openBell();
    expect(within(popover).getByText("5-hour limit reached · resets 16:00")).toHaveClass("text-muted");
    expect(within(popover).getByText("Rate limited")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});

describe("deriveProviderBellRows", () => {
  it("drops past limits and unknown auth, and ranks signed out above rate limited", () => {
    const rows = deriveProviderBellRows([
      status("codex", { rateLimit: { resetsAt: FOUR_PM, limitType: "seven_day" } }),
      status("cursor", { rateLimit: { resetsAt: new Date(2026, 0, 1, 14, 0).toISOString(), limitType: null } }),
      status("copilot", { auth: { state: "unknown" } }),
      { ...DEVIN_SIGNED_OUT, rateLimit: { resetsAt: FOUR_PM, limitType: null } },
    ], NOW);

    expect(rows.map((row) => [row.providerId, row.kind, row.detail])).toEqual([
      ["devin", "signed_out", "Signed out · threads on Devin can't start"],
      ["codex", "rate_limited", "Weekly limit reached · resets 16:00"],
    ]);
  });

  it("shows an unrecognised limit type as sent, and a null type as Rate limited", () => {
    const rows = deriveProviderBellRows([
      status("claude", { rateLimit: { resetsAt: FOUR_PM, limitType: "opus_weekly" } }),
      status("codex", { rateLimit: { resetsAt: FOUR_PM, limitType: null } }),
    ], NOW);
    expect(rows.map((row) => row.detail)).toEqual([
      "opus_weekly reached · resets 16:00",
      "Rate limited · resets 16:00",
    ]);
  });
});
