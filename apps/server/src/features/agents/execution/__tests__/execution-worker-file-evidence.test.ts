import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderFileMutationStart } from "@mcode/contracts";

import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import { ExecutionFileEvidenceCoordinator } from "../execution-file-evidence-coordinator.js";
import { ExecutionWorkerFileEvidence } from "../execution-worker-file-evidence.js";

const directories: string[] = [];
const execution = { threadId: "thread", turnId: "turn", executionId: "execution" };

async function directory(): Promise<string> {
  const path = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-worker-file-settle-"));
  directories.push(path);
  return path;
}

function coordinator() {
  const captureTracker = new TurnFileTracker(async () => ({ kind: "unavailable" }), () => {}, process.platform);
  return new ExecutionFileEvidenceCoordinator(captureTracker, {
    begin: () => {},
    takeFinalizationEvidence: () => null,
    clearExecution: () => {},
  });
}

function mutation(deliveryAttempt = 1): ProviderFileMutationStart {
  return {
    threadId: execution.threadId, turnExecutionId: execution.executionId,
    deliveryAttempt, toolCallId: "edit", toolName: "Edit",
    toolInput: { file_path: "tracked.txt" },
  };
}

function toolUse(event: ProviderFileMutationStart) {
  return {
    type: "toolUse" as const, threadId: event.threadId,
    turnExecutionId: event.turnExecutionId, toolCallId: event.toolCallId,
    toolName: event.toolName, toolInput: event.toolInput,
  };
}

function toolResult() {
  return {
    type: "toolResult" as const, threadId: execution.threadId,
    turnExecutionId: execution.executionId, toolCallId: "edit",
    output: "done", isError: false,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => NodeFSPromises.rm(path, { recursive: true, force: true })));
});

describe("ExecutionWorkerFileEvidence", () => {
  it("settles a pre-edit capture on the worker after the tool result", async () => {
    const cwd = await directory();
    const file = NodePath.join(cwd, "tracked.txt");
    await NodeFSPromises.writeFile(file, "before\n");
    const host = coordinator();
    const worker = new ExecutionWorkerFileEvidence();
    const handoff = host.begin({ ...execution, deliveryAttempt: 1, cwd, baselineRef: null });
    expect(worker.begin({ execution, deliveryAttempt: 1, cwd, handoff: structuredClone(handoff) })).toBe(true);
    const event = mutation();
    expect(host.capture(event)).toBe(true);
    await NodeFSPromises.writeFile(file, "after\nextra\n");
    const captured = host.take(toolUse(event), 1);
    if (!captured) throw new Error("Expected captured pre-edit evidence");
    expect(await worker.observeToolUse({ execution, deliveryAttempt: 1, event: toolUse(event),
      captured: structuredClone(captured) })).toBe(true);
    expect(await worker.observeToolResult({ execution, deliveryAttempt: 1, event: toolResult() }))
      .toMatchObject({ fileCount: 1, additions: 2, deletions: 1 });
    const frozen = host.seal({ ...execution, deliveryAttempt: 1, outcome: "completed" });
    if (!frozen) throw new Error("Expected frozen terminal evidence");

    const prepared = await worker.settle(structuredClone(frozen));
    expect(prepared).toMatchObject({
      threadId: execution.threadId, turnId: execution.turnId,
      executionId: execution.executionId, deliveryAttempt: 1,
      filesChanged: ["tracked.txt"], fileEffects: { fileCount: 1, additions: 2, deletions: 1 },
    });
    expect(await worker.settle(structuredClone(frozen))).toBe(prepared);
    expect(() => structuredClone(prepared)).not.toThrow();
    expect(worker.retire(execution, 1)).toBe(true);
    expect(worker.retire(execution, 1)).toBe(false);
  });

  it("rejects a different root or attempt before it can change file evidence", async () => {
    const cwd = await directory();
    const otherCwd = await directory();
    await NodeFSPromises.writeFile(NodePath.join(cwd, "tracked.txt"), "before\n");
    const host = coordinator();
    const worker = new ExecutionWorkerFileEvidence();
    const handoff = host.begin({ ...execution, deliveryAttempt: 2, cwd, baselineRef: null });
    expect(worker.begin({ execution, deliveryAttempt: 2, cwd: otherCwd, handoff })).toBe(false);
    expect(worker.begin({ execution, deliveryAttempt: 2, cwd, handoff })).toBe(true);
    const event = mutation(2);
    expect(host.capture(event)).toBe(true);
    const captured = host.take(toolUse(event), 2);
    if (!captured) throw new Error("Expected captured pre-edit evidence");
    expect(await worker.observeToolUse({ execution, deliveryAttempt: 1, event: toolUse(event), captured })).toBe(false);
    expect(await worker.observeToolResult({ execution, deliveryAttempt: 1, event: toolResult() })).toBeNull();
    const frozen = host.seal({ ...execution, deliveryAttempt: 2, outcome: "cancelled" });
    if (!frozen) throw new Error("Expected frozen terminal evidence");
    expect(await worker.settle({ ...frozen, deliveryAttempt: 1 })).toBeNull();
    expect(worker.retire(execution, 1)).toBe(false);
    expect(worker.retire(execution, 2)).toBe(true);
  });

  it("settles an open file tool when Stop arrives before its result", async () => {
    const cwd = await directory();
    const file = NodePath.join(cwd, "tracked.txt");
    await NodeFSPromises.writeFile(file, "before\n");
    const host = coordinator();
    const worker = new ExecutionWorkerFileEvidence();
    const handoff = host.begin({ ...execution, deliveryAttempt: 1, cwd, baselineRef: null });
    expect(worker.begin({ execution, deliveryAttempt: 1, cwd, handoff })).toBe(true);
    const event = mutation();
    expect(host.capture(event)).toBe(true);
    const captured = host.take(toolUse(event), 1);
    if (!captured) throw new Error("Expected captured pre-edit evidence");
    expect(await worker.observeToolUse({ execution, deliveryAttempt: 1, event: toolUse(event), captured }))
      .toBe(true);
    await NodeFSPromises.writeFile(file, "after\n");

    const frozen = host.seal({ ...execution, deliveryAttempt: 1, outcome: "cancelled" });
    if (!frozen) throw new Error("Expected frozen terminal evidence");
    expect(await worker.settle(frozen)).toMatchObject({
      fileEffects: { fileCount: 1, additions: 1, deletions: 1 },
    });
    expect(await worker.observeToolResult({ execution, deliveryAttempt: 1, event: toolResult() }))
      .toBeNull();
  });
});
