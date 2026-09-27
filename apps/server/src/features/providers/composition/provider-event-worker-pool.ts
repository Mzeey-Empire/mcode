import { logger } from "@mcode/shared";

import type { ProviderEventIngressDiagnostic } from "./provider-event-ingress.js";
import {
  isProviderEventWorkerTerminalTask,
  processProviderEventWorkerTask,
  type ProviderEventWorkerOutcome,
  type ProviderEventWorkerRequest,
  type ProviderEventWorkerResponse,
  type ProviderEventWorkerTask,
} from "./provider-event-worker-protocol.js";

/** Injection token for the server-owned fixed provider event preprocessing pool. */
export const PROVIDER_EVENT_WORKER_POOL = Symbol("ProviderEventWorkerPool");

/** Callback retained on the server side for one worker result. */
export interface ProviderEventWorkerCallbacks {
  onOutcome(outcome: ProviderEventWorkerOutcome): void;
}

/** Fixed-pool boundary for cloneable, CPU-bound provider event preprocessing. */
export interface ProviderEventWorkerPool {
  start(): void;
  submit(threadId: string, task: ProviderEventWorkerTask, callbacks: ProviderEventWorkerCallbacks): boolean;
  waitForThread(threadId: string): Promise<void>;
  shutdown(): void;
}

/** Synchronous test seam that preserves the old ingress timing outside server composition. */
export class InlineProviderEventWorkerPool implements ProviderEventWorkerPool {
  private stopped = false;

  start(): void {}

  submit(_threadId: string, task: ProviderEventWorkerTask, callbacks: ProviderEventWorkerCallbacks): boolean {
    if (this.stopped) return false;
    callbacks.onOutcome(processProviderEventWorkerTask(task));
    return true;
  }

  waitForThread(_threadId: string): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): void {
    this.stopped = true;
  }
}

/** The small subset of the Worker API needed by the pool and its focused tests. */
export interface ProviderEventWorkerPort {
  onmessage: ((event: MessageEvent<ProviderEventWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ProviderEventWorkerRequest): void;
  terminate(): void;
}

interface ScheduledTask {
  id: number;
  threadId: string;
  terminal: boolean;
  task: ProviderEventWorkerTask;
  callbacks: ProviderEventWorkerCallbacks;
}

interface ScheduledBatch {
  readonly tasks: readonly ScheduledTask[];
}

interface WorkerSlot {
  readonly index: number;
  worker: ProviderEventWorkerPort | undefined;
  generation: number;
  inFlight: ScheduledBatch | undefined;
  readonly queuedByThread: Map<string, ScheduledTask[]>;
  readonly readyThreadIds: string[];
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  restartAttempts: number;
  disabled: boolean;
}

/** Configures fixed-pool capacity and a test-only worker factory. */
export interface ThreadEventWorkerPoolOptions {
  workerCount?: number;
  /** Total retained tasks, including the terminal lifecycle reserve. */
  maxPending?: number;
  /** Retained terminal lifecycle tasks protected from non-terminal admission. */
  maxTerminalPending?: number;
  createWorker?: () => ProviderEventWorkerPort;
}

// Matches the fair ingress queue: 8,192 non-terminal events plus 32 reserved terminal events.
const DEFAULT_MAX_PENDING = 8_224;
const DEFAULT_MAX_TERMINAL_PENDING = 32;
const DEFAULT_WORKER_COUNT = 2;
const RESTART_DELAY_MS = 50;
const MAX_RESTART_ATTEMPTS = 3;
const MAX_BATCH_EVENTS = 32;

/**
 * Runs schema validation and safe event normalization on a fixed pool. Each
 * thread maps to one slot, so a worker processes that thread serially while
 * no database handle, dependency container, or callback crosses the boundary.
 */
export class ThreadEventWorkerPool implements ProviderEventWorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly pendingByThread = new Map<string, number>();
  private readonly slotsByThread = new Map<string, WorkerSlot>();
  private readonly idleWaitersByThread = new Map<string, Array<() => void>>();
  private readonly maxPending: number;
  private readonly maxNonTerminalPending: number;
  private readonly createWorker: () => ProviderEventWorkerPort;
  private pendingCount = 0;
  private pendingNonTerminalCount = 0;
  private nextRequestId = 1;
  private stopped = false;

