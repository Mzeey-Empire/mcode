import { describe, expect, it } from "vitest";
import { ProviderStatusSchema } from "../providers/provider-status.js";
import { WS_METHODS } from "../ws/methods.js";

describe("provider model announcement contracts", () => {
  const status = {
    providerId: "claude",
    auth: { state: "signed_in" },
    cli: null,
    rateLimit: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
    newModels: [{ modelId: "new-model", label: "New model" }],
  };

  it("round-trips announcements through the status and list-status contracts", () => {
    expect(ProviderStatusSchema().parse(status)).toEqual(status);
    expect(WS_METHODS()["providers.listStatus"].result.parse([status])).toEqual([status]);
  });

  it("requires a bounded list with strict announcement objects", () => {
    expect(ProviderStatusSchema().safeParse({ ...status, newModels: undefined }).success).toBe(false);
    expect(ProviderStatusSchema().safeParse({ ...status, newModels: Array.from({ length: 6 }, () => status.newModels[0]) }).success).toBe(false);
    expect(ProviderStatusSchema().safeParse({ ...status, newModels: [{ modelId: "id", label: "Label", extra: true }] }).success).toBe(false);
  });

  it("accepts only a known provider id for acknowledgement and returns void", () => {
    const method = WS_METHODS()["providers.acknowledgeModels"];
    expect(method.params.parse({ providerId: "claude" })).toEqual({ providerId: "claude" });
    expect(method.params.safeParse({ providerId: "unknown" }).success).toBe(false);
    expect(method.params.safeParse({}).success).toBe(false);
    expect(method.result.parse(undefined)).toBe(undefined);
  });
});
