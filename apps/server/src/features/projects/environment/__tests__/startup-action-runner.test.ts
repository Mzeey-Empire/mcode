import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { StartupActionRunner, type StartupActionTransition, type StartupProjectActions } from "../startup-action-runner.js";

class FakeActions implements StartupProjectActions {
  readonly runs = new Map<string, WorkspaceEnvironmentActionRun>();
  readonly launched: string[] = [];
  readonly stopped: string[] = [];
  readonly approvals = new Set<string>();
  private readonly listeners = new Set<Parameters<StartupProjectActions["onUpdate"]>[0]>();
  private readonly outputs = new Set<Parameters<StartupProjectActions["onCommandOutput"]>[0]>();
  private sequence = 0;

  get({ actionId }: { actionId: string }) { return this.runs.get(actionId) ?? null; }
  onUpdate(listener: Parameters<StartupProjectActions["onUpdate"]>[0]) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onCommandOutput(listener: Parameters<StartupProjectActions["onCommandOutput"]>[0]) {
    this.outputs.add(listener);
    return () => { this.outputs.delete(listener); };
  }
  async launch(slot: { actionId: string }, _options?: unknown) { return this.start(slot); }
  async start({ actionId }: { actionId: string }) {
    this.launched.push(actionId);
    const pending = this.approvals.has(actionId);
    const run: WorkspaceEnvironmentActionRun = {
      runId: `run-${++this.sequence}`, actionId, threadId: "thread", workspaceId: "workspace",
      actionName: actionId, revision: 1, trigger: "startup", terminalSessionId: `terminal-${actionId}`,
      port: null, status: pending ? "awaiting-approval" : "running", exitCode: null,
      snapshot: { platform: "linux", script: `echo ${actionId}`, checkoutPath: "/fixture",
        terminal: { executable: "sh", arguments: [] }, environmentNames: [] },
      createdAt: "2026-10-16T12:00:00.000Z", startedAt: pending ? null : "2026-10-16T12:00:00.000Z", finishedAt: null,
    };
    this.emit(run);
    return run;
  }
  async stop(slot: { actionId: string }) {
    this.stopped.push(slot.actionId);
    this.exit(slot.actionId, null);
    return this.get(slot);
  }
  exit(actionId: string, exitCode: number | null) {
    const run = this.require(actionId);
    this.emit({ ...run, revision: run.revision + 1, exitCode,
      status: exitCode === 0 ? "completed" : "failed", finishedAt: "2026-10-16T12:00:01.000Z" });
  }
  running(actionId: string) {
    const run = this.require(actionId);
    this.emit({ ...run, revision: run.revision + 1, status: "running", startedAt: "2026-10-16T12:00:00.000Z" });
  }
  port(actionId: string) {
    const run = this.require(actionId);
    this.emit({ ...run, revision: run.revision + 1,
      port: { runId: run.runId, port: 4321, host: "localhost", url: "http://localhost:4321/", reachable: true, detectedAt: run.createdAt } });
  }
  output(actionId: string, text: string) {
    for (const listener of this.outputs) listener(this.require(actionId), Buffer.from(text));
  }
  private require(actionId: string) {
    const run = this.runs.get(actionId);
    if (!run) throw new Error("Missing fake action");
    return run;
  }
  private emit(run: WorkspaceEnvironmentActionRun) {
    this.runs.set(run.actionId, run);
    for (const listener of this.listeners) listener({ threadId: run.threadId, actionId: run.actionId, runId: run.runId, run });
  }
}

const cleanup: StartupActionRunner[] = [];
afterEach(async () => {
  for (const runner of cleanup.splice(0)) await runner.cancel();
  vi.useRealTimers();
});

