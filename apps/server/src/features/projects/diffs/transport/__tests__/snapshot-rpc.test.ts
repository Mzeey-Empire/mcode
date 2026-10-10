import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnSnapshotSchema } from "@mcode/contracts";
import { routeSnapshotRpc } from "../snapshot-rpc.js";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";

describe("snapshot RPC whole-turn evidence", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  it("validates the checkout even when the requested file is unattributed", async () => {
    const row = await fixture.attempt({ id: "one" });
    if (!row) throw new Error("Fixture snapshot missing");
    fixture.db.prepare("UPDATE turn_snapshots SET worktree_path = ?").run(fixture.directory + "/missing");
    expect(await routeSnapshotRpc("snapshot.getDiff", { snapshotId: row.id, filePath: "unattributed.ts" }, fixture.deps))
      .toMatchObject({ status: "failed", failure: { kind: "worktree-missing" } });
  });

  it("carries the range count and omits all rows of an incomplete turn", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "two", attemptOf: "one", edits: { "b.ts": "b\n" } });
    const rows = TurnSnapshotSchema().array().parse(await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, fixture.deps));
    expect(rows.map((row) => [row.message_id, row.attempt_count])).toEqual([["message-one", 2], ["message-two", 2]]);
    fixture.db.prepare("DELETE FROM turn_snapshots WHERE message_id = ?").run("message-one");
    expect(await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, fixture.deps)).toEqual([]);
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
  });
});
