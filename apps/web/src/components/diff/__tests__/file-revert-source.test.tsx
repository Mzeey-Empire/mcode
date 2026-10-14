import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReviewTurn, TurnSnapshot } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { allTurnsRevertSource, turnRevertSource, useFileRevertSource } from "../file-revert-source";

function turn(messageId: string, ordinal: number): ReviewTurn {
  return { messageId, ordinal, createdAt: "2026-10-14T10:00:00.000Z", phase: "settled", fileCount: 1, additions: 1, deletions: 0, evidence: "native", availability: "available" };
}

function row(messageId: string, attemptCount = 1, refs: Partial<Pick<TurnSnapshot, "ref_before" | "ref_after">> = {}): TurnSnapshot {
  return {
    id: `snap-${messageId}`, message_id: messageId, thread_id: "thread-1", ref_before: "before", ref_after: "after", files_changed: ["a.ts"],
    worktree_path: null, created_at: "2026-10-14T10:00:00.000Z", attempt_count: attemptCount, reverted_paths: [], message_sequence: 1, ...refs,
  };
}

const turns = [turn("m1", 1), turn("m2", 2), turn("m3", 3)];

describe("turnRevertSource", () => {
  it("names the shown turn by ordinal", () => {
    expect(turnRevertSource("m2", turns)).toEqual({ messageId: "m2", range: { from: 2, to: 2 } });
  });

  it("offers nothing without a resolved turn", () => {
    expect(turnRevertSource(null, turns)).toBeNull();
    expect(turnRevertSource("gone", turns)).toBeNull();
    expect(turnRevertSource("m1", undefined)).toBeNull();
  });
});

describe("allTurnsRevertSource", () => {
  it("spans the first to the last snapshot that has both refs", () => {
    const snapshots = [row("m0", 1, { ref_before: "" }), row("m1"), row("m2"), row("m3")];
    expect(allTurnsRevertSource(snapshots, turns)).toEqual({ messageId: "m3", fromMessageId: "m1", range: { from: 1, to: 3 } });
  });

  it("collapses a one-turn range to the Turn view's request", () => {
    expect(allTurnsRevertSource([row("m2")], turns)).toEqual({ messageId: "m2", range: { from: 2, to: 2 } });
  });

  it("reads the ordinal of a retried first turn from its settled attempt", () => {
    const snapshots = [row("m1-first", 2), row("m1", 2), row("m2")];
    expect(allTurnsRevertSource(snapshots, turns)).toEqual({ messageId: "m2", fromMessageId: "m1-first", range: { from: 1, to: 2 } });
  });

  it("keeps a retried first turn whose earlier attempt has no refs", () => {
    const snapshots = [row("m1-first", 2, { ref_after: "" }), row("m1", 2), row("m2")];
    expect(allTurnsRevertSource(snapshots, turns)).toEqual({ messageId: "m2", fromMessageId: "m1", range: { from: 1, to: 2 } });
  });

  it("keeps a turn whose settled attempt lacks refs but an earlier attempt has them", () => {
    const snapshots = [row("m1"), row("m2-first", 2), row("m2", 2, { ref_after: "" })];
    expect(allTurnsRevertSource(snapshots, turns)).toEqual({ messageId: "m2-first", fromMessageId: "m1", range: { from: 1, to: 2 } });
  });

  it("offers nothing without snapshots or a matching turn list", () => {
    expect(allTurnsRevertSource([], turns)).toBeNull();
    expect(allTurnsRevertSource([row("m1")], undefined)).toBeNull();
    expect(allTurnsRevertSource([row("unknown")], turns)).toBeNull();
  });
});

describe("useFileRevertSource", () => {
  beforeEach(() => {
    useDiffStore.setState({
      reviewTurnsByThread: { "thread-1": turns },
      snapshotsByThread: { "thread-1": [row("m1"), row("m2")] },
    });
  });

  it.each([
    ["turn", { messageId: "m2", range: { from: 2, to: 2 } }],
    ["cumulative", { messageId: "m2", fromMessageId: "m1", range: { from: 1, to: 2 } }],
    ["since-looked", null],
    ["unstaged", null],
    ["staged", null],
  ] as const)("in the %s view", (viewMode, expected) => {
    const { result } = renderHook(() => useFileRevertSource(viewMode, "thread-1", "m2"));
    expect(result.current).toEqual(expected);
  });
});
