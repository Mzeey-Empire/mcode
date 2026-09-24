import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderFileMutationStart } from "@mcode/contracts";

import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import { ExecutionFileObservationHandoff } from "../execution-file-observation-handoff.js";

const directories: string[] = [];
const platform = "win32" as const;

async function directory(): Promise<string> {
  const path = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-worker-file-observation-"));
  directories.push(path);
  return path;
}

function tracker(): TurnFileTracker {
  return new TurnFileTracker(async () => ({ kind: "unavailable" }), () => {}, platform);
}

function mutation(executionId: string, toolCallId = "edit", deliveryAttempt = 1): ProviderFileMutationStart {
  return { threadId: "thread", turnExecutionId: executionId, deliveryAttempt,
    toolCallId, toolName: "Edit", toolInput: { file_path: "tracked.txt" } };
}

function toolUse(event: ProviderFileMutationStart) {
  return { type: "toolUse" as const, threadId: event.threadId,
    turnExecutionId: event.turnExecutionId, toolCallId: event.toolCallId,
    toolName: event.toolName, toolInput: event.toolInput };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => NodeFSPromises.rm(path, { recursive: true, force: true })));
});

describe("ExecutionFileObservationHandoff", () => {
  it("transfers a pre-edit baseline after the provider has changed the file", async () => {
    const cwd = await directory();
    const path = NodePath.join(cwd, "tracked.txt");
    await NodeFSPromises.writeFile(path, "before\n");
    const host = tracker();
    const worker = tracker();
    const expected = { threadId: "thread", executionId: "current", cwd };
    const handoff = host.beginExecutionTurn({ ...expected, baselineRef: null });
    const bridge = new ExecutionFileObservationHandoff(host, handoff, 1);
    const event = mutation(expected.executionId);

    expect(bridge.capture(event)).toBe(true);
    await NodeFSPromises.writeFile(path, "after\nextra\n");
    expect(worker.beginTurnFromHandoff(structuredClone(handoff), expected)).toBe(true);
    const captured = bridge.take(toolUse(event), 1);
    if (!captured) throw new Error("Expected the pre-edit observation");
    expect(await worker.observeCapturedToolUse(toolUse(event), structuredClone(captured))).toBe(true);
    await worker.observeToolResult("thread", "edit");
    expect(await worker.finalizeTurn("thread")).toMatchObject({ fileCount: 1, additions: 2, deletions: 1 });
    expect(bridge.take(toolUse(event), 1)).toBeNull();
  });

  it("rejects an old child after retry even when its tool call ID collides", async () => {
    const cwd = await directory();
    await NodeFSPromises.writeFile(NodePath.join(cwd, "tracked.txt"), "before\n");
    const host = tracker();
    const old = host.beginExecutionTurn({ threadId: "thread", executionId: "same", cwd, baselineRef: null });
    const oldBridge = new ExecutionFileObservationHandoff(host, old, 1);
    expect(oldBridge.capture(mutation("same"))).toBe(true);
    const current = host.beginExecutionTurn({ threadId: "thread", executionId: "same", cwd, baselineRef: null });
    const bridge = new ExecutionFileObservationHandoff(host, current, 2);

    expect(oldBridge.take(toolUse(mutation("same")), 1)).toBeNull();
    expect(bridge.capture(mutation("same"))).toBe(false);
    expect(bridge.capture(mutation("same", "edit", 2))).toBe(true);
    expect(bridge.take(toolUse(mutation("same")), 1)).toBeNull();
    expect(bridge.take(toolUse(mutation("same", "edit", 2)), 2)).toMatchObject({
      executionId: "same", generation: current.generation,
    });
  });

  it("fences captures and pending evidence after Stop", async () => {
    const cwd = await directory();
    const host = tracker();
    const handoff = host.beginExecutionTurn({ threadId: "thread", executionId: "current", cwd, baselineRef: null });
    const bridge = new ExecutionFileObservationHandoff(host, handoff, 1);
    const event = mutation("current");
    expect(bridge.capture(event)).toBe(true);
    bridge.close();
    expect(bridge.take(toolUse(event), 1)).toBeNull();
    expect(bridge.capture(mutation("current", "later"))).toBe(false);
  });

  it("discards a colliding tool call without replacing its first pre-edit baseline", async () => {
    const cwd = await directory();
    const host = tracker();
    const handoff = host.beginExecutionTurn({ threadId: "thread", executionId: "current", cwd, baselineRef: null });
    const bridge = new ExecutionFileObservationHandoff(host, handoff, 1);
    const event = mutation("current");
    expect(bridge.capture(event)).toBe(true);
    expect(bridge.capture(event)).toBe(false);
    expect(bridge.take(toolUse(event), 1)).toBeNull();
  });

  it("bounds pending observations and rejects a mutation without an exact attempt", async () => {
    const cwd = await directory();
    const host = tracker();
    const handoff = host.beginExecutionTurn({ threadId: "thread", executionId: "current", cwd, baselineRef: null });
    const bridge = new ExecutionFileObservationHandoff(host, handoff, 1);
    expect(bridge.capture({ ...mutation("current"), turnExecutionId: undefined })).toBe(false);
    expect(bridge.capture({ ...mutation("current"), deliveryAttempt: undefined })).toBe(false);
    for (let index = 0; index < 8; index += 1) {
      expect(bridge.capture(mutation("current", `edit-${index}`))).toBe(true);
    }
    expect(bridge.capture(mutation("current", "overflow"))).toBe(false);
  });
});
