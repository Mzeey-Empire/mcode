import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import {
  InlineProviderEventWorkerPool,
  ThreadEventWorkerPool,
  type ProviderEventWorkerPool,
} from "../src/features/providers/composition/provider-event-worker-pool.js";
import type {
  ProviderEventWorkerOutcome,
  ProviderEventWorkerTask,
} from "../src/features/providers/composition/provider-event-worker-protocol.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

interface BenchmarkOptions {
  eventCount: number;
  payloadBytes: number;
  sampleCount: number;
  threadCount: number;
  workerCount: number;
  outputPath: string | undefined;
}

interface Sample {
  mainTurnDelayMs: number;
  submitDurationMs: number;
  completionDurationMs: number;
}

interface Summary {
  medianMs: number;
  p95Ms: number;
}

interface BenchmarkResult {
  sourceRevision: string;
  workingTreeDirty: boolean;
  environment: {
    runtime: string;
    workerCount: number;
    threadCount: number;
    eventCount: number;
    payloadBytes: number;
    sampleCount: number;
  };
  inline: Sample[];
  workerPool: Sample[];
  summaries: {
    inline: Record<keyof Sample, Summary>;
    workerPool: Record<keyof Sample, Summary>;
  };
}

const options = parseOptions(process.argv.slice(2));
const tasks = createTasks(options);
const { inline, workerPool } = await collectPairedSamples(
  tasks,
  options.sampleCount,
  options.workerCount,
);
const result: BenchmarkResult = {
  sourceRevision: sourceRevision(),
  workingTreeDirty: workingTreeDirty(),
  environment: {
    runtime: process.version,
    workerCount: options.workerCount,
    threadCount: options.threadCount,
    eventCount: options.eventCount,
    payloadBytes: options.payloadBytes,
    sampleCount: options.sampleCount,
  },
  inline,
  workerPool,
  summaries: {
    inline: summarizeSamples(inline),
    workerPool: summarizeSamples(workerPool),
  },
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (options.outputPath) {
  NodeFS.mkdirSync(NodePath.dirname(options.outputPath), { recursive: true });
  NodeFS.writeFileSync(options.outputPath, serialized, "utf8");
}
process.stdout.write(serialized);

async function collectPairedSamples(
  tasksByThread: ReadonlyMap<string, readonly ProviderEventWorkerTask[]>,
  sampleCount: number,
  workerCount: number,
): Promise<{ inline: Sample[]; workerPool: Sample[] }> {
  const inlinePool = new InlineProviderEventWorkerPool();
  const workerPool = new ThreadEventWorkerPool({ workerCount });
  inlinePool.start();
  workerPool.start();
  try {
    await Promise.all([warmPool(inlinePool, tasksByThread), warmPool(workerPool, tasksByThread)]);
    const inline: Sample[] = [];
    const worker: Sample[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      if (sample % 2 === 0) {
        inline.push(await runSample(inlinePool, tasksByThread));
        worker.push(await runSample(workerPool, tasksByThread));
      } else {
        worker.push(await runSample(workerPool, tasksByThread));
        inline.push(await runSample(inlinePool, tasksByThread));
      }
    }
    return { inline, workerPool: worker };
  } finally {
    inlinePool.shutdown();
    workerPool.shutdown();
  }
}

async function runSample(
  pool: ProviderEventWorkerPool,
  tasksByThread: ReadonlyMap<string, readonly ProviderEventWorkerTask[]>,
): Promise<Sample> {
  let rejected = 0;
  const sampleStartedAt = NodePerfHooks.performance.now();
  const mainTurn = new Promise<number>((resolve) => {
    setImmediate(() => resolve(NodePerfHooks.performance.now() - sampleStartedAt));
  });
  for (const [threadId, tasks] of tasksByThread) {
    for (const task of tasks) {
      const accepted = pool.submit(threadId, task, {
        onOutcome: (outcome) => {
          if (outcome.status === "rejected") rejected += 1;
        },
      });
      if (!accepted) throw new Error("Provider event worker benchmark exceeded pool capacity");
    }
  }
  const submitDurationMs = NodePerfHooks.performance.now() - sampleStartedAt;
  const completion = Promise.all([...tasksByThread.keys()].map((threadId) => pool.waitForThread(threadId)));
  const [mainTurnDelayMs] = await Promise.all([mainTurn, completion]);
  if (rejected > 0) throw new Error(`Provider event worker benchmark rejected ${rejected} valid events`);
  return {
    mainTurnDelayMs,
    submitDurationMs,
    completionDurationMs: NodePerfHooks.performance.now() - sampleStartedAt,
  };
}

async function warmPool(
  pool: ProviderEventWorkerPool,
  tasksByThread: ReadonlyMap<string, readonly ProviderEventWorkerTask[]>,
): Promise<void> {
  for (const [threadId, tasks] of tasksByThread) {
    const task = tasks[0];
    if (!task) continue;
    const accepted = pool.submit(threadId, task, {
      onOutcome: rejectWarmupFailure,
    });
    if (!accepted) throw new Error("Provider event worker benchmark could not queue its warmup payload");
  }
  await Promise.all([...tasksByThread.keys()].map((threadId) => pool.waitForThread(threadId)));
}

function rejectWarmupFailure(outcome: ProviderEventWorkerOutcome): void {
  if (outcome.status === "rejected") throw new Error("Provider event worker benchmark warmup rejected a valid event");
}

function createTasks(options: BenchmarkOptions): ReadonlyMap<string, readonly ProviderEventWorkerTask[]> {
  const tasksByThread = new Map<string, ProviderEventWorkerTask[]>();
  const payload = "x".repeat(options.payloadBytes);
  for (let index = 0; index < options.eventCount; index += 1) {
    const threadId = `benchmark-thread-${index % options.threadCount}`;
    const tasks = tasksByThread.get(threadId) ?? [];
    tasks.push({
      kind: "provider-runtime",
      providerId: "claude",
      runtimeEvent: {
        event: {
          type: "textDelta",
          threadId,
          turnExecutionId: EXECUTION_ID,
          delta: payload,
        },
      },
    });
    tasksByThread.set(threadId, tasks);
  }
  return tasksByThread;
}

function summarizeSamples(samples: readonly Sample[]): Record<keyof Sample, Summary> {
  return {
    mainTurnDelayMs: summary(samples.map((sample) => sample.mainTurnDelayMs)),
    submitDurationMs: summary(samples.map((sample) => sample.submitDurationMs)),
    completionDurationMs: summary(samples.map((sample) => sample.completionDurationMs)),
  };
}

function summary(values: readonly number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index]?.toFixed(3));
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !value || !key.startsWith("--")) throw new Error("Expected --name value benchmark arguments");
    values.set(key.slice(2), value);
  }
  return {
    eventCount: positiveInteger(values.get("event-count"), 500),
    payloadBytes: positiveInteger(values.get("payload-bytes"), 32 * 1024),
    sampleCount: positiveInteger(values.get("sample-count"), 7),
    threadCount: positiveInteger(values.get("thread-count"), 7),
    workerCount: positiveInteger(values.get("worker-count"), 2),
    outputPath: values.get("output"),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

function sourceRevision(): string {
  const result = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function workingTreeDirty(): boolean {
  const result = NodeChildProcess.spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return result.status !== 0 || result.stdout.length > 0;
}
