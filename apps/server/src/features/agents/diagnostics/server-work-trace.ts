import * as NodePerfHooks from "node:perf_hooks";
import { logger } from "@mcode/shared";

/** Fixed names keep trace output free of event bodies and provider text. */
export type ServerWorkPhase =
  | "provider-callback" | "worker-admission" | "worker-wait" | "mailbox-wait"
  | "canonical-write" | "event-apply" | "finalization" | "publication"
  | "terminal-create" | "thread-create" | "agent-send";

interface WorkSample {
  phase: ServerWorkPhase;
  threadId: string | null;
  executionId: string | null;
  count: number;
  totalMs: number;
  maxMs: number;
}

/** One bounded report for work accumulated while the server loop could not run. */
export type ServerWorkTraceReport = {
  kind: "server-work-stall";
  at: number;
  delayMs: number;
  windowMs: number;
  samples: WorkSample[];
  overflowCount: number;
} | {
  kind: "server-work-slow-operation";
  at: number;
  sample: WorkSample;
};

const MAX_KEYS = 64;
const INTERVAL_MS = 20;
const REPORT_DELAY_MS = 100;
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(value: string | undefined): string | null {
  return value && TRACE_ID.test(value) ? value : null;
}

/** Aggregates fixed-phase timings in memory and emits only delayed loop windows. */
export class ServerWorkTrace {
  private readonly samples = new Map<string, WorkSample>();
  private overflowCount = 0;
  private lastTick = NodePerfHooks.performance.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly emit: (report: ServerWorkTraceReport) => void) {}

  /** Begin the lightweight event-loop probe. */
  start(): void {
    if (this.timer) return;
    this.lastTick = NodePerfHooks.performance.now();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  /** Stop the probe and discard its pending window. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.samples.clear();
    this.overflowCount = 0;
  }

  /** Measure synchronous work without retaining its input or result. */
  measure<T>(phase: ServerWorkPhase, threadId: string | undefined, executionId: string | undefined, work: () => T): T {
    const started = NodePerfHooks.performance.now();
    try {
      return work();
    } finally {
      this.record(phase, threadId, executionId, NodePerfHooks.performance.now() - started);
    }
  }

  /** Record an asynchronous wait or a measured operation after completion. */
  record(phase: ServerWorkPhase, threadId: string | undefined, executionId: string | undefined, durationMs: number): void {
    const safeThreadId = safeId(threadId);
    const safeExecutionId = safeId(executionId);
    if (this.isSlowOperation(phase, durationMs)) {
      this.emit({ kind: "server-work-slow-operation", at: Date.now(), sample: {
        phase, threadId: safeThreadId, executionId: safeExecutionId,
        count: 1, totalMs: durationMs, maxMs: durationMs,
      } });
    }
    const key = JSON.stringify([phase, safeThreadId, safeExecutionId]);
    const sample = this.samples.get(key);
    if (sample) {
      sample.count += 1;
      sample.totalMs += durationMs;
      sample.maxMs = Math.max(sample.maxMs, durationMs);
      return;
    }
    if (this.samples.size === MAX_KEYS) {
      this.overflowCount += 1;
      return;
    }
    this.samples.set(key, {
      phase, threadId: safeThreadId, executionId: safeExecutionId,
      count: 1, totalMs: durationMs, maxMs: durationMs,
    });
  }

  private isSlowOperation(phase: ServerWorkPhase, durationMs: number): boolean {
    return durationMs >= REPORT_DELAY_MS
      && (phase === "terminal-create" || phase === "thread-create" || phase === "agent-send");
  }

  /** Check a single probe interval; exposed to drive deterministic stall tests. */
  tick(now: number = NodePerfHooks.performance.now()): void {
    const windowMs = now - this.lastTick;
    this.lastTick = now;
    const delayMs = Math.max(0, windowMs - INTERVAL_MS);
    if (delayMs >= REPORT_DELAY_MS) {
      this.emit({ kind: "server-work-stall", at: Date.now(), delayMs, windowMs, samples: [...this.samples.values()], overflowCount: this.overflowCount });
    }
    this.samples.clear();
    this.overflowCount = 0;
  }
}

/** Null unless explicitly enabled before server startup. */
export const serverWorkTrace = process.env.MCODE_SERVER_WORK_TRACE === "1"
  ? new ServerWorkTrace((report) => logger.warn("Server work trace", report))
  : null;

serverWorkTrace?.start();
