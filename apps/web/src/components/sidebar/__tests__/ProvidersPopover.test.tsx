import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProviderCliUpdate, ProviderStatus } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { deriveProviderBellRows, type ProviderBellRow } from "@/features/providers/provider-bell-rows";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { useUiStore } from "@/stores/uiStore";
import { ProvidersBell } from "../ProvidersBell";

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));
vi.mock("@/features/providers/sign-in", () => ({ signInToProvider: signInMock }));

// Local wall-clock times, so the expected "HH:MM" holds in any machine timezone.
const NOW = new Date(2026, 0, 1, 15, 0);
const FOUR_PM = new Date(2026, 0, 1, 16, 0).toISOString();

function status(providerId: ProviderStatus["providerId"], overrides: Partial<ProviderStatus>): ProviderStatus {
  return { providerId, auth: { state: "signed_in" }, cli: null, rateLimit: null, newModels: [], checkedAt: NOW.toISOString(), ...overrides };
}

function codexCli(update: ProviderCliUpdate): ProviderStatus {
  return status("codex", { cli: { installed: "0.41.2", managedBy: "user", latest: "0.48.0", update } });
}

function summarize(row: ProviderBellRow) {
  return [row.providerId, row.kind, row.kind === "cli_update" ? row.update.state : row.detail];
}

const CLAUDE_NEW_MODEL = status("claude", {
  newModels: [{ modelId: "claude-fable-5-1", label: "Fable 5.1" }, { modelId: "claude-opus-5-5", label: "Opus 5.5" }],
});

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
  vi.mocked(mockTransport.updateProviderCli).mockReset();
  vi.mocked(mockTransport.getProviderUsage).mockClear();
  signInMock.mockClear();
  useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
});

afterEach(() => {
  vi.useRealTimers();
  useProviderStatusStore.setState({ statuses: [] });
  useWorkspaceStore.setState({ activeWorkspaceId: null, pendingNewThread: false });
  useComposerDraftStore.setState({ pendingModel: null });
});

