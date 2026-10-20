import { describe, expect, it } from "vitest";
import { threadTitleTone } from "../thread-row-presentation";
import type { ThreadRowState } from "../thread-row-state";

describe("threadTitleTone", () => {
  it.each<[string, ThreadRowState, boolean, ReturnType<typeof threadTitleTone>]>([
    ["unseen finished outcome is ink", { kind: "finished" }, false, "prominent"],
    ["unseen failure is ink", { kind: "failed" }, false, "prominent"],
    ["blocked on the user is ink", { kind: "needs-you", label: "Approval required" }, false, "prominent"],
    ["seen thread recedes", { kind: "quiet" }, false, "receded"],
    ["selected seen thread stays ink", { kind: "quiet" }, true, "prominent"],
    ["running thread keeps ink under the row fade", { kind: "running" }, false, "prominent"],
  ])("%s", (_name, state, selected, tone) => {
    expect(threadTitleTone(state, selected)).toBe(tone);
  });
});
