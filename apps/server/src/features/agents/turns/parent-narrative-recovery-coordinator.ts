import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import type { ParentTurnDurability, ParentNarrativeRecoveryCommit } from "./parent-turn-durability.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { serverWorkTrace } from "../diagnostics/server-work-trace.js";
import { NarrativeRecoveryDelta } from "./narrative-recovery-delta.js";
import { assertActiveTurnRecoveryRetention } from "./active-turn-recovery-retention-policy.js";
import { logger } from "@mcode/shared";
import * as NodeCrypto from "node:crypto";
import type { NarrativeRecoveryChanges } from "../conversation/narrative/narrative-turn-state.js";

/** A prepared ordered recovery command whose confirmation releases the next snapshot. */
export interface PreparedParentNarrativeRecoveryCheckpoint {
  operationId: string;
  input: ParentNarrativeRecoveryCommit;
  persist(): Promise<void>;
  confirm(): void;
}

interface RecoveryCompletion {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface OrderedRecoveryJob {
  operationId: string;
  executionId: string;
  bytes: number;
  external: boolean;
  settled: boolean;
  attempts: number;
  completion: RecoveryCompletion;
  ready: Promise<PreparedParentNarrativeRecoveryCheckpoint>;
  inFlight?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_RECOVERY_JOBS = 64;
const MAX_PENDING_RECOVERY_BYTES = 2 * 1024 * 1024;

function recoveryCompletion(): RecoveryCompletion {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((saved, failed) => { resolve = saved; reject = failed; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Prepares structured narrative recovery and confirms deduplication only after its writer commit. */
export class ParentNarrativeRecoveryCoordinator {
  private readonly deltasByExecution = new Map<string, NarrativeRecoveryDelta>();
  private readonly acceptedDeltasByExecution = new Map<string, NarrativeRecoveryDelta>();
  private readonly jobsByExecution = new Map<string, OrderedRecoveryJob[]>();
  private retainedJobs = 0;
  private retainedBytes = 0;
  private closing = false;

  constructor(
    private readonly canonicalSink: Pick<ParentTurnDurability, "loadTurnByExecution" | "recordParentNarrativeRecovery">,
    private readonly narrativeStore: Pick<NarrativeStore, "terminalSnapshot">,
  ) {}

  /** Capture accepted state now, then prepare and acknowledge it after preceding recovery commits. */
  checkpoint(event: AgentEvent): Promise<void> {
    if (!this.canCheckpoint(event)) return Promise.resolve();
    const job = this.reserve(event, this.narrativeStore.terminalSnapshot(event.threadId), false);
    return job ? this.startAttempt(job)
      : this.jobsByExecution.get(event.turnExecutionId!)?.at(-1)?.completion.promise ?? Promise.resolve();
  }

  /** Install a text-generation fence immediately while its recovery preparation waits for earlier confirmations. */
  runOrdered(event: AgentEvent, snapshot: readonly ParentNarrativeRecoveryItem[] | undefined,
    install: (ready: Promise<PreparedParentNarrativeRecoveryCheckpoint>) => Promise<void>): Promise<void> {
    if (!this.canCheckpoint(event)) throw new Error("Narrative classification has no canonical parent execution");
    const job = this.reserve(event, snapshot ?? this.narrativeStore.terminalSnapshot(event.threadId), true);
    if (!job) throw new Error("Narrative classification did not reserve its save fence");
    try { return install(job.ready); }
    catch (error) { job.completion.reject(error); throw error; }
  }

  /** Drain recovery heads and text fences together after producers stop, reporting every retained failure. */
  async close(closeClassifications: () => Promise<void>): Promise<void> {
    this.closing = true;
    const jobs = [...this.jobsByExecution.values()].flat();
    for (const job of jobs) this.cancelRetry(job);
    const attempts = jobs.filter((job) => !job.external)
      .map((job) => job.inFlight ?? this.startAttempt(job));
    const classifications = closeClassifications().catch((error: unknown) => {
      for (const job of jobs) if (job.external && !job.settled) job.completion.reject(error);
      throw error;
    });
    const results = await Promise.allSettled([classifications, ...attempts]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.retainedJobs > 0) throw new Error("Narrative recovery closed with retained unsaved checkpoints");
  }

  private canCheckpoint(event: AgentEvent): boolean {
    return this.requiresStructuredRecovery(event) && !!event.turnExecutionId
      && !!this.canonicalSink.loadTurnByExecution(event.turnExecutionId);
  }

  private reserve(event: AgentEvent, snapshot: readonly ParentNarrativeRecoveryItem[], external: boolean): OrderedRecoveryJob | null {
    if (this.closing) throw new Error("Narrative recovery queue is closing");
    const executionId = event.turnExecutionId!;
    const jobs = this.executionJobs(executionId);
    const accepted = this.acceptedDeltasByExecution.get(executionId) ?? new NarrativeRecoveryDelta();
    const prepared = accepted.prepare(snapshot);
    if (!prepared && !external) return null;
    const changes = { items: prepared?.items ?? [], discardedItemIds: prepared?.discardedItemIds ?? [] };
    const job = this.reserveChanges(event, changes, external, jobs);
    prepared?.acknowledge();
    this.acceptedDeltasByExecution.set(executionId, accepted);
    return job;
  }

  private executionJobs(executionId: string): OrderedRecoveryJob[] {
    const jobs = this.jobsByExecution.get(executionId) ?? [];
    const head = jobs[0];
    if (head && !head.external && !head.inFlight) this.retry(head);
    return jobs;
  }

  private reserveChanges(event: AgentEvent, changes: NarrativeRecoveryChanges, external: boolean,
    jobs: OrderedRecoveryJob[]): OrderedRecoveryJob {
    const bytes = Buffer.byteLength(JSON.stringify(changes), "utf8");
    assertActiveTurnRecoveryRetention(changes.items.length + changes.discardedItemIds.length, bytes);
    if (this.retainedJobs >= MAX_PENDING_RECOVERY_JOBS || this.retainedBytes + bytes > MAX_PENDING_RECOVERY_BYTES) {
      throw new Error("Narrative recovery retained save capacity reached");
    }
    const completion = recoveryCompletion();
    const captured = structuredClone(changes);
    const previous = jobs.at(-1)?.completion.promise ?? Promise.resolve();
    const executionId = event.turnExecutionId!;
    const job: OrderedRecoveryJob = { operationId: "main-classification:" + NodeCrypto.randomUUID(),
      executionId, bytes, external, settled: false, attempts: 0,
      completion, ready: previous.then(() => this.prepareOrderedCheckpoint(event, captured, job)) };
    void job.ready.catch(() => undefined);
    jobs.push(job);
    this.jobsByExecution.set(executionId, jobs);
    this.retainedJobs += 1;
    this.retainedBytes += bytes;
    return job;
  }

  private prepareOrderedCheckpoint(
    event: AgentEvent,
    changes: NarrativeRecoveryChanges,
    job: OrderedRecoveryJob,
  ): PreparedParentNarrativeRecoveryCheckpoint {
    const executionId = job.executionId;
    if (job.settled) return { operationId: job.operationId, input: { executionId, items: [], discardedItemIds: [] },
      persist: () => Promise.resolve(), confirm: () => {} };
    const delta = this.deltasByExecution.get(executionId) ?? new NarrativeRecoveryDelta();
    const prepare = () => delta.prepareChanges(changes);
    const prepared = serverWorkTrace
      ? serverWorkTrace.measure("narrative-prepare", event.threadId, executionId, prepare) : prepare();
    this.deltasByExecution.set(executionId, delta);
    const input = { executionId, items: prepared?.items ?? [], discardedItemIds: prepared?.discardedItemIds ?? [] };
    return {
      operationId: job.operationId,
      input,
      persist: async () => {
        if (!prepared || job.settled) return;
        const committed = await this.canonicalSink.recordParentNarrativeRecovery(input);
        if (!committed) {
          throw new Error(`Canonical parent turn was not found: ${executionId}`);
        }
      },
      confirm: () => {
        if (job.settled) return;
        prepared?.acknowledge();
        this.release(job);
      },
    };
  }

  private startAttempt(job: OrderedRecoveryJob): Promise<void> {
    this.cancelRetry(job);
    const task = job.ready.then(async (checkpoint) => { await checkpoint.persist(); checkpoint.confirm(); });
    job.inFlight = task.catch((error: unknown) => {
      this.retainFailure(job, error);
      throw error;
    }).finally(() => { job.inFlight = undefined; });
    return job.inFlight;
  }

  private retainFailure(job: OrderedRecoveryJob, error: unknown): void {
    if (job.settled) return;
    job.attempts += 1;
    if (this.closing) { job.completion.reject(error); return; }
    if (job.attempts < 6) job.retryTimer = setTimeout(() => this.retry(job), 1_000);
  }

  private retry(job: OrderedRecoveryJob): void {
    if (job.settled || job.inFlight) return;
    void this.startAttempt(job).catch((error: unknown) => logger.warn("Narrative recovery save remains retained", {
      executionId: job.executionId, error: error instanceof Error ? error.message : String(error),
    }));
  }

  private cancelRetry(job: OrderedRecoveryJob): void {
    if (job.retryTimer !== undefined) clearTimeout(job.retryTimer);
    job.retryTimer = undefined;
  }

  private release(job: OrderedRecoveryJob): void {
    if (job.settled) return;
    this.cancelRetry(job);
    job.settled = true;
    this.retainedJobs -= 1;
    this.retainedBytes -= job.bytes;
    const jobs = this.jobsByExecution.get(job.executionId);
    if (jobs) {
      const index = jobs.indexOf(job);
      if (index >= 0) jobs.splice(index, 1);
      if (jobs.length === 0) this.jobsByExecution.delete(job.executionId);
    }
    job.completion.resolve();
  }

  /** Forget volatile dedupe state after a terminal turn releases its buffers. */
  clear(executionId: string | undefined): void {
    if (!executionId) return;
    const jobs = this.jobsByExecution.get(executionId)?.slice() ?? [];
    for (const job of jobs) this.release(job);
    this.deltasByExecution.delete(executionId);
    this.acceptedDeltasByExecution.delete(executionId);
  }

  private requiresStructuredRecovery(event: AgentEvent): boolean {
    return event.type === AgentEventType.TextDelta
      || event.type === AgentEventType.AssistantMessageBoundary
      || event.type === AgentEventType.ToolUse
      || event.type === AgentEventType.ToolResult
      || event.type === AgentEventType.HookStarted
      || event.type === AgentEventType.HookCompleted;
  }
}
