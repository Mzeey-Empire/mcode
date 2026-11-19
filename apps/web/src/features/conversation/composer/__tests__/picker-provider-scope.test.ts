import { describe, expect, it } from "vitest";
import { pickerProviderScopeOf } from "../picker-provider-scope";

describe("pickerProviderScopeOf", () => {
  it("offers every provider to a new thread", () => {
    expect(pickerProviderScopeOf({ started: false, threadProviderId: undefined, isAgentRunning: false })).toEqual({ kind: "all" });
  });

  it("offers every provider to a branch-from-message draft of a started thread", () => {
    expect(pickerProviderScopeOf({ started: false, threadProviderId: "claude", isAgentRunning: false })).toEqual({ kind: "all" });
  });

  it("lets an idle started thread switch away from its provider", () => {
    expect(pickerProviderScopeOf({ started: true, threadProviderId: "claude", isAgentRunning: false }))
      .toEqual({ kind: "switchable", threadProviderId: "claude" });
  });

  it("holds a started thread to its provider while a turn runs", () => {
    expect(pickerProviderScopeOf({ started: true, threadProviderId: "claude", isAgentRunning: true }))
      .toEqual({ kind: "selected-only", threadProviderId: "claude" });
  });
});
