import { describe, expect, it } from "vitest";
import { createCheckoutBranchBlocker } from "../entries/branch";

describe("create-and-check-out branch blocker", () => {
  it("allows creation when there are commits ahead or uncommitted files", () => {
    expect(createCheckoutBranchBlocker({ settled: true, count: 0 }, true)).toBeNull();
    expect(createCheckoutBranchBlocker({ settled: true, count: 2 }, null)).toBeNull();
  });

  it("claims no commits only when the commit check said so", () => {
    expect(createCheckoutBranchBlocker({ settled: true, count: 0 }, false))
      .toBe("No commits or uncommitted changes to move");
    expect(createCheckoutBranchBlocker({ settled: true, count: 0 }, null))
      .toBe("No uncommitted changes to move");
  });

  it("says how to retry when the change check failed", () => {
    expect(createCheckoutBranchBlocker({ settled: true, count: null }, false))
      .toBe("Couldn't check for changes. Reopen this menu to retry.");
  });
});
