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

import { gitExitCode, gitFailureOutput } from "../git-failure.js";
import { createGitProcessWorker, GitProcessWorkerClient } from "../git-process-worker-client.js";
import { RealGitExecutor } from "../real-git-executor.js";

const PROBE_KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;

describe("git process execution off the main thread", () => {
  const tempDirs: string[] = [];

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
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-process-worker-"));
    tempDirs.push(dir);
    const errors: string[] = [];

    const failure = await new RealGitExecutor()
      .exec(["-C", dir, "status"], { env: { GIT_CEILING_DIRECTORIES: NodePath.dirname(dir) }, onStderr: (chunk) => errors.push(chunk) })
      .catch((error: unknown) => error);

    expect(gitExitCode(failure)).toBe(128);
    expect(gitFailureOutput(failure)).toMatch(/not a git repository/i);
    expect(errors.join("")).toMatch(/not a git repository/i);
  });

  it("applies server environment changes made after the worker started", async () => {
    const executor = new RealGitExecutor();
    await executor.exec(["--version"]);
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "mcode.probe", GIT_CONFIG_VALUE_0: "late" });

    const result = await executor.exec(["config", "--get", "mcode.probe"]);

    expect(result.stdout.trim()).toBe("late");
  });

  it("keeps git's exit code and output on failures", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-process-worker-"));
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
    const factories = [exitingWorker, createGitProcessWorker];
    const client = new GitProcessWorkerClient(() => factories.shift()!());

    await expect(client.run({ args: ["--version"], timeout: 10_000 })).rejects.toThrow(/Git process worker/);
    const result = await client.run({ args: ["--version"], timeout: 10_000 });

    expect(result.stdout).toMatch(/^git version /);
  });
});