  constructor(options: ThreadEventWorkerPoolOptions = {}) {
    const workerCount = positiveInteger(options.workerCount ?? defaultWorkerCount(), "Provider event worker count");
    this.maxPending = positiveInteger(options.maxPending ?? DEFAULT_MAX_PENDING, "Provider event worker capacity");
    const maxTerminalPending = positiveInteger(
      options.maxTerminalPending ?? DEFAULT_MAX_TERMINAL_PENDING,
      "Provider event worker terminal capacity",
    );
    if (maxTerminalPending > this.maxPending) {
      throw new Error("Provider event worker terminal capacity cannot exceed total capacity");
    }
    this.maxNonTerminalPending = this.maxPending - maxTerminalPending;
    this.createWorker = options.createWorker ?? createProviderEventWorker;
    this.slots = Array.from({ length: workerCount }, (_, index) => ({
      index,
      worker: undefined,
      generation: 0,
      inFlight: undefined,
      queuedByThread: new Map(),
      readyThreadIds: [],
      restartTimer: undefined,
      restartAttempts: 0,
      disabled: false,
    }));
  }

  /** Start the fixed worker set once provider subscriptions can enqueue payloads. */
  start(): void {
    for (const slot of this.slots) this.startSlot(slot);
  }

  /** Queue one payload on the slot selected for its active thread identity. */
  submit(threadId: string, task: ProviderEventWorkerTask, callbacks: ProviderEventWorkerCallbacks): boolean {
    const terminal = isProviderEventWorkerTerminalTask(task);
    if (this.stopped || !this.hasCapacityFor(terminal)) return false;
    this.start();
    const slot = this.slotFor(threadId);
    if (!slot) return false;
    const scheduled: ScheduledTask = {
      id: this.nextRequestId++,
      threadId,
      terminal,
      task,
      callbacks,
    };
    this.enqueue(slot, scheduled);
    this.incrementPending(scheduled);
    this.dispatch(slot);
    return true;
  }

  /** Resolve after every payload already accepted for one thread has a result. */
  waitForThread(threadId: string): Promise<void> {
    if (!this.pendingByThread.has(threadId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.idleWaitersByThread.get(threadId) ?? [];
      waiters.push(resolve);
      this.idleWaitersByThread.set(threadId, waiters);
    });
  }

