import { mockTransport } from "@/__tests__/mocks/transport";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProviderAvailability } from "@mcode/contracts/providers/availability";
import { useProviderAvailabilityStore } from "../providerAvailabilityStore";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

function row(partial: Partial<ProviderAvailability>): ProviderAvailability {
  return {
    id: "claude",
    enabled: true,
    hasAdapter: true,
    beta: false,
    comingSoon: false,
    capabilities: [],
    cli: { status: "found", resolvedPath: "/usr/local/bin/claude", configuredPath: "" },
    ...partial,
  };
}

describe("providerAvailabilityStore", () => {
  beforeEach(() => useProviderAvailabilityStore.setState({ providers: [] }));

  it("exposes isEnabled", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true }),
      row({ id: "codex", enabled: false }),
    ]);
    expect(useProviderAvailabilityStore.getState().isEnabled("claude")).toBe(true);
    expect(useProviderAvailabilityStore.getState().isEnabled("codex")).toBe(false);
  });

  it("isUsable requires enabled AND cli.status !== 'not_found'", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true, cli: { status: "found", resolvedPath: "/a", configuredPath: "" } }),
      row({ id: "codex",  enabled: true, cli: { status: "not_found", resolvedPath: null, configuredPath: "" } }),
      row({ id: "copilot", enabled: false, cli: { status: "found", resolvedPath: "/b", configuredPath: "" } }),
    ]);
    const s = useProviderAvailabilityStore.getState();
    expect(s.isUsable("claude")).toBe(true);
    expect(s.isUsable("codex")).toBe(false);
    expect(s.isUsable("copilot")).toBe(false);
  });

  it("rechecks the server only while an enabled CLI is missing, and recovers when it is found", async () => {
    const list = vi.mocked(mockTransport.listProviderAvailability).mockReset();
    const store = useProviderAvailabilityStore.getState();
    store.replace([
      row({ id: "claude", enabled: true }),
      row({ id: "codex", enabled: false, cli: { status: "not_found", resolvedPath: null, configuredPath: "" } }),
    ]);
    await store.recheckMissing();
    expect(list).not.toHaveBeenCalled();

    store.replace([row({ id: "claude", enabled: true, cli: { status: "not_found", resolvedPath: null, configuredPath: "" } })]);
    list.mockResolvedValue([row({ id: "claude", enabled: true })]);
    await store.recheckMissing();
    expect(useProviderAvailabilityStore.getState().isUsable("claude")).toBe(true);
  });

  it("returns 'unchecked' CLI as usable so the startup race doesn't false-alarm", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } }),
    ]);
    expect(useProviderAvailabilityStore.getState().isUsable("claude")).toBe(true);
  });
});
