import * as NodePerfHooks from "node:perf_hooks";
import { logger } from "@mcode/shared";

/** Fixed names keep trace output free of event bodies and provider text. */
export type ServerWorkPhase =
  | "provider-callback" | "worker-admission" | "worker-wait" | "mailbox-wait"
  | "canonical-write" | "event-apply" | "narrative-checkpoint"
  | "assistant-text-write"
  | "narrative-prepare" | "narrative-persist" | "narrative-confirm"
  | "finalization" | "publication"
  | "terminal-create" | "thread-create" | "agent-send";

/** Fixed event categories; unknown and future event types stay in other. */
export type EventApplyType = "textDelta" | "toolUse" | "toolResult" | "assistantMessageBoundary" | "other";

/** Classify only the event discriminant, never an event payload. */
export function eventApplyType(type: string): EventApplyType {
  switch (type) {
    case "textDelta":
    case "toolUse":
    case "toolResult":
    case "assistantMessageBoundary":
      return type;
    default:
      return "other";
  }
}

interface EventApplyTotals {
  count: number;
  totalMs: number;
  maxMs: number;
}

type NarrativeCheckpointStep = "narrative-prepare" | "narrative-persist" | "narrative-confirm";

function emptyNarrativeStepTotals(): Record<NarrativeCheckpointStep, EventApplyTotals> {
  return {
    "narrative-prepare": { count: 0, totalMs: 0, maxMs: 0 },
    "narrative-persist": { count: 0, totalMs: 0, maxMs: 0 },
    "narrative-confirm": { count: 0, totalMs: 0, maxMs: 0 },
  };
}

function emptyEventApplyTotals(): Record<EventApplyType, EventApplyTotals> {
  return {
    textDelta: { count: 0, totalMs: 0, maxMs: 0 },
    toolUse: { count: 0, totalMs: 0, maxMs: 0 },
    toolResult: { count: 0, totalMs: 0, maxMs: 0 },
    assistantMessageBoundary: { count: 0, totalMs: 0, maxMs: 0 },
    other: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

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
  eventApplyByType: Record<EventApplyType, EventApplyTotals>;
  narrativeCheckpoint: EventApplyTotals;
  narrativeCheckpointByStep: Record<NarrativeCheckpointStep, EventApplyTotals>;
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
  private eventApplyByType = emptyEventApplyTotals();
  private narrativeCheckpoint: EventApplyTotals = { count: 0, totalMs: 0, maxMs: 0 };
  private narrativeCheckpointByStep = emptyNarrativeStepTotals();
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
    this.eventApplyByType = emptyEventApplyTotals();
    this.narrativeCheckpoint = { count: 0, totalMs: 0, maxMs: 0 };
    this.narrativeCheckpointByStep = emptyNarrativeStepTotals();
    this.overflowCount = 0;
  }

  /** Measure synchronous work without retaining its input or result. */
  measure<T>(phase: ServerWorkPhase, threadId: string | undefined, executionId: string | undefined, work: () => T, applyType?: EventApplyType): T {
    const started = NodePerfHooks.performance.now();
    try {
      return work();
    } finally {
      this.record(phase, threadId, executionId, NodePerfHooks.performance.now() - started, applyType);
    }
  }

  /** Record an asynchronous wait or a measured operation after completion. */
  record(phase: ServerWorkPhase, threadId: string | undefined, executionId: string | undefined, durationMs: number, applyType?: EventApplyType): void {
    if (phase === "event-apply" && applyType) {
      const total = this.eventApplyByType[applyType];
      total.count += 1;
      total.totalMs += durationMs;
      total.maxMs = Math.max(total.maxMs, durationMs);
    }
    if (phase === "narrative-checkpoint") {
      this.narrativeCheckpoint.count += 1;
      this.narrativeCheckpoint.totalMs += durationMs;
      this.narrativeCheckpoint.maxMs = Math.max(this.narrativeCheckpoint.maxMs, durationMs);
    }
    if (phase === "narrative-prepare" || phase === "narrative-persist" || phase === "narrative-confirm") {
      const total = this.narrativeCheckpointByStep[phase];
      total.count += 1;
      total.totalMs += durationMs;
      total.maxMs = Math.max(total.maxMs, durationMs);
    }
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
      this.emit({ kind: "server-work-stall", at: Date.now(), delayMs, windowMs, samples: [...this.samples.values()], eventApplyByType: this.eventApplyByType, narrativeCheckpoint: this.narrativeCheckpoint, narrativeCheckpointByStep: this.narrativeCheckpointByStep, overflowCount: this.overflowCount });
    }
    this.samples.clear();
    this.eventApplyByType = emptyEventApplyTotals();
    this.narrativeCheckpoint = { count: 0, totalMs: 0, maxMs: 0 };
    this.narrativeCheckpointByStep = emptyNarrativeStepTotals();
    this.overflowCount = 0;
  }
}

/** Null unless explicitly enabled before server startup. */
export const serverWorkTrace = process.env.MCODE_SERVER_WORK_TRACE === "1"
  ? new ServerWorkTrace((report) => logger.warn("Server work trace", report))
  : null;

serverWorkTrace?.start();
