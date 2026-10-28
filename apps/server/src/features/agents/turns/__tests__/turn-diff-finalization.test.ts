import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkerTurnFixture } from "../../orchestration/__tests__/worker-turn-fixture.js";
import { TurnDiffRepo } from "../persistence/turn-diff-repo.js";

const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

describe("worker-owned native diff terminal persistence", () => {
  let fixture: Awaited<ReturnType<typeof openWorkerTurnFixture>>;
  beforeEach(async () => { fixture = await openWorkerTurnFixture(); });
  afterEach(async () => { await fixture?.close(); });

  it("persists native evidence against the committed assistant", async () => {
    expect(fixture.diffs.push({
      turnId: fixture.turn.turnId, turnExecutionId: fixture.turn.turnExecutionId,
      deliveryAttempt: 1, revision: 1, state: "snapshot", nativeFidelity: "agent", patch,
    })).toBe("accepted");
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Agent marker changed", tokens: null });
    await fixture.finish();
    const repo = new TurnDiffRepo(fixture.db, fixture.writer);
    expect(repo.latest(fixture.thread.id)).toMatchObject({ message_id: fixture.assistant()!.id, source: "native", patch });
    expect(fixture.diffs.liveComparison(fixture.thread.id)).toBeNull();
    expect(fixture.db.query("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 1 });
  });

  it("does not settle native evidence from a cancelled turn as the Last turn comparison", async () => {
    fixture.diffs.push({
      turnId: fixture.turn.turnId, turnExecutionId: fixture.turn.turnExecutionId,
      deliveryAttempt: 1, revision: 1, state: "snapshot", nativeFidelity: "agent", patch,
    });
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Partial answer", isFinalResponse: true });
    await fixture.stop();
    expect(fixture.assistant()).toMatchObject({ content: "Partial answer", outcome: "cancelled" });
    expect(new TurnDiffRepo(fixture.db, fixture.writer).latest(fixture.thread.id)).toBeUndefined();
    expect(fixture.diffs.liveComparison(fixture.thread.id)).toBeNull();
  });
});