describe("ProvidersBell", () => {
  it("shows the header and a No notifications empty state, with no dot, when nothing needs attention", async () => {
    serve([status("claude", {})]);
    render(<ProvidersBell />);

    expect(screen.queryByTestId("providers-bell-dot")).toBeNull();
    const popover = await openBell();
    expect(within(popover).getByText("Providers")).toBeInTheDocument();
    expect(within(popover).getByRole("status")).toHaveTextContent("No notifications");
    expect(within(popover).queryAllByRole("listitem")).toHaveLength(0);
    expect(mockTransport.listProviderStatus).toHaveBeenCalledWith(false);
    expect(mockTransport.getProviderUsage).not.toHaveBeenCalled();
  });

  it("lists a signed-out Devin with a Sign in action that runs its login command", async () => {
    serve([DEVIN_SIGNED_OUT]);
    render(<ProvidersBell />);

    expect(screen.getByTestId("providers-bell-dot")).toBeInTheDocument();
    const popover = await openBell();
    expect(within(popover).getByText("Devin")).toBeInTheDocument();
    expect(within(popover).getByText("Signed out · threads on Devin can't start")).toBeInTheDocument();
    expect(within(popover).queryByText("No notifications")).toBeNull();
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
    expect(within(popover).getByText("5-hour limit reached · resets 16:00")).toBeInTheDocument();
    expect(within(popover).getByText("Rate limited")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});

describe("ProvidersBell new models", () => {
  it("announces the newest model with Try, which acknowledges it and starts a new thread on it", async () => {
    vi.mocked(mockTransport.acknowledgeProviderModels).mockClear();
    useUiStore.setState({ primarySurface: "pullRequests" });
    serve([CLAUDE_NEW_MODEL]);
    render(<ProvidersBell />);

    expect(screen.getByTestId("providers-bell-dot")).toBeInTheDocument();
    const popover = await openBell();
    expect(within(popover).getByText("Fable 5.1 is new in the model menu")).toBeInTheDocument();
    fireEvent.click(within(popover).getByRole("button", { name: "Try" }));

    expect(mockTransport.acknowledgeProviderModels).toHaveBeenCalledWith("claude");
    expect(useComposerDraftStore.getState().pendingModel).toEqual({ provider: "claude", modelId: "claude-fable-5-1" });
    expect(useWorkspaceStore.getState().pendingNewThread).toBe(true);
    expect(useUiStore.getState().primarySurface).toBe("chat");
    await waitFor(() => expect(screen.queryByTestId("providers-popover")).toBeNull());
  });
});

describe("ProvidersBell CLI updates", () => {
  it("offers an update, shows progress from the status push, and clears the row when the update lands", async () => {
    serve([codexCli({ state: "available", target: "0.48.0" })]);
    let finish: (status: ProviderStatus) => void = () => {};
    vi.mocked(mockTransport.updateProviderCli).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ProvidersBell />);

    expect(screen.getByTestId("providers-bell-dot")).toBeInTheDocument();
    const popover = await openBell();
    expect(within(popover).getByText("Codex")).toBeInTheDocument();
    expect(within(popover).getByText("CLI")).toBeInTheDocument();
    expect(within(popover).getByText("0.48.0")).toBeInTheDocument();
    expect(within(popover).getByText("available · you have")).toBeInTheDocument();
    expect(within(popover).getByText("0.41.2")).toBeInTheDocument();

    fireEvent.click(within(popover).getByRole("button", { name: "Update" }));
    expect(mockTransport.updateProviderCli).toHaveBeenCalledWith("codex");
    // The server's progress arrives as a providers.statusChanged push while the RPC is still pending.
    act(() => useProviderStatusStore.getState().apply(codexCli({ state: "running", target: "0.48.0" })));
    expect(within(popover).getByRole("img", { name: "Updating Codex CLI" })).toBeInTheDocument();
    expect(within(popover).getByText("Updating to")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: "Update" })).toBeNull();

    await act(async () => finish(status("codex", { cli: { installed: "0.48.0", managedBy: "user", latest: "0.48.0", update: { state: "none" } } })));
    expect(within(popover).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByTestId("providers-bell-dot")).toBeNull();
  });

  it("turns a running update into its failure reason with Retry when the update fails", async () => {
    serve([codexCli({ state: "running", target: "0.48.0" })]);
    render(<ProvidersBell />);
    const popover = await openBell();

    act(() => useProviderStatusStore.getState().apply(codexCli({ state: "failed", target: "0.48.0", reason: "npm ERR! code E404" })));
    expect(within(popover).getByText("npm ERR! code E404")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(popover).queryByRole("img", { name: "Updating Codex CLI" })).toBeNull();
  });

  it("omits the installed version when the CLI did not report one", async () => {
    serve([status("codex", { cli: { installed: null, managedBy: "user", latest: "0.48.0", update: { state: "available", target: "0.48.0" } } })]);
    render(<ProvidersBell />);

    const popover = await openBell();
    expect(within(popover).getByText("available")).toBeInTheDocument();
    expect(within(popover).queryByText("available · you have")).toBeNull();
  });

  it("shows a failed update's reason with a Retry that runs the update again", async () => {
    const reason = "npm ERR! code EACCES";
    serve([codexCli({ state: "failed", target: "0.48.0", reason })]);
    vi.mocked(mockTransport.updateProviderCli).mockResolvedValue(codexCli({ state: "failed", target: "0.48.0", reason }));
    render(<ProvidersBell />);

    const popover = await openBell();
    expect(within(popover).getByText(reason)).toBeInTheDocument();
    fireEvent.click(within(popover).getByRole("button", { name: "Retry" }));
    expect(mockTransport.updateProviderCli).toHaveBeenCalledWith("codex");
  });

  it("keeps the row when the update request itself fails", async () => {
    serve([codexCli({ state: "available", target: "0.48.0" })]);
    vi.mocked(mockTransport.updateProviderCli).mockRejectedValue(new Error("socket closed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ProvidersBell />);

    const popover = await openBell();
    fireEvent.click(within(popover).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(within(popover).getByRole("button", { name: "Update" })).toBeInTheDocument();
    consoleError.mockRestore();
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

    expect(rows.map(summarize)).toEqual([
      ["devin", "signed_out", "Signed out · threads on Devin can't start"],
      ["codex", "rate_limited", "Weekly limit reached · resets 16:00"],
    ]);
  });

  it("ranks a new model below sign-in and rate-limit problems, for one provider and across rows", () => {
    const rows = deriveProviderBellRows([
      CLAUDE_NEW_MODEL,
      status("codex", { rateLimit: { resetsAt: FOUR_PM, limitType: null }, newModels: [{ modelId: "gpt-7", label: "GPT-7" }] }),
      { ...DEVIN_SIGNED_OUT, newModels: [{ modelId: "devin-2", label: "Devin 2" }] },
    ], NOW);

    expect(rows.map((row) => [...summarize(row), row.kind === "new_model" ? row.tryModelId : undefined])).toEqual([
      ["devin", "signed_out", "Signed out · threads on Devin can't start", undefined],
      ["codex", "rate_limited", "Rate limited · resets 16:00", undefined],
      ["claude", "new_model", "Fable 5.1 is new in the model menu", "claude-fable-5-1"],
    ]);
  });

  it("shows an unrecognised limit type as sent, and a null type as Rate limited", () => {
    const rows = deriveProviderBellRows([
      status("claude", { rateLimit: { resetsAt: FOUR_PM, limitType: "opus_weekly" } }),
      status("codex", { rateLimit: { resetsAt: FOUR_PM, limitType: null } }),
    ], NOW);
    expect(rows.map((row) => summarize(row)[2])).toEqual([
      "opus_weekly reached · resets 16:00",
      "Rate limited · resets 16:00",
    ]);
  });

  it("sorts rows by kind, puts a running update after actionable ones, and keeps one row per provider", () => {
    const rows = deriveProviderBellRows([
      status("opencode", { cli: { installed: "1.0.0", managedBy: "user", latest: "1.1.0", update: { state: "running", target: "1.1.0" } } }),
      status("claude", { rateLimit: { resetsAt: FOUR_PM, limitType: null } }),
      codexCli({ state: "available", target: "0.48.0" }),
      { ...DEVIN_SIGNED_OUT, cli: { installed: "1.0.0", managedBy: "user", latest: "1.1.0", update: { state: "available", target: "1.1.0" } } },
      status("cursor", {
        rateLimit: { resetsAt: FOUR_PM, limitType: null },
        cli: { installed: "1.0.0", managedBy: "user", latest: "1.1.0", update: { state: "available", target: "1.1.0" } },
      }),
    ], NOW);

    expect(rows.map(summarize)).toEqual([
      ["devin", "signed_out", "Signed out · threads on Devin can't start"],
      ["claude", "rate_limited", "Rate limited · resets 16:00"],
      ["cursor", "rate_limited", "Rate limited · resets 16:00"],
      ["codex", "cli_update", "available"],
      ["opencode", "cli_update", "running"],
    ]);
  });

  it("shows no row for a CLI with no update, such as Mcode's bundled Claude", () => {
    const rows = deriveProviderBellRows([
      status("claude", { cli: { installed: null, managedBy: "mcode", latest: null, update: { state: "none" } } }),
      codexCli({ state: "none" }),
    ], NOW);
    expect(rows).toEqual([]);
  });
});
