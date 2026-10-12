import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentModelState, type AgentModelState, type ProviderAuth, type ProviderStatus } from "@mcode/contracts";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { useTurnEndings } from "../useTurnEndings";

const THREAD = "thread-1";
const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, second)).toISOString();
const SIGNED_OUT: ProviderAuth = { state: "signed_out", signIn: { kind: "terminal", argv: ["claude", "/login"] } };

function authFailedClaudeThread(): AgentModelState {
  const state = createAgentModelState();
  state.threads[THREAD] = {
    id: THREAD, workspaceId: "workspace-1", rootThreadId: THREAD, providerId: "claude", providerIdentities: [],
    activityState: "Idle", conversationRevision: 1, rosterRevision: 0, createdAt: at(0), updatedAt: at(5),
  };
  state.turns.t1 = {
    id: "t1", threadId: THREAD, status: "Errored", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: at(0), providerStartedAt: at(0), endedAt: at(5),
    ending: { outcome: "errored", failure: { kind: "auth", provider: "claude", message: "401" } },
    createdAt: at(0), updatedAt: at(5),
  };
  state.items["item-u1"] = {
    id: "item-u1", threadId: THREAD, turnId: "t1", kind: "message", providerIdentities: [],
    payload: { projection: "message", message: { id: "u1", role: "user" } }, createdAt: at(0), updatedAt: at(0),
  };
  return state;
}

function status(providerId: ProviderStatus["providerId"], auth: ProviderAuth): ProviderStatus {
  return { providerId, auth, cli: null, rateLimit: null, newModels: [], checkedAt: at(10) };
}

function primaryLabel(state: AgentModelState) {
  const { result } = renderHook(() => useTurnEndings(THREAD, state));
  const notice = () => result.current.endingsByMessageId.u1?.view.notice;
  return () => {
    const current = notice();
    return current?.style === "filled" ? current.primary?.label : undefined;
  };
}

afterEach(() => {
  useProviderStatusStore.setState({ statuses: [] });
});

describe("useTurnEndings", () => {
  it("swaps Sign in for Retry when the provider's signed-out condition clears", () => {
    useProviderStatusStore.setState({ statuses: [status("claude", SIGNED_OUT)] });
    const label = primaryLabel(authFailedClaudeThread());
    expect(label()).toBe("Sign in");

    act(() => useProviderStatusStore.getState().apply(status("claude", { state: "signed_in" })));

    expect(label()).toBe("Retry");
  });

  it.each<[string, ProviderStatus[]]>([
    ["signed in", [status("claude", { state: "signed_in" })]],
    ["unknown", [status("claude", { state: "unknown" })]],
    ["not reported", []],
    ["only another provider signed out", [status("codex", SIGNED_OUT)]],
  ])("shows Retry when the thread's provider is %s", (_case, statuses) => {
    useProviderStatusStore.setState({ statuses });

    expect(primaryLabel(authFailedClaudeThread())()).toBe("Retry");
  });

  it("returns no endings without a thread", () => {
    const { result } = renderHook(() => useTurnEndings(null, authFailedClaudeThread()));

    expect(result.current).toEqual({ endingsByMessageId: {}, hiddenMessageIds: new Set() });
  });
});
