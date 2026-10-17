import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserCertificateState } from "@mcode/contracts";
import type { BrowserSurfaceIdentity } from "../../browser-surfaces";

vi.mock("../BrowserSurfaceHostRoot", () => ({
  browserSurfaceHost: { getSnapshot: () => ({ generation: 7 }) },
}));

import { useToastStore } from "@/stores/toastStore";
import { useBrowserCertificate } from "../useBrowserCertificate";

const bridge = { state: vi.fn(), proceed: vi.fn(), revoke: vi.fn() };

function tab(tabId: string): BrowserSurfaceIdentity {
  return { workspaceId: "workspace-1", scope: { kind: "thread", id: "thread-1" }, tabId };
}

// The hook keys its effect on identity, so callers memoize it; a fresh object per render would loop.
const TAB_A = tab("a");

const untrusted: BrowserCertificateState = {
  failure: {
    host: "localhost",
    error: "net::ERR_CERT_AUTHORITY_INVALID",
    fingerprint: "sha256/AbCd",
    subjectName: "localhost",
    issuerName: "localhost",
    validStart: 1_700_000_000,
    validExpiry: 1_800_000_000,
  },
  exceptionInUse: false,
};
const trusted: BrowserCertificateState = { failure: null, exceptionInUse: true };

describe("useBrowserCertificate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.desktopBridge = { preview: { certificate: bridge } } as unknown as typeof window.desktopBridge;
    useToastStore.setState({ toasts: [] });
  });

  it("never shows another tab's certificate while this tab's read is in flight", async () => {
    bridge.state.mockResolvedValueOnce(untrusted);
    const { result, rerender } = renderHook(
      ({ identity }) => useBrowserCertificate(identity, "rev", vi.fn()),
      { initialProps: { identity: tab("a") } },
    );
    await waitFor(() => expect(result.current.state).toEqual(untrusted));

    bridge.state.mockReturnValueOnce(new Promise(() => {}));
    rerender({ identity: tab("b") });

    expect(result.current.state).toBeNull();
  });

  it("re-reads when the revision changes on the same tab", async () => {
    const identity = tab("a");
    bridge.state.mockResolvedValueOnce(untrusted).mockResolvedValueOnce(trusted);
    const { result, rerender } = renderHook(
      ({ revision }) => useBrowserCertificate(identity, revision, vi.fn()),
      { initialProps: { revision: "failed" } },
    );
    await waitFor(() => expect(result.current.state).toEqual(untrusted));

    rerender({ revision: "loaded" });

    await waitFor(() => expect(result.current.state).toEqual(trusted));
  });

  it("reloads after the desktop accepts the exception", async () => {
    const reload = vi.fn();
    bridge.state.mockResolvedValue(untrusted);
    bridge.proceed.mockResolvedValue(true);
    const { result } = renderHook(() => useBrowserCertificate(TAB_A, "rev", reload));

    await act(async () => { await result.current.proceed("sha256/AbCd"); });

    expect(bridge.proceed).toHaveBeenCalledWith({ identity: TAB_A, generation: 7 }, "sha256/AbCd");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("toasts instead of reloading when the desktop refuses a stale fingerprint", async () => {
    const reload = vi.fn();
    bridge.state.mockResolvedValue(untrusted);
    bridge.proceed.mockResolvedValue(false);
    const { result } = renderHook(() => useBrowserCertificate(TAB_A, "rev", reload));

    await act(async () => { await result.current.proceed("sha256/stale"); });

    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.state).toHaveBeenCalledTimes(2));
    expect(useToastStore.getState().toasts[0]).toMatchObject({ title: "Couldn't trust this certificate" });
  });

  it("reloads after the exception is revoked", async () => {
    const reload = vi.fn();
    bridge.state.mockResolvedValue(trusted);
    bridge.revoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useBrowserCertificate(TAB_A, "rev", reload));

    await act(async () => { await result.current.revoke(); });

    expect(bridge.revoke).toHaveBeenCalledWith({ identity: TAB_A, generation: 7 });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
