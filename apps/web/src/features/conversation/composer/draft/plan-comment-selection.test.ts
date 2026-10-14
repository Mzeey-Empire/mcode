import { beforeEach, describe, expect, it } from "vitest";
import type { PlanComment, PlanVersion } from "@mcode/contracts";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePlanStore } from "@/stores/planStore";
import type { NextMessageDraft } from "./draft-submission";
import { beginDraftSubmission } from "./draft-submission-lifecycle";
import {
  excludeAllPlanComments,
  excludePlanComment,
  includePlanComment,
  readPlanCommentsForSend,
  sendablePlanComments,
  syncPlanCommentSelection,
  updatePlanCommentSelection,
} from "./plan-comment-selection";

const THREAD_ID = "thread-plan-comments";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

function version(id: string, number: number, status: PlanVersion["status"]): PlanVersion {
  return { id, version: number, status } as PlanVersion;
}

function comment(id: string, versionId: string, extra: Partial<PlanComment> = {}): PlanComment {
  return {
    id,
    versionId,
    status: "open",
    sentMessageId: null,
    carriedFromCommentId: null,
    ...extra,
  } as PlanComment;
}

const NO_DRAFT: NextMessageDraft = {};

describe("sendable plan comments", () => {
  it("offers the open, unsent comments of every version that is not accepted", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "ready")],
      [
        comment("old", V1),
        comment("open", V2),
        comment("resolved", V2, { status: "resolved" }),
        comment("sent", V2, { sentMessageId: "message-1" }),
      ],
    );

    expect(sendable?.version.id).toBe(V2);
    expect(sendable?.comments.map((c) => c.id)).toEqual(["old", "open"]);
  });

  it("leaves out a comment whose carried copy rides instead", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "ready")],
      [comment("a", V1), comment("b", V1), comment("a2", V2, { carriedFromCommentId: "a" })],
    );

    expect(sendable?.comments.map((c) => c.id)).toEqual(["b", "a2"]);
  });

  it("leaves out comments on an accepted version but keeps those on older ones", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "accepted")],
      [comment("old", V1), comment("accepted", V2)],
    );

    expect(sendable?.comments.map((c) => c.id)).toEqual(["old"]);
  });

  it("offers nothing before the thread has a plan", () => {
    expect(sendablePlanComments([], [comment("a", V1)])).toBeUndefined();
  });
});

describe("plan-comment selection sync", () => {
  const versions = [version(V1, 1, "superseded"), version(V2, 2, "ready")];

  it("keeps an exclusion on the comment carried into a new version", () => {
    const first = syncPlanCommentSelection(NO_DRAFT, sendablePlanComments([version(V1, 1, "ready")], [comment("a", V1), comment("b", V1)]));
    const excluded = excludePlanComment(first, "b");

    const carried = syncPlanCommentSelection(
      excluded,
      sendablePlanComments(versions, [comment("a2", V2, { carriedFromCommentId: "a" }), comment("b2", V2, { carriedFromCommentId: "b" })]),
    );

    expect(carried.planCommentSelection).toMatchObject({ planVersionId: V2, includedIds: ["a2"], excludedIds: ["b2"] });
  });

  it("empties the selection when its comments are gone and never creates one for none", () => {
    const selected = syncPlanCommentSelection(NO_DRAFT, sendablePlanComments(versions, [comment("a", V2)]));

    expect(syncPlanCommentSelection(selected, sendablePlanComments(versions, [])).planCommentSelection)
      .toMatchObject({ includedIds: [], excludedIds: [] });
    expect(syncPlanCommentSelection(NO_DRAFT, sendablePlanComments(versions, []))).toEqual(NO_DRAFT);
  });

  it("excludes a comment for one Send and brings it back on request", () => {
    const selected = syncPlanCommentSelection(NO_DRAFT, sendablePlanComments(versions, [comment("a", V2)]));

    const excluded = excludePlanComment(selected, "a");
    const restored = includePlanComment(excluded, "a");

    expect(excluded.planCommentSelection).toMatchObject({ includedIds: ["a"], excludedIds: ["a"] });
    expect(restored.planCommentSelection).toMatchObject({ includedIds: ["a"], excludedIds: [] });
  });
});

describe("excludeAllPlanComments", () => {
  it("leaves every riding comment out of this Send and keeps them selectable", () => {
    const versions = [version(V2, 2, "ready")];
    const selected = syncPlanCommentSelection(NO_DRAFT, sendablePlanComments(versions, [comment("a", V2), comment("b", V2)]));

    const excluded = excludeAllPlanComments(selected);

    expect(excluded.planCommentSelection).toMatchObject({ includedIds: ["a", "b"], excludedIds: ["a", "b"] });
    expect(excludeAllPlanComments(NO_DRAFT)).toBe(NO_DRAFT);
  });
});

describe("plan comments on a Send", () => {
  const messageId = "00000000-0000-4000-8000-0000000000aa";

  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    usePlanStore.setState({ plansByThread: {}, commentsByThread: {}, activeVersionByThread: {} });
    usePlanStore.getState().addPlan(THREAD_ID, version(V2, 2, "ready"));
    usePlanStore.getState().setComments(THREAD_ID, [comment("a", V2), comment("b", V2)]);
  });

  it("reads comments saved since the composer last looked, minus the excluded one", () => {
    readPlanCommentsForSend(THREAD_ID);
    useComposerDraftStore.getState().updateNextMessage(THREAD_ID, (draft) => excludePlanComment(draft, "b"));

    expect(readPlanCommentsForSend(THREAD_ID)).toEqual({ ridingIds: ["a"], excludedIds: ["b"] });
  });

  it("returns the excluded comment to the chip after the Send succeeds", () => {
    const planComments = readPlanCommentsForSend(THREAD_ID);
    useComposerDraftStore.getState().updateNextMessage(THREAD_ID, (draft) => excludePlanComment(draft, "b"));
    const handle = beginDraftSubmission(THREAD_ID, { diffComments: [], planComments: readPlanCommentsForSend(THREAD_ID) }, messageId);

    handle!.succeeded();

    expect(planComments.ridingIds).toEqual(["a", "b"]);
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]?.planCommentSelection)
      .toMatchObject({ includedIds: ["b"], excludedIds: [] });
  });

  it("keeps a restored exclusion while the thread's plan has not hydrated yet", () => {
    readPlanCommentsForSend(THREAD_ID);
    useComposerDraftStore.getState().updateNextMessage(THREAD_ID, (draft) => excludePlanComment(draft, "b"));
    usePlanStore.setState({ plansByThread: {}, commentsByThread: {} });

    updatePlanCommentSelection(THREAD_ID);
    usePlanStore.getState().addPlan(THREAD_ID, version(V2, 2, "ready"));
    usePlanStore.getState().setComments(THREAD_ID, [comment("a", V2), comment("b", V2)]);

    expect(readPlanCommentsForSend(THREAD_ID)).toEqual({ ridingIds: ["a"], excludedIds: ["b"] });
  });

  it("does not freeze a Send that carries no plan comments", () => {
    usePlanStore.getState().setComments(THREAD_ID, []);

    expect(beginDraftSubmission(THREAD_ID, { diffComments: [], planComments: readPlanCommentsForSend(THREAD_ID) }, messageId)).toBeNull();
  });
});
