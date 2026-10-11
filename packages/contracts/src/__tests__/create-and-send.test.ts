import { describe, expect, it } from "vitest";
import { CreateAndSendSchema } from "../ws/methods.js";

const command = { workspaceId: "workspace-1", content: "Build", model: "test-model" };

describe("CreateAndSendSchema", () => {
  it.each([undefined, "", "   "])("rejects mode worktree without branch (%j)", (branch) => {
    const result = CreateAndSendSchema().safeParse({ ...command, mode: "worktree", branch });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["branch"]]);
  });

  it("accepts an existing worktree without a branch, since its checkout names it", () => {
    const input = { ...command, mode: "worktree", existingWorktreePath: "/checkout" };
    expect(CreateAndSendSchema().parse(input)).toEqual(input);
  });

  it("accepts worktree and branch with start from origin", () => {
    const input = { ...command, mode: "worktree", branch: "main", startFromOrigin: true };
    expect(CreateAndSendSchema().parse(input)).toEqual(input);
  });

  it.each([
    [{ mode: "direct" }, "mode"],
    [{ mode: undefined }, "mode"],
    [{ pullRequestNumber: 42 }, "pullRequestNumber"],
    [{ existingWorktreePath: "/checkout" }, "existingWorktreePath"],
    [{ parentThreadId: "parent" }, "parentThreadId"],
  ])("rejects incompatible start from origin input %j", (overrides, path) => {
    const result = CreateAndSendSchema().safeParse({
      ...command, mode: "worktree", branch: "main", startFromOrigin: true, ...overrides,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([[path]]);
  });

  it("keeps origin optional and permits direct starts without a branch", () => {
    expect(CreateAndSendSchema().parse(command)).toEqual(command);
    const direct = { ...command, mode: "direct", startFromOrigin: false };
    expect(CreateAndSendSchema().parse(direct)).toEqual(direct);
  });
});
