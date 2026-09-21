import "reflect-metadata";
import * as NodeEvents from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { RealGitExecutor } from "../real-git-executor.js";

describe("RealGitExecutor", () => {
  let executor: RealGitExecutor;

  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
    executor = new RealGitExecutor();
  });

  it("serialises concurrent mutating calls for the same cwd", async () => {
    const order: number[] = [];
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const id = order.length + 1;
      setTimeout(() => {
        order.push(id);
        cb(null, { stdout: `out-${id}`, stderr: "" });
      }, 10);
    });

    const [first, second] = await Promise.all([
      executor.exec(["-C", "/repo", "worktree", "add", "/wt", "-b", "mcode/x"]),
      executor.exec(["-C", "/repo", "checkout", "-b", "other"]),
    ]);

    expect(order).toEqual([1, 2]);
    expect(first.stdout).toBe("out-1");
    expect(second.stdout).toBe("out-2");
  });

  it("runs read-only calls without waiting on the queue", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, { stdout: "ok\n", stderr: "" }), 10);
    });

    const first = executor.exec(["-C", "/repo", "status", "--porcelain"]);
    const second = executor.exec(["-C", "/repo", "rev-parse", "HEAD"]);

    // execFile fires synchronously for unqueued commands; a queued call would
    // only spawn after the previous operation resolved.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("lets read-only calls bypass a queue busy with a mutation", async () => {
    let releaseMutation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if ((args as string[]).includes("add")) {
        void gate.then(() => cb(null, { stdout: "", stderr: "" }));
        return;
      }
      cb(null, { stdout: "listed\n", stderr: "" });
    });

    const mutation = executor.exec(["-C", "/repo", "add", "-A"]);
    const listed = executor.exec(["-C", "/repo", "worktree", "list", "--porcelain"]);

    await expect(listed).resolves.toEqual({ stdout: "listed\n", stderr: "" });
    releaseMutation();
    await mutation;
  });

  it("keeps mutating forms of shared subcommands serialised", async () => {
    const order: number[] = [];
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const id = order.length + 1;
      setTimeout(() => {
        order.push(id);
        cb(null, { stdout: "", stderr: "" });
      }, 10);
    });

    const list = executor.exec(["-C", "/repo", "worktree", "list", "--porcelain"]);
    const add = executor.exec(["-C", "/repo", "worktree", "add", "/wt", "-b", "mcode/x"]);
    const force = executor.exec(["-C", "/repo", "branch", "-f", "mcode/x", "origin/mcode/x"]);
    await Promise.all([list, add, force]);

    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  it("caches rev-parse --git-dir only inside the queue", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "/repo/.git\n", stderr: "" });
    });

    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary commands on the buffered execFile path", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "buffered\n", stderr: "" });
    });

    await expect(executor.exec(["-C", "/repo", "status", "--porcelain"])).resolves.toEqual({
      stdout: "buffered\n",
      stderr: "",
    });
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not invalidate the rev-parse cache for read-only commands", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const argv = args as string[];
      if (argv.includes("--git-dir")) {
        cb(null, { stdout: "/repo/.git\n", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });

    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
    await executor.exec(["-C", "/repo", "status", "--porcelain"]);
    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates rev-parse cache after mutating commands", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const argv = args as string[];
      if (argv.includes("--git-dir")) {
        cb(null, { stdout: "/repo/.git\n", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });

    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
    await executor.exec(["-C", "/repo", "add", "-A"]);
    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("streams interleaved stdout and stderr while retaining buffered output", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const output: string[] = [];
    const result = executor.exec(["-C", "/repo", "fetch"], {
      onStdout: (chunk) => output.push(`out:${chunk}`),
      onStderr: (chunk) => output.push(`err:${chunk}`),
    });

    await waitForSpawn();
    child.stdout.emit("data", Buffer.from("one\n"));
    child.stderr.emit("data", Buffer.from("two\n"));
    child.stdout.emit("data", Buffer.from("three\n"));
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({ stdout: "one\nthree\n", stderr: "two\n" });
    expect(output).toEqual(["out:one\n", "err:two\n", "out:three\n"]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("preserves exit-code errors and captured output for observed commands", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = executor.exec(["-C", "/repo", "fetch"], { onStderr: vi.fn() });

    await waitForSpawn();
    child.stderr.emit("data", Buffer.from("fatal: denied\n"));
    child.emit("close", 128, null);

    await expect(result).rejects.toMatchObject({ code: 128, stderr: "fatal: denied\n" });
  });

  it("kills an observed command when its timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const result = executor.exec(["-C", "/repo", "fetch"], { onStdout: vi.fn(), timeout: 50 });

      await waitForSpawn();
      child.stdout.emit("data", Buffer.from("receiving\n"));
      vi.advanceTimersByTime(50);
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit("close", null, "SIGTERM");

      await expect(result).rejects.toMatchObject({ killed: true, stdout: "receiving\n" });
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeChild() {
  const child = new NodeEvents.EventEmitter();
  return Object.assign(child, {
    stdout: new NodeEvents.EventEmitter(),
    stderr: new NodeEvents.EventEmitter(),
    kill: vi.fn(() => true),
  });
}

async function waitForSpawn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