  /** Stop accepting work, reject retained payloads, and terminate every worker. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const slot of this.slots) {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = undefined;
      const retained = [
        ...(slot.inFlight?.tasks ?? []),
        ...this.queuedTasks(slot),
      ];
      slot.inFlight = undefined;
      this.clearQueued(slot);
      slot.worker?.terminate();
      slot.worker = undefined;
      for (const scheduled of retained) {
        this.settle(scheduled, workerDiagnostic(scheduled.task, "worker-shutdown"));
      }
    }
  }

  private startSlot(slot: WorkerSlot): void {
    if (this.stopped || slot.worker || slot.disabled) return;
    try {
      const worker = this.createWorker();
      slot.generation += 1;
      const generation = slot.generation;
      worker.onmessage = (event) => this.handleMessage(slot, generation, event.data);
      worker.onerror = () => this.recover(slot, generation);
      slot.worker = worker;
      this.dispatch(slot);
    } catch (error) {
      logger.error("Provider event worker could not start", {
        workerIndex: slot.index,
        error: error instanceof Error ? error.message : String(error),
      });
      this.restartOrReject(slot);
    }
  }

  private dispatch(slot: WorkerSlot): void {
    if (this.stopped || !slot.worker || slot.inFlight || slot.readyThreadIds.length === 0) return;
    const tasks = this.takeBatch(slot);
    if (tasks.length === 0) return;
    slot.inFlight = { tasks };
    try {
      slot.worker.postMessage({
        requestIds: tasks.map((task) => task.id),
        tasks: tasks.map((task) => task.task),
      });
    } catch (error) {
      logger.warn("Provider event worker rejected a payload", {
        workerIndex: slot.index,
        error: error instanceof Error ? error.message : String(error),
      });
      this.settleInFlight(slot, tasks.map((task) => workerDiagnostic(task.task, "worker-failure")));
    }
  }

  private handleMessage(
    slot: WorkerSlot,
    generation: number,
    response: ProviderEventWorkerResponse,
  ): void {
    if (this.stopped || slot.generation !== generation) return;
    const scheduled = slot.inFlight;
    if (!scheduled || !matchesWorkerResponse(scheduled, response)) {
      this.recover(slot, generation);
      return;
    }
    slot.restartAttempts = 0;
    this.settleInFlight(slot, response.outcomes);
  }

  private recover(slot: WorkerSlot, generation: number): void {
    if (this.stopped || slot.generation !== generation) return;
    slot.generation += 1;
    const inFlight = slot.inFlight;
    slot.inFlight = undefined;
    if (inFlight) this.prependAll(slot, inFlight.tasks);
    slot.worker?.terminate();
    slot.worker = undefined;
    logger.warn("Provider event worker crashed; replaying its retained payload", {
      workerIndex: slot.index,
    });
    this.restartOrReject(slot);
  }

  private restartOrReject(slot: WorkerSlot): void {
    if (this.stopped || slot.restartTimer || slot.disabled) return;
    if (slot.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      slot.disabled = true;
      const retained = this.queuedTasks(slot);
      this.clearQueued(slot);
      for (const scheduled of retained) {
        this.settle(scheduled, workerDiagnostic(scheduled.task, "worker-failure"));
      }
      logger.error("Provider event worker exhausted restart attempts", {
        workerIndex: slot.index,
        restartAttempts: slot.restartAttempts,
      });
      return;
    }
    slot.restartAttempts += 1;
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined;
      this.startSlot(slot);
    }, RESTART_DELAY_MS);
  }

  private settleInFlight(slot: WorkerSlot, outcomes: readonly ProviderEventWorkerOutcome[]): void {
    const batch = slot.inFlight;
    slot.inFlight = undefined;
    let callbackFailure: unknown;
    if (batch) {
      for (const [index, scheduled] of batch.tasks.entries()) {
        const outcome = outcomes[index];
        if (!outcome) throw new Error("Provider event worker omitted a batch outcome");
        try {
          this.settle(scheduled, outcome);
        } catch (error) {
          callbackFailure ??= error;
        }
      }
    }
    this.dispatch(slot);
    if (callbackFailure) throw callbackFailure;
  }

  private settle(scheduled: ScheduledTask, outcome: ProviderEventWorkerOutcome): void {
    try {
      scheduled.callbacks.onOutcome(outcome);
    } finally {
      this.decrementPending(scheduled);
    }
  }

  private slotFor(threadId: string): WorkerSlot | undefined {
    const existing = this.slotsByThread.get(threadId);
    if (existing) return existing;
    const occupied = new Set(this.slotsByThread.values());
    const activeSlots = this.slots.filter((slot) => !slot.disabled);
    if (activeSlots.length === 0) return undefined;
    const vacant = activeSlots.find((slot) => !occupied.has(slot));
    const slot = vacant ?? activeSlots[threadHash(threadId, activeSlots.length)]!;
    this.slotsByThread.set(threadId, slot);
    return slot;
  }

  private enqueue(slot: WorkerSlot, scheduled: ScheduledTask): void {
    const queue = slot.queuedByThread.get(scheduled.threadId);
    if (queue) {
      queue.push(scheduled);
      return;
    }
    slot.queuedByThread.set(scheduled.threadId, [scheduled]);
    slot.readyThreadIds.push(scheduled.threadId);
  }

  private prependAll(slot: WorkerSlot, scheduled: readonly ScheduledTask[]): void {
    for (const task of [...scheduled].reverse()) {
      const queue = slot.queuedByThread.get(task.threadId);
      if (queue) {
        queue.unshift(task);
        continue;
      }
      slot.queuedByThread.set(task.threadId, [task]);
      slot.readyThreadIds.unshift(task.threadId);
    }
  }

  private takeBatch(slot: WorkerSlot): ScheduledTask[] {
    const tasks: ScheduledTask[] = [];
    while (tasks.length < MAX_BATCH_EVENTS) {
      const threadId = slot.readyThreadIds.shift();
      if (!threadId) break;
      const queue = slot.queuedByThread.get(threadId);
      const task = queue?.shift();
      if (!queue || !task) continue;
      tasks.push(task);
      if (queue.length > 0) slot.readyThreadIds.push(threadId);
      else slot.queuedByThread.delete(threadId);
    }
    return tasks;
  }

  private queuedTasks(slot: WorkerSlot): ScheduledTask[] {
    return [...slot.queuedByThread.values()].flat();
  }

  private clearQueued(slot: WorkerSlot): void {
    slot.queuedByThread.clear();
    slot.readyThreadIds.length = 0;
  }

  private hasCapacityFor(terminal: boolean): boolean {
    if (this.pendingCount >= this.maxPending) return false;
    return terminal || this.pendingNonTerminalCount < this.maxNonTerminalPending;
  }

  private incrementPending(scheduled: ScheduledTask): void {
    this.pendingCount += 1;
    if (!scheduled.terminal) this.pendingNonTerminalCount += 1;
    this.pendingByThread.set(scheduled.threadId, (this.pendingByThread.get(scheduled.threadId) ?? 0) + 1);
  }

  private decrementPending(scheduled: ScheduledTask): void {
    this.pendingCount -= 1;
    if (!scheduled.terminal) this.pendingNonTerminalCount -= 1;
    const remaining = (this.pendingByThread.get(scheduled.threadId) ?? 1) - 1;
    if (remaining > 0) {
      this.pendingByThread.set(scheduled.threadId, remaining);
      return;
    }
    this.pendingByThread.delete(scheduled.threadId);
    this.slotsByThread.delete(scheduled.threadId);
    const waiters = this.idleWaitersByThread.get(scheduled.threadId) ?? [];
    this.idleWaitersByThread.delete(scheduled.threadId);
    for (const resolve of waiters) resolve();
  }
}

function threadHash(threadId: string, slotCount: number): number {
  let hash = 0;
  for (let index = 0; index < threadId.length; index += 1) {
    hash = ((hash * 31) + threadId.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) % slotCount;
}

function matchesWorkerResponse(batch: ScheduledBatch, response: ProviderEventWorkerResponse): boolean {
  if (batch.tasks.length !== response.requestIds.length || batch.tasks.length !== response.outcomes.length) return false;
  return batch.tasks.every((task, index) => task.id === response.requestIds[index]);
}

function defaultWorkerCount(): number {
  return DEFAULT_WORKER_COUNT;
}

function positiveInteger(value: number, description: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${description} must be a positive integer`);
  return value;
}

function createProviderEventWorker(): ProviderEventWorkerPort {
  const workerFile = import.meta.url.endsWith(".cjs")
    ? "./provider-event.worker.cjs"
    : "./provider-event.worker.ts";
  return new Worker(
    new URL(workerFile, import.meta.url),
    { type: "module" },
  );
}

function workerDiagnostic(
  task: ProviderEventWorkerTask,
  reason: Extract<ProviderEventIngressDiagnostic["reason"], "worker-failure" | "worker-shutdown">,
): ProviderEventWorkerOutcome {
  return {
    status: "rejected",
    diagnostic: {
      reason,
      sourceKind: task.kind,
    },
  };
}
