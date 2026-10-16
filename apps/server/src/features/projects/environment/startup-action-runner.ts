import * as NodeCrypto from "node:crypto";
import type { ThreadStartupAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { TerminalPlainTextDecoder } from "../../terminal/output/terminal-plain-text.js";
import type { ProjectActionService } from "./project-action-service.js";

/** Atomic attempt and startup-step transition produced only by the startup runner. */
export interface StartupActionTransition {
  threadId: string;
  attemptId: string;
  state: "running" | "awaiting-approval" | "passed" | "failed";
  actions: ThreadStartupAction[];
  failedActionId?: string;
  exitCode?: number;
  detail?: string;
}

/** Action boundary shared by the production service and deterministic runner tests. */
export type StartupProjectActions = Pick<ProjectActionService, "start" | "restart" | "get" | "stop" | "onUpdate" | "onCommandOutput">;

/** Runs a frozen startup sequence through normal action terminals; only exit zero advances it. */
export class StartupActionRunner {
  private entries: ThreadStartupAction[] = [];
  private current: ThreadStartupAction | undefined;
  private awaitingApproval = false;
  private launching = false;
  private stopped: "skip" | "cancel" | null = null;
  private work = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly headers = new Set<string>();
  private readonly tail: StartupActionTail;

  constructor(private readonly options: {
    threadId: string;
    attemptId: string;
    projectActions: StartupProjectActions;
    transition: (input: StartupActionTransition) => Promise<boolean>;
    appendOutput: (entries: string[]) => Promise<void>;
    passed: () => Promise<void>;
    onError: (error: unknown) => void;
  }) {
    this.tail = new StartupActionTail(options.appendOutput, (operation) => this.enqueue(operation));
    this.unsubscribe.push(options.projectActions.onUpdate(({ run }) => {
      if (run.threadId === options.threadId) void this.enqueue(() => this.observe(run));
    }));
    this.unsubscribe.push(options.projectActions.onCommandOutput((run, bytes) => {
      if (run.threadId !== options.threadId || run.actionId !== this.current?.actionId
        || this.stopped || (!this.launching && !this.awaitingApproval && run.runId !== this.current.runId)) return;
      this.addHeader(run);
      this.tail.write(bytes);
    }));
  }

  /** Freeze ids and script hashes, retaining earlier exit-zero runs only when their scripts still match. */
  start(actions: readonly { actionId: string; script: string | null }[], previous: readonly ThreadStartupAction[]): Promise<void> {
    return this.enqueue(async () => {
      this.entries = actions.map(({ actionId, script }) => {
        const scriptHash = NodeCrypto.createHash("sha256").update(script ?? "").digest("hex");
        const prior = previous.find((entry) => entry.actionId === actionId && entry.scriptHash === scriptHash
          && (entry.outcome === "ready" || entry.outcome === "skipped"));
        return { actionId, scriptHash, runId: prior?.runId ?? null, outcome: prior ? "skipped" : "pending" };
      });
      if (await this.commit("running")) await this.next();
    });
  }

  /** Detach the gate from the sequence while leaving its action commands running. */
  async skip(): Promise<void> {
    this.stopped = "skip";
    await this.work;
    await this.tail.flush();
    this.detach();
  }

  /** Stop this attempt's command phases, including a launch already admitted, while retaining shells. */
  async cancel(): Promise<void> {
    this.stopped = "cancel";
    await this.work;
    this.detach();
    await this.tail.flush();
    for (const entry of this.entries) {
      const slot = { threadId: this.options.threadId, actionId: entry.actionId };
      const run = this.options.projectActions.get(slot);
      if (run?.runId === entry.runId && (run.status === "running" || run.status === "awaiting-approval")) {
        await this.options.projectActions.stop(slot);
      }
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.work.then(operation);
    this.work = next.catch((error: unknown) => {
      this.detach();
      this.options.onError(error);
    });
    return next;
  }

  private async next(): Promise<void> {
    if (this.stopped) return;
    this.current = this.entries.find((entry) => entry.outcome === "pending");
    if (!this.current) {
      await this.tail.flush();
      if (await this.commit("passed")) await this.options.passed();
      this.detach();
      return;
    }
    const slot = { threadId: this.options.threadId, actionId: this.current.actionId };
    const service = this.options.projectActions;
    this.launching = true;
    this.tail.resetDecoder();
    let run: WorkspaceEnvironmentActionRun;
    try {
      const options = { trigger: "startup" as const, expectedScriptHash: this.current.scriptHash };
      run = service.get(slot)?.terminalSessionId
        ? await service.restart(slot, options)
        : await service.start(slot, options);
    } catch (error) {
      await this.fail(undefined, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      this.launching = false;
    }
    this.current.runId = run.runId;
    await this.observe(run);
  }

  private async observe(run: WorkspaceEnvironmentActionRun): Promise<void> {
    const entry = this.acceptedEntry(run);
    if (!entry) return;
    entry.runId = run.runId;
    if (NodeCrypto.createHash("sha256").update(run.snapshot.script ?? "").digest("hex") !== entry.scriptHash) {
      await this.fail(undefined, "Startup action changed. Retry setup to use the current script.");
      return;
    }
    if (run.status === "awaiting-approval") {
      if (this.awaitingApproval) return;
      this.awaitingApproval = true;
      await this.commit("awaiting-approval");
      return;
    }
    this.awaitingApproval = false;
    if (run.startedAt) this.addHeader(run);
    if (run.status === "running") {
      if (entry.outcome !== "running") {
        entry.outcome = "running";
        await this.commit("running");
      }
      return;
    }
    await this.settleRun(run, entry);
  }

  private async settleRun(run: WorkspaceEnvironmentActionRun, entry: ThreadStartupAction): Promise<void> {
    await this.tail.flush();
    if (run.status === "completed" && run.exitCode === 0) {
      entry.outcome = "ready";
      if (await this.commit("running")) await this.next();
    } else {
      await this.fail(run.exitCode ?? undefined, this.tail.lastLine || "Startup action could not complete");
    }
  }

  private acceptedEntry(run: WorkspaceEnvironmentActionRun): ThreadStartupAction | undefined {
    const entry = this.current;
    if (this.stopped || !entry || run.actionId !== entry.actionId || run.trigger !== "startup") return undefined;
    if (run.runId !== entry.runId && !this.awaitingApproval) return undefined;
    if (entry.outcome === "ready" || entry.outcome === "failed") return undefined;
    return entry;
  }

  private addHeader(run: WorkspaceEnvironmentActionRun): void {
    if (this.headers.has(run.runId)) return;
    this.headers.add(run.runId);
    this.tail.header(`$ ${run.snapshot.script?.split(/\r?\n/, 1)[0] ?? run.actionName}`);
  }

  private async fail(exitCode: number | undefined, detail: string): Promise<void> {
    if (this.stopped || !this.current) return;
    this.current.outcome = "failed";
    await this.tail.flush();
    await this.commit("failed", { failedActionId: this.current.actionId, exitCode, detail: detail.trim().slice(0, 2000) || "Startup action failed" });
    this.detach();
  }

  private async commit(state: StartupActionTransition["state"], failure: Pick<StartupActionTransition, "failedActionId" | "exitCode" | "detail"> = {}): Promise<boolean> {
    if (this.stopped) return false;
    const applied = await this.options.transition({
      threadId: this.options.threadId, attemptId: this.options.attemptId,
      state, actions: this.entries.map((entry) => ({ ...entry })), ...failure,
    });
    if (!applied) this.detach();
    return applied;
  }

  private detach(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.tail.clearTimer();
  }
}

class StartupActionTail {
  private decoder = new TerminalPlainTextDecoder();
  private pending: string[] = [];
  private currentLine = "";
  private publishedLine = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  lastLine = "";

  constructor(
    private readonly append: (entries: string[]) => Promise<void>,
    private readonly enqueue: (operation: () => Promise<void>) => Promise<void>,
  ) {}

  header(line: string): void {
    this.pending.push(line.slice(0, 4095) + "\n");
    this.schedule();
  }

  resetDecoder(): void {
    this.decoder = new TerminalPlainTextDecoder();
    this.currentLine = "";
    this.publishedLine = "";
    this.lastLine = "";
  }

  write(bytes: Uint8Array): void {
    const decoded = this.decoder.write(bytes);
    this.currentLine = decoded.currentLine;
    for (const [index, line] of decoded.completedLines.entries()) {
      if (line.trim()) this.lastLine = line.trim();
      const text = index === 0 && line.startsWith(this.publishedLine) ? line.slice(this.publishedLine.length) : line;
      for (let offset = 0; offset < text.length + 1; offset += 4096) {
        this.pending.push((text + "\n").slice(offset, offset + 4096));
      }
    }
    if (decoded.completedLines.length) this.publishedLine = "";
    if (this.currentLine.trim()) this.lastLine = this.currentLine.trim();
    this.pending = this.pending.slice(-32);
    this.schedule();
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.currentLine && this.currentLine !== this.publishedLine) {
      const text = this.currentLine.startsWith(this.publishedLine)
        ? this.currentLine.slice(this.publishedLine.length) : this.currentLine;
      this.pending.push(text.slice(-4096));
      this.publishedLine = this.currentLine;
    }
    const entries = this.pending.splice(0).slice(-32);
    if (entries.length) await this.append(entries);
  }

  clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.flush()).catch(() => undefined);
    }, 250);
    this.timer.unref();
  }
}
