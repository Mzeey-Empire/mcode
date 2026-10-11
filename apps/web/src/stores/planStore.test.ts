import { beforeEach, describe, expect, it } from "vitest";
import type { PlanVersion } from "@mcode/contracts";
import { planVersionWord, selectViewedPlanVersion, usePlanStore } from "./planStore";

const THREAD = "thread-plan";

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

function versionsOf(threadId: string): number[] {
  return (usePlanStore.getState().plansByThread[threadId] ?? []).map((p) => p.version);
}

describe("planStore merge", () => {
  beforeEach(() => {
    usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {} });
  });

  it("keeps versions in ascending order whatever order they arrive in", () => {
    usePlanStore.getState().addPlan(THREAD, plan(3));
    usePlanStore.getState().addPlan(THREAD, plan(1));
    usePlanStore.getState().addPlan(THREAD, plan(2));

    expect(versionsOf(THREAD)).toEqual([1, 2, 3]);
  });

  it("keeps the higher revision's content when an earlier snapshot arrives later", () => {
    const draft: PlanVersion = { ...plan(2), author: "user", providerId: null, messageId: null,
      captureSource: "edit", baseVersionId: plan(1).id, status: "draft", revision: 2, contentMd: "# Latest text" };
    usePlanStore.getState().addPlan(THREAD, draft);
    usePlanStore.getState().addPlan(THREAD, { ...draft, revision: 1, contentMd: "# Old snapshot" });
    expect(usePlanStore.getState().plansByThread[THREAD]?.[0]?.contentMd).toBe("# Latest text");

    usePlanStore.getState().addPlan(THREAD, { ...draft, revision: 3, contentMd: "# Next text" });
    expect(usePlanStore.getState().plansByThread[THREAD]?.[0]?.contentMd).toBe("# Next text");
  });

  it("never moves an accepted or superseded version back to ready", () => {
    const accepted: PlanVersion = { ...plan(1), status: "accepted", acceptedAt: "2026-07-02T00:00:00.000Z", acceptedMessageId: "implement" };
    usePlanStore.getState().addPlan(THREAD, accepted);
    usePlanStore.getState().addPlan(THREAD, { ...plan(2), status: "superseded" });
    usePlanStore.getState().addPlan(THREAD, plan(1));
    usePlanStore.getState().addPlan(THREAD, plan(2));

    const stored = usePlanStore.getState().plansByThread[THREAD] ?? [];
    expect(stored.map((p) => [p.version, p.status, p.acceptedMessageId])).toEqual([
      [1, "accepted", "implement"],
      [2, "superseded", null],
    ]);
  });
});

describe("selectViewedPlanVersion", () => {
  const versions = [plan(1), plan(2), plan(3)];

  it("shows the latest version when none is picked", () => {
    expect(selectViewedPlanVersion(versions, null)?.version).toBe(3);
  });

  it("shows the picked version while it exists", () => {
    expect(selectViewedPlanVersion(versions, 1)?.version).toBe(1);
  });

  it("falls back to the latest version when the picked version is gone", () => {
    expect(selectViewedPlanVersion(versions, 9)?.version).toBe(3);
  });

  it("shows nothing for a thread without versions", () => {
    expect(selectViewedPlanVersion([], null)).toBeNull();
    expect(selectViewedPlanVersion(versions, null)?.title).toBe("Plan 3");
  });
});

describe("planVersionWord", () => {
  it("names each status, and the provider for a ready version", () => {
    expect(planVersionWord({ status: "draft", providerId: null })).toBe("Edited by you");
    expect(planVersionWord({ status: "accepted", providerId: "codex" })).toBe("Accepted");
    expect(planVersionWord({ status: "superseded", providerId: "codex" })).toBe("Older version");
    expect(planVersionWord({ status: "ready", providerId: "claude" })).toBe("Claude");
    expect(planVersionWord({ status: "ready", providerId: null })).toBe("Agent");
  });
});
