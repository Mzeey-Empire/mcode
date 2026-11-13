import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openProcessStart } from "../process-start.js";
import { createWorkerCodexProcessLauncher } from "../../../../../../packages/providers/src/private/codex/codex-worker-process.js";
import { CodexAppServer } from "../../../../../../packages/providers/src/private/codex/codex-app-server.js";
import { createProcessStartWorker, ProcessStartWorkerClient } from "../process-start-worker-client.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

function killTestChild(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

// A killed child whose worker was terminated is never reaped, so on Linux and
// macOS it stays in the process table as a zombie that a signal-0 probe still finds.
function isProcessRunning(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      return process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  }
  const state = NodeChildProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

describe("worker-backed Codex process", () => {
  it("bounds termination even when exit confirmation has not arrived", async () => {
    const child = createWorkerCodexProcessLauncher(new ProcessStartWorkerClient().open)(
      process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); console.log('ready');"], {},
    );
    const exit = NodeEvents.once(child, "exit");
    await NodeEvents.once(child.stdout, "data");
    vi.useFakeTimers();
    let terminated = false;
    const termination = child.terminate!().then(() => { terminated = true; });
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(terminated).toBe(true);
    } finally {
      vi.useRealTimers();
      await termination;
      await exit;
    }
  }, 10_000);

  it.runIf(process.platform === "win32")("ends the direct child when taskkill fails", async () => {
    let pid: number | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const session = openProcessStart({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000); console.log('ready');"],
      timeout: 0,
    }, { onSpawn: (value) => { pid = value; }, onStdout: () => ready() });
    await started;
    const execFile = vi.mocked(NodeChildProcess.execFile).mockImplementationOnce((_file, _args, _options, callback) => {
      callback!(Object.assign(new Error("access denied"), { code: "EACCES" }), "", "");
      return new NodeChildProcess.ChildProcess();
    });
    try {
      session.stop(true);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1_000 });
      await session.exited;
    } finally {
      execFile.mockRestore();
      killTestChild(pid);
      await session.exited;
    }
  });

  it("delivers spawn before output, echoes stdin, streams stderr, and exits on terminate", async () => {
    const launch = createWorkerCodexProcessLauncher(new ProcessStartWorkerClient().open);
    const child = launch(process.execPath, ["-e", "process.stderr.write('diagnostic\\n');process.stdin.on('data', c => process.stdout.write(c))"], {});
    const events: string[] = [];
    child.on("spawn", () => events.push("spawn"));
    child.stdout.on("data", () => events.push("stdout"));
    child.stderr.on("data", () => events.push("stderr"));
    const stderr = NodeEvents.once(child.stderr, "data");
    const stdout = NodeEvents.once(child.stdout, "data");
    try {
      await NodeEvents.once(child, "spawn");
      expect(isProcessRunning(child.pid!)).toBe(true);
      child.stdin.write("hello worker\n");
      expect(String((await stdout)[0])).toBe("hello worker\n");
      expect(String((await stderr)[0])).toBe("diagnostic\n");
      expect(events[0]).toBe("spawn");
    } finally {
      const exit = NodeEvents.once(child, "exit");
      await child.terminate!();
      const [code, signal] = await exit;
      expect(code !== null || signal !== null).toBe(true);
    }
  });

  it("reports a running process as exited when the worker is lost", async () => {
    let worker: Worker | undefined;
    const client = new ProcessStartWorkerClient(() => {
      worker = createProcessStartWorker();
      return worker;
    });
    const launch = createWorkerCodexProcessLauncher(client.open);
    const script = "process.stdin.resume(); setInterval(() => {}, 1000);";
    const child = launch(process.execPath, ["-e", script], {});
    let replacement: ReturnType<typeof launch> | undefined;
    try {
      await NodeEvents.once(child, "spawn");
      expect(isProcessRunning(child.pid!)).toBe(true);
      const lostWorker = worker!;
      const exit = NodeEvents.once(child, "exit");
      lostWorker.dispatchEvent(new Event("close"));
      expect(await exit).toEqual([null, null]);
      await vi.waitFor(() => expect(isProcessRunning(child.pid!)).toBe(false), { timeout: 1_000 });
      replacement = launch(process.execPath, ["-e", script], {});
      await NodeEvents.once(replacement, "spawn");
      expect(isProcessRunning(replacement.pid!)).toBe(true);
      expect(worker).not.toBe(lostWorker);
    } finally {
      killTestChild(child.pid);
      await replacement?.terminate?.();
    }
  });

  it("completes a catalog-only handshake through worker-backed stdio", async () => {
    const methods: string[] = [];
    const script = "const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line', line=>{const r=JSON.parse(line);process.stderr.write(r.method+'\\n');if(r.id!==undefined)console.log(JSON.stringify({id:r.id,result:{}}));});";
    const workerLaunch = createWorkerCodexProcessLauncher(new ProcessStartWorkerClient().open);
    const server = new CodexAppServer({
      cliPath: process.execPath, workingDirectory: process.cwd(), platform: process.platform,
      catalogOnly: true,
      processLauncher: (_command, _args, options) => {
        const child = workerLaunch(process.execPath, ["-e", script], options);
        child.stderr.on("data", (chunk) => methods.push(...String(chunk).trim().split("\n")));
        return child;
      },
    });
    try {
      await server.start();
      expect(server.isAlive).toBe(true);
      expect(methods).toContain("initialize");
      expect(methods).not.toContain("thread/start");
    } finally {
      await server.kill();
    }
  });
});