function harness(projectActions = new FakeActions()) {
  const transitions: StartupActionTransition[] = [];
  const output: string[][] = [];
  const errors: unknown[] = [];
  let passes = 0;
  const runner = new StartupActionRunner({
    threadId: "thread", attemptId: "attempt", projectActions,
    transition: async (input) => { transitions.push(structuredClone(input)); return true; },
    appendOutput: async (entries) => { output.push(entries); },
    passed: async () => { passes++; }, onError: (error) => { errors.push(error); },
  });
  cleanup.push(runner);
  return { runner, projectActions, transitions, output, errors, passes: () => passes };
}

const sequence = ["install", "check"].map((actionId) => ({ actionId, script: `echo ${actionId}` }));
const released = [{ actionId: "dev", script: "echo dev", gate: "release" as const }, sequence[1]!];
const eventually = (assertion: () => void) => vi.waitFor(assertion, { interval: 1 });

describe("StartupActionRunner", () => {
  it("freezes hashes and waits for exit zero, ignoring live ports, before starting the next action", async () => {
    const h = harness();
    await h.runner.start(sequence, []);
    expect(h.transitions[0]?.actions).toEqual(sequence.map(({ actionId, script }) => ({
      actionId, scriptHash: NodeCrypto.createHash("sha256").update(script).digest("hex"), runId: null, outcome: "pending",
    })));
    h.projectActions.port("install");
    await Promise.resolve();
    expect(h.projectActions.launched).toEqual(["install"]);
    expect(h.passes()).toBe(0);
    h.projectActions.exit("install", 0);
    await eventually(() => expect(h.projectActions.launched).toEqual(["install", "check"]));
    expect(h.passes()).toBe(0);
    h.projectActions.exit("check", 0);
    await eventually(() => expect(h.passes()).toBe(1));
    expect(h.transitions.at(-1)?.actions.map((entry) => entry.outcome)).toEqual(["ready", "ready"]);
    expect(h.errors).toEqual([]);
  });

  it.each([1, 3, null])("blocks on exit %s and never launches the next action", async (code) => {
    const h = harness();
    await h.runner.start(sequence, []);
    h.projectActions.output("install", "\u001b[31mDependency failed\u001b[0m\n");
    h.projectActions.exit("install", code);
    await eventually(() => expect(h.transitions.at(-1)).toMatchObject({
      state: "failed", failedActionId: "install", exitCode: code ?? undefined, detail: "Dependency failed",
    }));
    expect(h.projectActions.launched).toEqual(["install"]);
    expect(h.passes()).toBe(0);
  });

  it("retries in place, skips earlier successes, and reruns edited successes", async () => {
    const h = harness();
    await h.runner.start(sequence, []);
    h.projectActions.exit("install", 0);
    await eventually(() => expect(h.projectActions.launched).toEqual(["install", "check"]));
    h.projectActions.exit("check", 3);
    await eventually(() => expect(h.transitions.at(-1)?.state).toBe("failed"));
    const previous = h.transitions.at(-1)?.actions ?? [];
    const retry = harness(h.projectActions);
    await retry.runner.start(sequence, previous);
    expect(retry.transitions[0]?.actions.map((entry) => [entry.outcome, entry.runId])).toEqual([
      ["skipped", "run-1"], ["pending", null],
    ]);
    expect(h.projectActions.launched).toEqual(["install", "check", "check"]);
    h.projectActions.exit("check", 3);
    await eventually(() => expect(retry.transitions.at(-1)?.state).toBe("failed"));
    const edited = harness(h.projectActions);
    await edited.runner.start([{ actionId: "install", script: "new install" }, sequence[1]!], previous);
    expect(h.projectActions.launched).toEqual(["install", "check", "check", "install"]);
  });

  it("holds for approval and follows the approved run's new identity", async () => {
    const h = harness();
    h.projectActions.approvals.add("install");
    await h.runner.start(sequence, []);
    expect(h.transitions.at(-1)?.state).toBe("awaiting-approval");
    expect(h.output).toEqual([]);
    h.projectActions.approvals.delete("install");
    await h.projectActions.start({ actionId: "install" });
    await eventually(() => expect(h.transitions.at(-1)).toMatchObject({
      state: "running", actions: [{ actionId: "install", runId: "run-2", outcome: "running" }, { outcome: "pending" }],
    }));
    h.projectActions.exit("install", 0);
    await eventually(() => expect(h.projectActions.launched).toEqual(["install", "install", "check"]));
  });

  it("skip leaves commands running, while cancellation stops their command phases", async () => {
    const skipped = harness();
    await skipped.runner.start(sequence, []);
    await skipped.runner.skip();
    skipped.projectActions.exit("install", 0);
    expect(skipped.projectActions.stopped).toEqual([]);
    expect(skipped.projectActions.launched).toEqual(["install"]);
    const cancelled = harness();
    await cancelled.runner.start(sequence, []);
    await cancelled.runner.cancel();
    expect(cancelled.projectActions.stopped).toEqual(["install"]);
    expect(cancelled.projectActions.launched).toEqual(["install"]);
    expect(cancelled.projectActions.get({ actionId: "install" })?.terminalSessionId).toBe("terminal-install");
  });

  it("joins an admitted launch during cancellation without starting the next action", async () => {
    const h = harness();
    let release = () => undefined;
    const launch = new Promise<void>((resolve) => { release = () => resolve(); });
    const launchAction = h.projectActions.launch.bind(h.projectActions);
    vi.spyOn(h.projectActions, "launch").mockImplementation(async (slot, options) => {
      await launch;
      return launchAction(slot, options);
    });
    const starting = h.runner.start(sequence, []);
    await eventually(() => expect(h.projectActions.launch).toHaveBeenCalledOnce());
    const cancelling = h.runner.cancel();
    release();
    await Promise.all([starting, cancelling]);
    expect(h.projectActions.launched).toEqual(["install"]);
    expect(h.projectActions.stopped).toEqual(["install"]);
    expect(h.passes()).toBe(0);
  });

  it("rejects a changed script after approval instead of marking the frozen action ready", async () => {
    const h = harness();
    h.projectActions.approvals.add("install");
    await h.runner.start(sequence, []);
    const run = h.projectActions.get({ actionId: "install" });
    if (!run) throw new Error("Missing pending run");
    h.projectActions.runs.set("install", { ...run, snapshot: { ...run.snapshot, script: "changed script" } });
    h.projectActions.exit("install", 0);
    await eventually(() => expect(h.transitions.at(-1)).toMatchObject({ state: "failed", failedActionId: "install" }));
    expect(h.projectActions.launched).toEqual(["install"]);
    expect(h.passes()).toBe(0);
  });

  it("coalesces plain-text output and flushes the final partial line on exit", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runner.start([sequence[0]!], []);
    h.projectActions.output("install", "\u001b[3");
    h.projectActions.output("install", "1mready\u001b[0m\n");
    h.projectActions.output("install", "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007");
    await vi.advanceTimersByTimeAsync(249);
    expect(h.output).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.output).toEqual([["$ echo install\n", "ready\n", "link"]]);
    h.projectActions.output("install", " done");
    h.projectActions.exit("install", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.output).toEqual([["$ echo install\n", "ready\n", "link"], [" done"]]);
    expect(h.passes()).toBe(1);
  });

  it("separates headers from output and caps each header at 4096 characters", async () => {
    const h = harness();
    const actionId = "x".repeat(4096);
    await h.runner.start([{ actionId, script: `echo ${actionId}` }], []);
    h.projectActions.output(actionId, "ready\n");
    h.projectActions.exit(actionId, 0);
    await eventually(() => expect(h.passes()).toBe(1));
    expect(h.output.flat()).toEqual([`$ echo ${"x".repeat(4088)}\n`, "ready\n"]);
    expect(h.output.flat().join("")).toBe(`$ echo ${"x".repeat(4088)}\nready\n`);
  });

  it("turns launch failures into a blocked action with the error detail", async () => {
    const h = harness();
    vi.spyOn(h.projectActions, "launch").mockRejectedValue(new Error("8 terminals are open"));
    await h.runner.start(sequence, []);
    expect(h.transitions.at(-1)).toMatchObject({
      state: "failed", failedActionId: "install", detail: "8 terminals are open",
      actions: [{ outcome: "failed", runId: null }, { outcome: "pending" }],
    });
    expect(h.passes()).toBe(0);
  });

  describe("release gate", () => {
    it("advances once the released run is running and ignores its later exit", async () => {
      const h = harness();
      await h.runner.start(released, []);
      await eventually(() => expect(h.projectActions.launched).toEqual(["dev", "check"]));
      expect(h.transitions.at(-1)?.actions.map((entry) => entry.outcome)).toEqual(["ready", "running"]);
      h.projectActions.exit("dev", 1);
      h.projectActions.exit("check", 0);
      await eventually(() => expect(h.passes()).toBe(1));
      expect(h.transitions.map((transition) => transition.state)).not.toContain("failed");
      expect(h.errors).toEqual([]);
    });

    it("passes when the released action is the last one", async () => {
      const h = harness();
      await h.runner.start([released[0]!], []);
      await eventually(() => expect(h.passes()).toBe(1));
      expect(h.transitions.at(-1)?.actions.map((entry) => entry.outcome)).toEqual(["ready"]);
    });

    it("still blocks when the released launch fails", async () => {
      const h = harness();
      vi.spyOn(h.projectActions, "launch").mockRejectedValue(new Error("8 terminals are open"));
      await h.runner.start(released, []);
      expect(h.transitions.at(-1)).toMatchObject({ state: "failed", failedActionId: "dev", detail: "8 terminals are open" });
      expect(h.passes()).toBe(0);
    });

    it("holds at approval instead of releasing a run that has not started", async () => {
      const h = harness();
      h.projectActions.approvals.add("dev");
      await h.runner.start(released, []);
      expect(h.transitions.at(-1)?.state).toBe("awaiting-approval");
      expect(h.projectActions.launched).toEqual(["dev"]);
      expect(h.transitions.at(-1)?.actions.map((entry) => entry.outcome)).toEqual(["pending", "pending"]);
    });

    it("rejects a changed script instead of releasing the frozen action", async () => {
      const h = harness();
      h.projectActions.approvals.add("dev");
      await h.runner.start(released, []);
      const run = h.projectActions.get({ actionId: "dev" });
      if (!run) throw new Error("Missing pending run");
      h.projectActions.runs.set("dev", { ...run, snapshot: { ...run.snapshot, script: "changed script" } });
      h.projectActions.running("dev");
      await eventually(() => expect(h.transitions.at(-1)).toMatchObject({ state: "failed", failedActionId: "dev" }));
      expect(h.projectActions.launched).toEqual(["dev"]);
    });

    it("retry keeps a live released run and relaunches a dead one", async () => {
      const first = harness();
      await first.runner.start(released, []);
      await eventually(() => expect(first.projectActions.launched).toEqual(["dev", "check"]));
      const previous = first.transitions.at(-1)?.actions ?? [];

      const live = harness(first.projectActions);
      await live.runner.start(released, previous);
      expect(live.transitions[0]?.actions.map((entry) => [entry.outcome, entry.runId])).toEqual([["skipped", "run-1"], ["pending", null]]);
      expect(first.projectActions.launched).toEqual(["dev", "check", "check"]);

      first.projectActions.exit("dev", 1);
      const dead = harness(first.projectActions);
      await dead.runner.start(released, previous);
      expect(dead.transitions[0]?.actions.map((entry) => entry.outcome)).toEqual(["pending", "pending"]);
      await eventually(() => expect(first.projectActions.launched).toEqual(["dev", "check", "check", "dev", "check"]));
    });
  });
});
