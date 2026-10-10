import { beforeEach, describe, expect, it } from "vitest";
import type { PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "./planStore";

const THREAD = "thread-plan-preview";

function plan(version: number): PlanVersion {
  return {
    id: `plan-${version}`,
    threadId: THREAD,
    messageId: `message-${version}`,
    version,
    title: `Plan ${version}`,
    contentMd: "## Plan",
    author: "agent", providerId: "codex", captureSource: "fence", baseVersionId: null,
    revision: 0, acceptedAt: null, acceptedMessageId: null, updatedAt: "2026-07-01T00:00:00.000Z",
    status: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("plan live preview state", () => {
  beforeEach(() => {
    usePlanStore.setState({
      plansByThread: {},
      activeVersionByThread: {},
      generatingThreads: new Set(),
      livePreviewByThread: {},
      dismissedPreviewVersionsByThread: {},
    });
  });

  it("does not create a preview when a plan is only added to saved state", () => {
    usePlanStore.getState().addPlan(THREAD, plan(1));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toBeUndefined();
  });

  it("keeps a pushed draft revision when an earlier snapshot arrives later", () => {
    const draft: PlanVersion = { ...plan(2), author: "user", providerId: null, messageId: null,
      captureSource: "edit", baseVersionId: plan(1).id, status: "draft", revision: 2, contentMd: "# Latest text" };
    usePlanStore.getState().addPlan(THREAD, draft);
    usePlanStore.getState().addPlan(THREAD, { ...draft, revision: 1, contentMd: "# Old snapshot" });
    expect(usePlanStore.getState().plansByThread[THREAD]).toEqual([draft]);
    usePlanStore.getState().addPlan(THREAD, { ...draft, revision: 3, contentMd: "# Next text" });
    expect(usePlanStore.getState().plansByThread[THREAD]).toEqual([{ ...draft, revision: 3, contentMd: "# Next text" }]);
  });

  it("never rolls an accepted or superseded version back to ready during hydration", () => {
    const accepted: PlanVersion = { ...plan(1), status: "accepted", acceptedAt: "2026-07-02T00:00:00.000Z", acceptedMessageId: "implement" };
    const superseded: PlanVersion = { ...plan(2), status: "superseded" };
    usePlanStore.getState().addPlan(THREAD, accepted);
    usePlanStore.getState().addPlan(THREAD, superseded);
    usePlanStore.getState().addPlan(THREAD, plan(1));
    usePlanStore.getState().addPlan(THREAD, plan(2));
    expect(usePlanStore.getState().plansByThread[THREAD]).toEqual([accepted, superseded]);
  });

  it("dismisses only the visible version and allows a newer version to preview", () => {
    usePlanStore.getState().showLivePreview(THREAD, plan(1));
    usePlanStore.getState().dismissLivePreview(THREAD, 1);
    usePlanStore.getState().showLivePreview(THREAD, plan(1));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toBeUndefined();

    usePlanStore.getState().showLivePreview(THREAD, plan(2));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toMatchObject({
      version: 2,
      title: "Plan 2",
    });
  });
});
