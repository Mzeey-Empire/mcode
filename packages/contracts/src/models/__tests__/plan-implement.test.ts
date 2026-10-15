import { describe, expect, it } from "vitest";
import { PlanImplementSchema, PlanImplementReceiptSchema } from "../plan.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";

describe("Implement wire boundaries", () => {
  it("round trips worktree requests and both receipts across JSON", () => {
    const request = { requestId, versionId, threadId: "source", expectedRevision: 0, target: "new-worktree" };
    expect(PlanImplementSchema().parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    for (const state of ["waiting-for-setup", "admitted"]) {
      const receipt = { requestId, versionId, version: 1, targetThreadId: "target", messageId: requestId,
        nativePlanFile: null, state };
      expect(PlanImplementReceiptSchema().parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
      expect(PlanImplementReceiptSchema().safeParse({ ...receipt, state: "failed" }).success).toBe(false);
    }
  });

  it("refuses a mismatched pending edit and strips client commit overrides", () => {
    const request = { requestId, versionId, threadId: "source", expectedRevision: 1, target: "new-worktree" };
    expect(PlanImplementSchema().parse({ ...request, sourceCommit: "f".repeat(40) })).toEqual(request);
    expect(PlanImplementSchema().safeParse({ ...request,
      pending: { versionId: requestId, baseVersionId: versionId, baseRevision: 0, contentMd: "Wrong draft" },
    }).success).toBe(false);
  });
});
