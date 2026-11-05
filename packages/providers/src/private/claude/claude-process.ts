import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderProcessPort } from "../../host-ports.js";
import { logger } from "@mcode/shared";
import { diag } from "@mcode/shared/diagnostics";

/** Captures only the process created for one SDK query, including a late spawn. */
export class ClaudeOwnedProcess {
  private retired = false;
  private readonly processes = new Map<number, SpawnedProcess>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly outputRelease = new AbortController();

  constructor(
    private readonly port: ProviderProcessPort,
    private readonly description: string,
    private readonly stderr: (chunk: string) => void,
    private readonly threadId: string | undefined,
    private readonly waitForOutputCapacity: (signal: AbortSignal) => Promise<void>,
  ) {}

  /** SDK transport callback preserving its forwarded cancellation signal and pipes. */
  spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = NodeChildProcess.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr(chunk));
    if (child.pid !== undefined) {
      const pid = child.pid;
      if (this.threadId !== undefined) {
        const th = this.threadId;
        diag.emit("claude.process", { th }, () => ({ step: "spawned", pid }));
        child.once("exit", (code, signal) => {
          diag.emit("claude.process", { th }, () => ({ step: "exited", pid, code, signal }));
        });
      }
      this.processes.set(child.pid, child);
      try {
        this.port.attach(child.pid, this.description);
      } catch (error) {
        this.retired = true;
        this.terminate(child.pid, child);
        throw error;
      }
      if (this.retired) this.terminate(child.pid, child);
    }
    const wait = this.waitForOutputCapacity;
    const signal = this.outputRelease.signal;
    const source = child.stdout;
    // The SDK reads stdout eagerly into its own queue, so its iterator cannot hold the pipe.
    const stdout = NodeStream.Readable.from((async function* () {
      for await (const chunk of source) {
        await wait(signal);
        yield chunk;
      }
    })(), { highWaterMark: 1, objectMode: false });
    child.once("exit", () => this.releaseOutput());
    return Object.assign(child, { stdout });
  };

  /** Releases held pipe reads before native shutdown. */
  releaseOutput(): void { this.outputRelease.abort(); }

  /** Retires captured processes and also fences callbacks that arrive afterward. */
  async retire(): Promise<void> {
    this.releaseOutput();
    this.retired = true;
    for (const [pid, child] of this.processes) this.terminate(pid, child);
    await Promise.all(this.retirements);
  }

  private terminate(pid: number, child: SpawnedProcess): void {
    if (!this.processes.delete(pid) || child.exitCode !== null || child.signalCode != null) return;
    if (this.threadId !== undefined) {
      diag.emit("claude.process", { th: this.threadId }, () => ({ step: "terminating", pid }));
    }
    const task = this.port.terminateTree(pid);
    this.retirements.add(task);
    void task.then(
      () => {
        this.retirements.delete(task);
        if (this.threadId !== undefined) {
          diag.emit("claude.process", { th: this.threadId }, () => ({ step: "terminated", pid, ok: true }));
        }
      },
      (error: unknown) => {
        this.retirements.delete(task);
        if (this.threadId !== undefined) {
          diag.emit("claude.process", { th: this.threadId }, () => ({ step: "terminated", pid, ok: false }));
        }
        this.processes.set(pid, child);
        logger.error("Claude owned process retirement failed", { pid, error: String(error) });
      },
    );
  }
}
