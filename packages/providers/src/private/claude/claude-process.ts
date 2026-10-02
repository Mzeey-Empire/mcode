import * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderProcessPort } from "../../host-ports.js";
import { logger } from "@mcode/shared";

/** Captures only the process created for one SDK query, including a late spawn. */
export class ClaudeOwnedProcess {
  private retired = false;
  private readonly processes = new Map<number, SpawnedProcess>();
  private readonly retirements = new Set<Promise<void>>();

  constructor(
    private readonly port: ProviderProcessPort,
    private readonly description: string,
    private readonly stderr: (chunk: string) => void,
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
    return child;
  };

  /** Retires captured processes and also fences callbacks that arrive afterward. */
  async retire(): Promise<void> {
    this.retired = true;
    for (const [pid, child] of this.processes) this.terminate(pid, child);
    await Promise.all(this.retirements);
  }

  private terminate(pid: number, child: SpawnedProcess): void {
    if (!this.processes.delete(pid) || child.exitCode !== null || child.signalCode != null) return;
    const task = this.port.terminateTree(pid);
    this.retirements.add(task);
    // Keep the rejection on the task for retire() while avoiding an unobserved late rejection.
    void task.catch((error: unknown) => { logger.error("Claude owned process retirement failed", { pid, error: String(error) }); });
  }
}
