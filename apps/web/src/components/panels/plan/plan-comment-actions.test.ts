import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanComment, PlanCommentEditorDraft } from "@mcode/contracts";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePlanStore } from "@/stores/planStore";
import { useToastStore } from "@/stores/toastStore";
import { RpcError } from "@/transport/ws-transport";
import { resolvePlanComment, savePlanComment, setPlanCommentEditor } from "./plan-comment-actions";

const createPlanComment = vi.hoisted(() => vi.fn<(payload: { commentId: string; body: string }) => Promise<PlanComment>>());
const updatePlanComment = vi.hoisted(() => vi.fn<(payload: { commentId: string; body: string }) => Promise<PlanComment>>());
const setPlanCommentStatus = vi.hoisted(() => vi.fn<(payload: { commentId: string; status: string }) => Promise<PlanComment>>());
vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => ({ createPlanComment, updatePlanComment, setPlanCommentStatus }),
}));

const THREAD = "thread-plan";
const VERSION = "00000000-0000-4000-8000-000000000001";
const COMMENT = "00000000-0000-4000-8000-0000000000c1";
const ANCHOR = { kind: "text", start: 0, end: 4, quote: "Plan", prefix: "", suffix: "", section: null } as const;

function comment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: COMMENT,
    threadId: THREAD,
    versionId: VERSION,
    body: "note",
    anchor: ANCHOR,
    status: "open",
    sentMessageId: null,
    carriedFromCommentId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

const editor = (body: string, commentId: string | null = null): PlanCommentEditorDraft => ({
  planVersionId: VERSION,
  commentId,
  anchor: ANCHOR,
  body,
});
const input = { versionId: VERSION, newCommentId: COMMENT, anchor: ANCHOR };
const openEditor = () => useComposerDraftStore.getState().drafts[THREAD]?.planCommentEditor;

describe("plan comment writes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    usePlanStore.setState({ commentsByThread: {} });
    useComposerDraftStore.setState({ drafts: {} });
    useToastStore.setState({ toasts: [] });
  });

  it("closes the editor and stores the comment once the server saves it", async () => {
    createPlanComment.mockResolvedValue(comment());
    setPlanCommentEditor(THREAD, editor("  note  "));

    const error = await savePlanComment(THREAD, editor("  note  "), { ...input, body: "  note  " });

    expect(error).toBeNull();
    expect(createPlanComment).toHaveBeenCalledWith(expect.objectContaining({ commentId: COMMENT, body: "note" }));
    expect(openEditor()).toBeUndefined();
    expect(usePlanStore.getState().commentsByThread[THREAD]).toEqual([comment()]);
  });

  it("keeps the editor and its note when the version no longer takes comments", async () => {
    createPlanComment.mockRejectedValue(new RpcError("read only", "plan_read_only"));
    setPlanCommentEditor(THREAD, editor("my note"));

    const error = await savePlanComment(THREAD, editor("my note"), { ...input, body: "my note" });

    expect(error).toContain("accepted");
    expect(openEditor()?.body).toBe("my note");
    expect(usePlanStore.getState().commentsByThread[THREAD] ?? []).toEqual([]);
  });

  it("updates the note of a saved comment instead of creating a second one", async () => {
    usePlanStore.getState().setComments(THREAD, [comment()]);
    updatePlanComment.mockResolvedValue(comment({ body: "better", updatedAt: "2026-07-01T00:00:05.000Z" }));

    await savePlanComment(THREAD, editor("better", COMMENT), { ...input, body: "better" });

    expect(createPlanComment).not.toHaveBeenCalled();
    expect(usePlanStore.getState().commentsByThread[THREAD]?.[0]?.body).toBe("better");
  });

  it("refuses an empty note without calling the server", async () => {
    expect(await savePlanComment(THREAD, editor("   "), { ...input, body: "   " })).not.toBeNull();
    expect(createPlanComment).not.toHaveBeenCalled();
  });

  it("offers Undo after resolving, and Undo reopens the comment", async () => {
    usePlanStore.getState().setComments(THREAD, [comment()]);
    setPlanCommentStatus.mockImplementation(async ({ status }) =>
      comment({ status: status as PlanComment["status"], updatedAt: status === "open" ? "2026-07-01T00:00:09.000Z" : "2026-07-01T00:00:05.000Z" }),
    );

    await resolvePlanComment(THREAD, COMMENT);
    expect(usePlanStore.getState().commentsByThread[THREAD]?.[0]?.status).toBe("resolved");

    const toast = useToastStore.getState().toasts.find((t) => t.meta === "Undo");
    toast?.onOpen?.();
    await vi.waitFor(() => expect(usePlanStore.getState().commentsByThread[THREAD]?.[0]?.status).toBe("open"));
  });

  it("reports a failed resolve in a toast and leaves the comment open", async () => {
    usePlanStore.getState().setComments(THREAD, [comment()]);
    setPlanCommentStatus.mockRejectedValue(new RpcError("busy", "plan_busy"));

    await resolvePlanComment(THREAD, COMMENT);

    expect(usePlanStore.getState().commentsByThread[THREAD]?.[0]?.status).toBe("open");
    expect(useToastStore.getState().toasts.map((t) => t.kind)).toEqual(["failed"]);
  });
});
