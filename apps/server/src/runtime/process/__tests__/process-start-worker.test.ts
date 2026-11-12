import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts process starts made from this (main) thread. The git process worker
// loads node:child_process natively, outside this mock, so its starts are not counted.
const { mainThreadStarts } = vi.hoisted(() => ({ mainThreadStarts: { count: 0 } }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const promisifiedExecFile = NodeUtil.promisify(actual.execFile);
  const execFile = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => {
      mainThreadStarts.count += 1;
      return actual.execFile(...args);
    },
    {
      [NodeUtil.promisify.custom]: (...args: Parameters<typeof promisifiedExecFile>) => {
        mainThreadStarts.count += 1;
        return promisifiedExecFile(...args);
      },
    },
  );
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    mainThreadStarts.count += 1;
    return actual.spawn(...args);
  };
  return { ...actual, execFile, spawn };
});

import { gitExitCode, gitFailureOutput } from "../../../features/projects/git/execution/git-failure.js";
import { createProcessStartWorker, ProcessStartWorkerClient } from "../process-start-worker-client.js";
import { RealGitExecutor } from "../../../features/projects/git/execution/real-git-executor.js";

const PROBE_KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;

describe("interactive process worker sessions", () => {
  it("echoes stdin through the worker and stops without a main-thread process start", async () => {
    mainThreadStarts.count = 0;
    let output = "";
    const session = new ProcessStartWorkerClient().open({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk))"],
      timeout: 10_000,
    }, { onStdout: (chunk) => { output += chunk; } });
    try {
      session.write("hello worker\n");
      await vi.waitFor(() => expect(output).toBe("hello worker\n"));
    } finally {
      session.stop();
      session.stop();
      await session.exited;
    }
    session.write("after exit\n");
    expect(mainThreadStarts.count).toBe(0);
  });

  it("resolves exited when the binary is missing", async () => {
    const session = new ProcessStartWorkerClient().open({
      command: "missing-mcode-session-binary-xyz",
      args: [],
      timeout: 10_000,
    }, {});
    await expect(session.exited).resolves.toBeUndefined();
  });

  it.runIf(process.platform === "win32")("stops the descendant of a shell session", async () => {
    let output = "";
    const session = new ProcessStartWorkerClient().open({
      command: `"${process.execPath}"`,
      args: ["-e", '"console.log(process.pid);setInterval(()=>{},1000)"'],
      shell: true,
      timeout: 10_000,
    }, { onStdout: (chunk) => { output += chunk; } });
    let pid = 0;
    try {
      await vi.waitFor(() => {
        pid = Number(output.trim());
        expect(pid).toBeGreaterThan(0);
      });
    } finally {
      session.stop();
      await session.exited;
    }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  });
});

describe("git process execution off the main thread", () => {
  const tempDirs: string[] = [];

  it("runs a non-git command with arguments on the worker", async () => {
    const result = await new ProcessStartWorkerClient().run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "worker output"],
      timeout: 10_000,
    });

    expect(result).toEqual({ stdout: "worker output", stderr: "" });
  });

  it("preserves failure fields from a non-git command", async () => {
    const failure = await new ProcessStartWorkerClient().run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('partial'); process.stderr.write('failed'); process.exit(7)"],
      timeout: 10_000,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 7, stdout: "partial", stderr: "failed", killed: false });
    expect(gitExitCode(failure)).toBe(7);
    expect(gitFailureOutput(failure)).toContain("failed");
  });

  afterEach(() => {
    for (const key of PROBE_KEYS) delete process.env[key];
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("runs git without starting processes on the thread that answers requests", async () => {
    mainThreadStarts.count = 0;

    const result = await new RealGitExecutor().exec(["--version"]);

    expect(result.stdout).toMatch(/^git version /);
    expect(mainThreadStarts.count).toBe(0);
  });

  it("streams git output without starting processes on the thread that answers requests", async () => {
    mainThreadStarts.count = 0;
    const chunks: string[] = [];

    const result = await new RealGitExecutor().exec(["--version"], { retainStdout: false, onStdout: (chunk) => chunks.push(chunk) });

    expect(chunks.join("")).toMatch(/^git version /);
    expect(result.stdout).toBe("");
    expect(mainThreadStarts.count).toBe(0);
  });

  it("keeps git's exit code and streamed error output on observed failures", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "process-start-worker-"));
    tempDirs.push(dir);
    const errors: string[] = [];

    const failure = await new RealGitExecutor()
      .exec(["-C", dir, "status"], { env: { GIT_CEILING_DIRECTORIES: NodePath.dirname(dir) }, onStderr: (chunk) => errors.push(chunk) })
      .catch((error: unknown) => error);

    expect(gitExitCode(failure)).toBe(128);
    expect(gitFailureOutput(failure)).toMatch(/not a git repository/i);
    expect(errors.join("")).toMatch(/not a git repository/i);
  });

  it("finishes a run whose git exits before reading all of its input", async () => {
    const executor = new RealGitExecutor();

    const result = await executor.exec(["--version"], { input: "x".repeat(16 * 1024 * 1024) });

    expect(result.stdout).toMatch(/^git version /);
    await expect(executor.exec(["--version"])).resolves.toMatchObject({ stdout: expect.stringMatching(/^git version /) });
  });

  it("applies server environment changes made after the worker started", async () => {
    const executor = new RealGitExecutor();
    await executor.exec(["--version"]);
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "mcode.probe", GIT_CONFIG_VALUE_0: "late" });

    const result = await executor.exec(["config", "--get", "mcode.probe"]);

    expect(result.stdout.trim()).toBe("late");
  });

  it("keeps git's exit code and output on failures", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "process-start-worker-"));
    tempDirs.push(dir);

    const failure = await new RealGitExecutor()
      .exec(["-C", dir, "rev-parse", "HEAD"], { env: { GIT_CEILING_DIRECTORIES: NodePath.dirname(dir) } })
      .catch((error: unknown) => error);

    expect(gitExitCode(failure)).toBe(128);
    expect(gitFailureOutput(failure)).toMatch(/not a git repository/i);
  });

  it("rejects runs a lost worker owned and starts a fresh worker for the next run", async () => {
    const exitingWorker = () => new Worker(URL.createObjectURL(new Blob(
      ["globalThis.onmessage = () => process.exit(1);"],
      { type: "application/javascript" },
    )));
    const factories = [exitingWorker, createProcessStartWorker];
    const client = new ProcessStartWorkerClient(() => factories.shift()!());

    await expect(client.run({ command: "git", args: ["--version"], timeout: 10_000 })).rejects.toThrow(/Process worker/);
    const result = await client.run({ command: "git", args: ["--version"], timeout: 10_000 });

    expect(result.stdout).toMatch(/^git version /);
  });
});
