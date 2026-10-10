import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeTurnDiffRpc } from "../turn-diff-rpc.js";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";

describe("turn diff route outcomes", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  it("returns snapshot-expired for absent evidence", async () => {
    await fixture.attempt({ id: "one", missing: true });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-expired" });
  });

  it("returns snapshot-pruned when a tree cannot be read, even with a native patch", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    fixture.native("one", "");
    fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ?").run("0".repeat(40));
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-pruned" });
  });

  it("lists replacements once, includes unchanged turns, and keeps ordinals after expiry", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "retry", attemptOf: "one", edits: { "b.ts": "b\n" } });
    await fixture.attempt({ id: "next" });
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-retry", ordinal: 1, fileCount: 2, additions: null, deletions: null, evidence: "git", availability: "available" },
      { messageId: "message-next", ordinal: 2, fileCount: 0, availability: "available" },
    ]);
    fixture.db.prepare("DELETE FROM turn_snapshots WHERE message_id = ?").run("message-one");
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-retry", ordinal: 1, availability: "snapshot-expired" },
      { messageId: "message-next", ordinal: 2, availability: "available" },
    ]);
  });
});
