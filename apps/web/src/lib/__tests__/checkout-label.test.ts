import { describe, expect, it } from "vitest";
import { isDetachedCheckout, resolveThreadCheckoutLabel } from "../checkout-label";

describe("resolveThreadCheckoutLabel", () => {
  it("returns a named branch", () => {
    expect(resolveThreadCheckoutLabel({ branch: "feat/x", checkout_state: "named", base_branch: "main" })).toBe("feat/x");
  });

  it("names the base a branchless checkout started from", () => {
    expect(resolveThreadCheckoutLabel({ branch: "main", checkout_state: "branchless", base_branch: "release" })).toBe(
      "detached from release",
    );
  });

  it.each([
    ["a HEAD branch value", { branch: "HEAD", checkout_state: "named" as const }],
    ["an empty branch", { branch: "", checkout_state: "named" as const }],
  ])("treats %s as detached from its base", (_name, thread) => {
    expect(resolveThreadCheckoutLabel({ ...thread, base_branch: "main" })).toBe("detached from main");
  });

  it("says only detached when no base is recorded", () => {
    expect(resolveThreadCheckoutLabel({ branch: "HEAD", checkout_state: "branchless", base_branch: null })).toBe("detached");
    expect(resolveThreadCheckoutLabel(null)).toBe("detached");
  });
});

describe("isDetachedCheckout", () => {
  it("is false for a named branch and true for the detached shapes", () => {
    expect(isDetachedCheckout({ branch: "feat/x", checkout_state: "named" })).toBe(false);
    expect(isDetachedCheckout({ branch: "main", checkout_state: "branchless" })).toBe(true);
  });
});
