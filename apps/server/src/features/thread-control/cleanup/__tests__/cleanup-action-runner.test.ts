import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import type { WorkspaceEnvironmentAction } from "@mcode/contracts";
import { WorkspaceEnvironmentService } from "../../../projects/index.js";
import type { WorkspaceEnvironmentTerminalCommandExecutor } from "../../../projects/environment/workspace-environment-service.js";
import type { TerminalCommandCompletion } from "../../../terminal/commands/terminal-command-service.js";
import { CleanupActionRunner } from "../cleanup-action-runner.js";

const workspaceId = "workspace-1";
const threadId = "thread-1";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

function exited(exitCode: number, output = ""): TerminalCommandCompletion {
  return { kind: "exited", exitCode, output, outputTruncated: false };
}

function action(id: string, runOnCleanup?: boolean): WorkspaceEnvironmentAction {
  return { id, name: id, command: { default: `run ${id}` }, ...(runOnCleanup === undefined ? {} : { runOnCleanup }) };
}

/** Fake Terminal command boundary: records each prepare call and each start, in order. */
function fakeTerminalCommands(completions: Readonly<Record<string, TerminalCommandCompletion>> = {}) {
  const started: string[] = [];
  const closed: string[] = [];
  const prepare = vi.fn<WorkspaceEnvironmentTerminalCommandExecutor["prepare"]>(async (input) => ({
    kind: "ready",
    command: {
      snapshot: {
        checkoutPath: "/checkout",
        terminal: { executable: "sh", arguments: ["-c", input.script] },
      },
      start: async () => {
        started.push(input.script);
        return completions[input.script] ?? exited(0);
      },
      close: async () => {
        closed.push(input.script);
        return { kind: "contained" };
      },
      waitForRelease: async () => undefined,
    },
  }));
  return { prepare, started, closed };
}

async function tempRoot(): Promise<string> {
  const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-cleanup-actions-"));
  roots.push(root);
  return root;
}

async function systemSetup(
  actions: readonly WorkspaceEnvironmentAction[],
  completions?: Readonly<Record<string, TerminalCommandCompletion>>,
) {
  const root = await tempRoot();
  const terminal = fakeTerminalCommands(completions);
  const environment = new WorkspaceEnvironmentService({
    mcodeDir: root,
    platform: "linux",
    threads: {
      findById: (id) => id === threadId
        ? { id, workspace_id: workspaceId, mode: "worktree", worktree_path: NodePath.join(root, "worktree") }
        : null,
    },
    terminalCommands: { prepare: terminal.prepare },
  });
  await environment.save({ workspaceId, sourceRevision: null, document: { version: "0.1.0", actions: [...actions] } });
  return { runner: new CleanupActionRunner(environment), terminal };
}

describe("CleanupActionRunner", () => {
  it("runs only cleanup actions, in document order", async () => {
    const { runner, terminal } = await systemSetup([
      action("lint"),
      action("stop-db", true),
      action("dev", false),
      action("clear-cache", true),
    ]);

    await runner.run(threadId);

    expect(terminal.started).toEqual(["run stop-db", "run clear-cache"]);
  });

  it("bounds each action to two minutes and 64KB and keeps going after a timeout", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { runner, terminal } = await systemSetup(
      [action("slow", true), action("after", true)],
      { "run slow": { kind: "timeout", output: "partial", outputTruncated: false } },
    );

    await runner.run(threadId);

    expect(terminal.prepare).toHaveBeenCalledTimes(2);
    for (const [input] of terminal.prepare.mock.calls) {
      expect(input).toMatchObject({
        scope: { kind: "thread", workspaceId: "workspace-1", threadId: "thread-1" },
        timeoutMs: 120_000,
        outputMaxBytes: 65_536,
      });
    }
    expect(warn).toHaveBeenCalledWith("Cleanup action failed", {
      threadId: "thread-1",
      actionId: "slow",
      outcome: "timeout",
      exitCode: null,
      output: "partial",
      outputTruncated: false,
    });
    expect(terminal.started).toEqual(["run slow", "run after"]);
  });

  it("logs the action id and exit code of a failing action and runs the next one", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const { runner, terminal } = await systemSetup(
      [action("broken", true), action("after", true)],
      { "run broken": exited(1, "boom") },
    );

    await runner.run(threadId);

    expect(warn).toHaveBeenCalledWith("Cleanup action failed", {
      threadId: "thread-1",
      actionId: "broken",
      outcome: "exited",
      exitCode: 1,
      output: "boom",
      outputTruncated: false,
    });
    expect(info).toHaveBeenCalledWith("Cleanup action finished", { threadId: "thread-1", actionId: "after", exitCode: 0 });
    expect(terminal.started).toEqual(["run broken", "run after"]);
  });

  it("skips an unapproved In repo action and runs it once approved", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const root = await tempRoot();
    const baseCheckout = NodePath.join(root, "base");
    const worktreeCheckout = NodePath.join(root, "worktree");
    const sharedDocument = JSON.stringify({ version: "0.1.0", actions: [action("teardown", true)] });
    for (const checkout of [baseCheckout, worktreeCheckout]) {
      await NodeFSPromises.mkdir(NodePath.join(checkout, ".mcode"), { recursive: true });
      await NodeFSPromises.writeFile(NodePath.join(checkout, ".mcode", "environment.json"), sharedDocument);
    }
    const terminal = fakeTerminalCommands();
    const environment = new WorkspaceEnvironmentService({
      mcodeDir: NodePath.join(root, "mcode"),
      platform: "linux",
      workspaces: { findById: (id) => id === workspaceId ? { id, path: baseCheckout } : null },
      threads: {
        findById: (id) => id === threadId
          ? { id, workspace_id: workspaceId, mode: "worktree", worktree_managed: true, worktree_path: worktreeCheckout }
          : null,
      },
      terminalCommands: { prepare: terminal.prepare },
    });
    const runner = new CleanupActionRunner(environment);

    await runner.run(threadId);

    expect(terminal.started).toEqual([]);
    expect(terminal.closed).toEqual(["run teardown"]);
    expect(warn).toHaveBeenCalledWith("Cleanup action skipped", {
      threadId: "thread-1",
      actionId: "teardown",
      reason: "approval_required",
    });

    const pending = await environment.resolveActionCommand(threadId, "teardown");
    if (pending.kind !== "ready" || !pending.approval) throw new Error("Expected a pending shared-command approval");
    await pending.command.close();
    await environment.approveCommand({ threadId, ...pending.approval });

    await runner.run(threadId);

    expect(terminal.started).toEqual(["run teardown"]);
  });

  it("logs and returns when the environment document cannot be read", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { runner, terminal } = await systemSetup([action("stop-db", true)]);

    await expect(runner.run("missing-thread")).resolves.toBeUndefined();

    expect(terminal.prepare).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Cleanup actions unavailable", {
      threadId: "missing-thread",
      error: "Thread was not found for manual Setup",
    });
  });
});
