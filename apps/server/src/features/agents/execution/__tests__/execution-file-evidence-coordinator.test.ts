import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderFileMutationStart } from "@mcode/contracts";

import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { TurnDiffRepo } from "../../turns/persistence/turn-diff-repo.js";
import { TurnDiffService } from "../../turns/turn-diff-service.js";
import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import {
  ExecutionFileEvidenceCoordinator,
  prepareFrozenExecutionFileEvidence,
} from "../execution-file-evidence-coordinator.js";

const directories: string[] = [];
const databases: Database[] = [];
const input = {
  threadId: "thread", turnId: "turn", executionId: "execution",
  deliveryAttempt: 1, baselineRef: null,
};

async function directory(): Promise<string> {
  const path = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-worker-files-"));
  directories.push(path);
  return path;
}

function tracker(): TurnFileTracker {
  return new TurnFileTracker(async () => ({ kind: "unavailable" }), () => {}, "win32");
}

function diffs(): TurnDiffService {
  const db = openMemoryDatabase();
  databases.push(db);
  return new TurnDiffService(new TurnDiffRepo(db));
}

function mutation(executionId = input.executionId, deliveryAttempt = input.deliveryAttempt): ProviderFileMutationStart {
  return { threadId: input.threadId, turnExecutionId: executionId, deliveryAttempt,
    toolCallId: "edit", toolName: "Edit", toolInput: { file_path: "tracked.txt" } };
}

function toolUse(event: ProviderFileMutationStart) {
  return { type: "toolUse" as const, threadId: event.threadId,
    turnExecutionId: event.turnExecutionId, toolCallId: event.toolCallId,
    toolName: event.toolName, toolInput: event.toolInput };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(directories.splice(0).map((path) => NodeFSPromises.rm(path, { recursive: true, force: true })));
});

describe("ExecutionFileEvidenceCoordinator", () => {
  it("transfers pre-edit evidence and settles only the sealed execution", async () => {
    const cwd = await directory();
    const file = NodePath.join(cwd, "tracked.txt");
    await NodeFSPromises.writeFile(file, "before\n");
    const host = tracker();
    const worker = tracker();
    const native = diffs();
    const coordinator = new ExecutionFileEvidenceCoordinator(host, native);
    const handoff = coordinator.begin({ ...input, cwd });
    expect(worker.beginTurnFromHandoff(structuredClone(handoff), {
      threadId: input.threadId, executionId: input.executionId, cwd,
    })).toBe(true);
    const event = mutation();

    expect(coordinator.capture(event)).toBe(true);
    await NodeFSPromises.writeFile(file, "after\nextra\n");
    const captured = coordinator.take(toolUse(event), input.deliveryAttempt);
    if (!captured) throw new Error("Expected pre-edit file evidence");
    expect(await worker.observeCapturedToolUse(toolUse(event), structuredClone(captured))).toBe(true);
    await worker.observeToolResult(input.threadId, event.toolCallId);
    const patch = "diff --git a/tracked.txt b/tracked.txt\nindex 1..2\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1,2 @@\n-before\n+after\n+extra\n";
    expect(native.push({
      turnId: input.turnId, turnExecutionId: input.executionId,
      deliveryAttempt: input.deliveryAttempt, revision: 1,
      state: "snapshot", nativeFidelity: "agent", patch,
    })).toBe("accepted");
    const frozen = coordinator.seal({ ...input, outcome: "completed" });
    if (!frozen) throw new Error("Expected frozen file evidence");
    expect(() => structuredClone(frozen)).not.toThrow();
    expect(coordinator.seal({ ...input, outcome: "completed" })).toBe(frozen);
    expect(coordinator.capture(event)).toBe(false);

    const prepared = await prepareFrozenExecutionFileEvidence(
      structuredClone(frozen), worker, new SnapshotService(new RealGitExecutor()),
    );
    expect(prepared).toMatchObject({
      threadId: input.threadId, turnId: input.turnId, executionId: input.executionId,
      deliveryAttempt: input.deliveryAttempt, filesChanged: ["tracked.txt"],
      fileEffects: { fileCount: 1, additions: 2, deletions: 1 },
      selectedTurnDiff: { thread_id: input.threadId, source: "native", patch, revision: 1 },
    });
    expect(() => structuredClone(prepared)).not.toThrow();
    expect(coordinator.retire(input.threadId, input.executionId, input.deliveryAttempt)).toBe(true);
    expect(await host.finalEvidenceForExecution(handoff)).toBeNull();
  });

  it("fences Stop, retries, and late terminal callbacks by execution and attempt", async () => {
    const cwd = await directory();
    await NodeFSPromises.writeFile(NodePath.join(cwd, "tracked.txt"), "before\n");
    const coordinator = new ExecutionFileEvidenceCoordinator(tracker(), diffs());
    coordinator.begin({ ...input, cwd });
    expect(() => coordinator.begin({ ...input, deliveryAttempt: 0, cwd })).toThrow("positive delivery attempt");
    expect(coordinator.capture(mutation())).toBe(true);
    expect(coordinator.fence(input.threadId, input.executionId, 2)).toBe(false);
    expect(coordinator.fence(input.threadId, input.executionId, 1)).toBe(true);
    expect(coordinator.take(toolUse(mutation()), 1)).toBeNull();
    expect(coordinator.seal({ ...input, deliveryAttempt: 2, outcome: "cancelled" })).toBeNull();
    const stopped = coordinator.seal({ ...input, outcome: "cancelled" });
    expect(stopped?.outcome).toBe("cancelled");
    expect(() => coordinator.seal({ ...input, outcome: "completed" })).toThrow("outcome changed");
    expect(() => coordinator.begin({ ...input, deliveryAttempt: 2, cwd })).toThrow("Retire sealed");
    expect(coordinator.retire(input.threadId, input.executionId, 1)).toBe(true);

    coordinator.begin({ ...input, deliveryAttempt: 2, cwd });
    expect(coordinator.capture(mutation(input.executionId, 1))).toBe(false);
    expect(coordinator.capture(mutation(input.executionId, 2))).toBe(true);
    expect(coordinator.seal({ ...input, outcome: "cancelled" })).toBeNull();
    expect(coordinator.retire(input.threadId, input.executionId, 1)).toBe(false);
    expect(coordinator.retire(input.threadId, input.executionId, 2)).toBe(true);
  });
});
