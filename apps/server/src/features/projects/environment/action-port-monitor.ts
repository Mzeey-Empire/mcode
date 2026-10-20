import type { WorkspaceEnvironmentActionPort } from "@mcode/contracts";
import { ActionPortDetector, type ActionPortCandidate } from "./action-port-detector.js";
import { probeActionPort } from "./action-port-probe.js";

/** Owns candidate and reachability probes for exactly one running command. */
export class ActionPortMonitor {
  private readonly detector = new ActionPortDetector();
  private readonly candidates: ActionPortCandidate[] = [];
  private readonly probing = new Set<ActionPortCandidate>();
  private port: WorkspaceEnvironmentActionPort | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pinned = false;

  constructor(
    private readonly runId: string,
    private readonly timestamp: () => string,
    private readonly publish: (port: WorkspaceEnvironmentActionPort) => void,
  ) {}

  /**
   * Restricts the monitor to one configured URL and starts probing it now, so reachability is
   * judged on the exact URL the action asked to open rather than on whatever the command prints.
   */
  pin(candidate: ActionPortCandidate): void {
    if (this.stopped || this.pinned) return;
    this.pinned = true;
    this.candidates.push(candidate);
    void this.probe(candidate);
    this.schedule(1_000);
  }

  /** Consumes only command output, never the terminal's synthesized echo. */
  write(bytes: Uint8Array): void {
    if (this.stopped || this.pinned) return;
    for (const candidate of this.detector.write(bytes)) {
      this.candidates.push(candidate);
      void this.probe(candidate);
    }
    if (!this.timer && this.candidates.length > 0) this.schedule(1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.port) void this.probe(this.port);
      else for (const candidate of this.candidates) void this.probe(candidate);
    }, delay);
    this.timer.unref();
  }

  private async probe(candidate: ActionPortCandidate): Promise<void> {
    if (this.probing.has(candidate)) return;
    this.probing.add(candidate);
    const reachable = await probeActionPort(candidate);
    this.probing.delete(candidate);
    if (this.stopped) return;
    if (!this.port) {
      if (!reachable) return;
      this.port = { ...candidate, runId: this.runId, reachable, detectedAt: this.timestamp() };
      this.detector.confirm();
      this.schedule(5_000);
    } else {
      if (candidate !== this.port || reachable === this.port.reachable) return;
      this.port = { ...this.port, reachable };
    }
    this.publish(this.port);
  }
}
