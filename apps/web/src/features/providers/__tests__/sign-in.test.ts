// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuth } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useTerminalStore } from "@/features/terminal";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { closeSignInTerminal, signInToProvider, signInToSignedOutProvider } from "../sign-in";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const ARGV = ["devin", "auth", "login"] as const;

beforeEach(() => {
  vi.mocked(mockTransport.terminalCreate).mockReset().mockResolvedValue({ ptyId: "pty-home-1", shell: "pwsh" });
  vi.mocked(mockTransport.terminalWrite).mockClear();
  vi.mocked(mockTransport.terminalKill).mockReset().mockResolvedValue(undefined);
  vi.mocked(mockTransport.listProviderStatus).mockClear();
  useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null, threads: [], workspaces: [] });
  useTerminalStore.setState({ terminals: {}, ptyToThread: {}, activeTerminalByScope: {} });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  useTerminalStore.setState({ terminals: {}, ptyToThread: {}, activeTerminalByScope: {} });
});

describe("signInToSignedOutProvider", () => {
  afterEach(() => {
    useProviderStatusStore.setState({ statuses: [] });
  });

  function seedClaude(auth: ProviderAuth) {
    useProviderStatusStore.setState({ statuses: [{
      providerId: "claude", auth, cli: null, rateLimit: null, newModels: [], checkedAt: "2026-10-11T12:00:00.000Z",
    }] });
  }

  it("types the signed-out provider's own sign-in command", async () => {
    seedClaude({ state: "signed_out", signIn: { kind: "terminal", argv: ["claude", "/login"] } });
    useTerminalStore.getState().addTerminal("home", "pty-home-live", "pwsh", { state: "running" });

    signInToSignedOutProvider("claude");

    await vi.waitFor(() => expect(mockTransport.terminalWrite).toHaveBeenCalledWith("pty-home-live", "claude /login\r"));
  });

  it("does nothing once the provider is no longer signed out", () => {
    seedClaude({ state: "signed_in" });

    signInToSignedOutProvider("claude");
    signInToSignedOutProvider("codex");

    expect(mockTransport.terminalCreate).not.toHaveBeenCalled();
    expect(mockTransport.terminalWrite).not.toHaveBeenCalled();
  });
});

describe("signInToProvider", () => {
  it("opens a home-scope terminal with no project and types the login command", async () => {
    signInToProvider(ARGV);

    await vi.waitFor(() => expect(mockTransport.terminalWrite).toHaveBeenCalledWith("pty-home-1", "devin auth login\r"));
    expect(mockTransport.terminalCreate).toHaveBeenCalledWith("home");
    expect(useTerminalStore.getState().terminals.home?.map(({ id }) => id)).toEqual(["pty-home-1"]);
    expect(useTerminalStore.getState().activeTerminalByScope.home).toBe("pty-home-1");
  });

  it("starts one shell when clicked again while the first is still being created", async () => {
    signInToProvider(ARGV);
    signInToProvider(ARGV);

    await vi.waitFor(() => expect(mockTransport.terminalWrite).toHaveBeenCalledTimes(1));
    expect(mockTransport.terminalCreate).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().terminals.home).toHaveLength(1);
  });

  it("types into the live home terminal instead of starting another shell", async () => {
    useTerminalStore.getState().addTerminal("home", "pty-home-live", "pwsh", { state: "running" });

    signInToProvider(["codex", "login"]);

    await vi.waitFor(() => expect(mockTransport.terminalWrite).toHaveBeenCalledWith("pty-home-live", "codex login\r"));
    expect(mockTransport.terminalCreate).not.toHaveBeenCalled();
  });
});

describe("closeSignInTerminal", () => {
  it("kills the home terminal, removes it, and re-checks provider status", async () => {
    useTerminalStore.getState().addTerminal("home", "pty-home-1", "pwsh", { state: "running" });

    await closeSignInTerminal();

    expect(mockTransport.terminalKill).toHaveBeenCalledWith("pty-home-1");
    expect(useTerminalStore.getState().terminals.home).toBeUndefined();
    expect(mockTransport.listProviderStatus).toHaveBeenCalledWith(true);
  });

  it("keeps the record and shows a failure when the kill fails", async () => {
    useTerminalStore.getState().addTerminal("home", "pty-home-1", "pwsh", { state: "running" });
    vi.mocked(mockTransport.terminalKill).mockRejectedValue(new Error("PTY host is unhealthy"));

    await closeSignInTerminal();

    expect(useTerminalStore.getState().terminals.home?.map(({ id }) => id)).toEqual(["pty-home-1"]);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ kind: "failed", title: "Couldn't close terminal", meta: "PTY host is unhealthy" }),
    );
  });
});
