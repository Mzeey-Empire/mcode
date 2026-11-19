import { describe, expect, it } from "vitest";
import { isPlannedRestartFailure, plannedRestartNoticeText } from "../index.js";

const key = { noticeKey: "planned-restart:turn-1" };

describe("isPlannedRestartFailure", () => {
  it("accepts both failure texts under a planned-restart key", () => {
    expect(isPlannedRestartFailure({ content: plannedRestartNoticeText("wake", "failed"), systemNotice: key })).toBe(true);
    expect(isPlannedRestartFailure({ content: plannedRestartNoticeText("resume", "failed"), systemNotice: key })).toBe(true);
  });

  it("rejects success texts, other keys, and text that only begins like a failure", () => {
    expect(isPlannedRestartFailure({ content: plannedRestartNoticeText("wake", "started"), systemNotice: key })).toBe(false);
    expect(isPlannedRestartFailure({ content: plannedRestartNoticeText("wake", "failed"), systemNotice: { noticeKey: "other:1" } })).toBe(false);
    expect(isPlannedRestartFailure({ content: plannedRestartNoticeText("wake", "failed"), systemNotice: null })).toBe(false);
    expect(isPlannedRestartFailure({ content: `${plannedRestartNoticeText("wake", "failed")} twice`, systemNotice: key })).toBe(false);
  });
});
