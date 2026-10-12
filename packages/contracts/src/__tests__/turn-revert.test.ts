import { describe, expect, it } from "vitest";
import { WS_METHODS, WS_CHANNELS, TurnRevertPreviewSchema, TurnRevertResultSchema, SystemNoticeMetadataSchema, TurnSnapshotSchema } from "../index.js";

describe("turn revert wire contract", () => {
  it("requires explicit reverted paths on every snapshot", () => {
    const snapshot = { id: "s", message_id: "m", thread_id: "t", ref_before: "before", ref_after: "after",
      files_changed: ["a.ts"], worktree_path: null, created_at: "2026-10-11T00:00:00Z", attempt_count: 1, message_sequence: 4 };
    expect(TurnSnapshotSchema().safeParse(snapshot).success).toBe(false);
    expect(TurnSnapshotSchema().safeParse({ ...snapshot, reverted_paths: [1] }).success).toBe(false);
    for (const reverted_paths of [[], ["a.ts"]]) {
      expect(TurnSnapshotSchema().parse({ ...snapshot, reverted_paths })).toEqual({ ...snapshot, reverted_paths });
    }
  });

  it("parses turn and file-range requests, requires request identity, and rejects invalid scopes", () => {
    const preview = WS_METHODS()["turn.revert.preview"].params;
    expect(preview.parse({ threadId: "t", messageId: "m", scope: { kind: "turn" } })).toEqual({ threadId: "t", messageId: "m", scope: { kind: "turn" } });
    const apply = WS_METHODS()["turn.revert.apply"].params;
    const request = { threadId: "t", messageId: "last", scope: { kind: "file", path: "a.ts", fromMessageId: "first" }, previewToken: "hash", requestId: "8a7a59ba-fd1f-4094-a533-46cbe02ef4c4" };
    expect(apply.parse(request)).toEqual(request);
    expect(apply.safeParse({ ...request, requestId: "hash" }).success).toBe(false);
    expect(preview.safeParse({ ...request, scope: { kind: "turn", fromMessageId: "first" } }).success).toBe(false);
    expect(preview.safeParse({ ...request, scope: { kind: "file", path: "" } }).success).toBe(false);
    expect(WS_METHODS()["turn.revert.undo"].params.parse({ threadId: "t", revertId: "r", requestId: request.requestId })).toEqual({ threadId: "t", revertId: "r", requestId: request.requestId });
  });

  it("preserves discriminated preview and failure outcomes with bounded paths", () => {
    const preview = { status: "ready", previewToken: "hash", files: [{ path: "a", action: "restore", state: "changed_later", changedBy: "outside", binary: false }],
      skipped: [{ path: "b", reason: "folder_in_the_way" }], unattributedChangeCount: 2 };
    expect(TurnRevertPreviewSchema().parse(preview)).toEqual(preview);
    for (const outcome of ["unchanged", "rolled_back", "recovery_failed"]) {
      const result = { status: "failed", outcome, paths: ["a"], detail: "failure" };
      expect(TurnRevertResultSchema().parse(result)).toEqual(result);
    }
    expect(TurnRevertResultSchema().parse({ status: "stale", preview: { status: "nothing_to_revert" } })).toEqual({ status: "stale", preview: { status: "nothing_to_revert" } });
    expect(TurnRevertResultSchema().safeParse({ status: "nothing_to_revert" }).success).toBe(false);
    expect(TurnRevertPreviewSchema().safeParse({ ...preview, files: Array.from({ length: 513 }, () => preview.files[0]) }).success).toBe(false);
    expect(TurnRevertResultSchema().safeParse({ status: "failed", outcome: "success", paths: [], detail: "" }).success).toBe(false);
  });

  it("carries receipt metadata and the same record through responses and pushes", () => {
    for (const kind of ["turn-reverted", "turn-revert-undone", "turn-revert-interrupted"]) {
      const notice = { kind, presentation: "timeline", revertId: "r" };
      expect(SystemNoticeMetadataSchema().parse(notice)).toEqual(notice);
    }
    const receipt = { id: "receipt", thread_id: "t", role: "system", content: "Reverted Turn 1 · 1 file", tool_calls: null,
      files_changed: null, cost_usd: null, tokens_used: null, timestamp: "2026-10-11T00:00:00Z", sequence: 3, attachments: null,
      systemNotice: { kind: "turn-reverted", presentation: "timeline", revertId: "r" } };
    const revert = { id: "r", threadId: "t", targetMessageId: "m", fromMessageId: null, kind: "turn", path: null, undoesRevertId: null,
      undoneByRevertId: null, files: [{ path: "a", action: "restore" }], receiptMessageId: "receipt", createdAt: receipt.timestamp };
    expect(TurnRevertResultSchema().parse({ status: "reverted", revert, receipt })).toEqual({ status: "reverted", revert, receipt });
    expect(WS_CHANNELS["turn.reverted"].parse({ threadId: "t", revert, receipt })).toEqual({ threadId: "t", revert, receipt });
  });
});
