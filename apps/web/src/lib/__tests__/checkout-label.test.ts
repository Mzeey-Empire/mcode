import { describe, expect, it } from "vitest";
import { isDetachedCheckout, resolveThreadCheckoutLabel } from "../checkout-label";

describe("resolveThreadCheckoutLabel", () => {
  it("returns a named branch", () => {
    expect(resolveThreadCheckoutLabel({ branch: "feat/x", checkout_state: "named", base_branch: "main", head_sha: null })).toBe("feat/x");
  });

  it("names the base a branchless checkout started from", () => {
    expect(resolveThreadCheckoutLabel({ branch: "main", checkout_state: "branchless", base_branch: "release", head_sha: null })).toBe(
      "detached from release",
    );
  });

  it.each([
    ["a HEAD branch value", { branch: "HEAD", checkout_state: "named" as const }],
    ["an empty branch", { branch: "", checkout_state: "named" as const }],
  ])("treats %s as detached from its base", (_name, thread) => {
    expect(resolveThreadCheckoutLabel({ ...thread, base_branch: "main", head_sha: null })).toBe("detached from main");
  });

  it("names the commit of a detached checkout in preference to its base", () => {
    expect(
      resolveThreadCheckoutLabel({ branch: "HEAD", checkout_state: "branchless", base_branch: "main", head_sha: "3f9a1c2" }),
    ).toBe("detached at 3f9a1c2");
  });

  it("ignores a stale hash once the thread is back on a named branch", () => {
    expect(
      resolveThreadCheckoutLabel({ branch: "feat/x", checkout_state: "named", base_branch: null, head_sha: "3f9a1c2" }),
    ).toBe("feat/x");
  });

  it("says only detached when no base is recorded", () => {
    expect(resolveThreadCheckoutLabel({ branch: "HEAD", checkout_state: "branchless", base_branch: null, head_sha: null })).toBe("detached");
    expect(resolveThreadCheckoutLabel(null)).toBe("detached");
  });
});

describe("isDetachedCheckout", () => {
  it("is false for a named branch and true for the detached shapes", () => {
    expect(isDetachedCheckout({ branch: "feat/x", checkout_state: "named" })).toBe(false);
    expect(isDetachedCheckout({ branch: "main", checkout_state: "branchless" })).toBe(true);
  });
});
