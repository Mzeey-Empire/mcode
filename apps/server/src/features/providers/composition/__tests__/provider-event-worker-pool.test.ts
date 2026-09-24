import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ThreadEventWorkerPool,
  type ProviderEventWorkerPort,
} from "../provider-event-worker-pool.js";
import type {
  ProviderEventWorkerOutcome,
  ProviderEventWorkerRequest,
  ProviderEventWorkerResponse,
  ProviderEventWorkerTask,
} from "../provider-event-worker-protocol.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

class FakeWorker implements ProviderEventWorkerPort {
  onmessage: ((event: MessageEvent<ProviderEventWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: ProviderEventWorkerRequest[] = [];
  terminated = false;

  postMessage(message: ProviderEventWorkerRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(request: ProviderEventWorkerRequest, outcomes: readonly ProviderEventWorkerOutcome[]): void {
    this.onmessage?.(new MessageEvent("message", {
      data: { requestIds: request.requestIds, outcomes },
    }));
  }

  crash(): void {
    this.onerror?.(new ErrorEvent("error"));
  }
}

function runtimeTask(threadId: string): ProviderEventWorkerTask {
  return {
    kind: "provider-runtime",
    providerId: "claude",
    runtimeEvent: {
      event: {
        type: "textDelta",
        threadId,
        turnExecutionId: EXECUTION_ID,
        delta: threadId,
      },
    },
  };
}

function rejectedOutcome(task: ProviderEventWorkerTask): ProviderEventWorkerOutcome {
  return {
    status: "rejected",
    diagnostic: { reason: "invalid-runtime-event", sourceKind: task.kind },
  };
}

function requiredWorker(workers: readonly FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (!worker) throw new Error(`Expected worker ${index}`);
  return worker;
}

function requiredRequest(worker: FakeWorker, index: number): ProviderEventWorkerRequest {
  const request = worker.requests[index];
  if (!request) throw new Error(`Expected worker request ${index}`);
  return request;
}

describe("ThreadEventWorkerPool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("assigns active threads to vacant fixed slots and serializes every thread", async () => {
    const workers: FakeWorker[] = [];
    const outcomes: string[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 2,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    pool.start();
    const first = runtimeTask("thread-a");
    const second = runtimeTask("thread-a");
    const other = runtimeTask("thread-b");

    pool.submit("thread-a", first, { onOutcome: () => outcomes.push("first") });
    pool.submit("thread-a", second, { onOutcome: () => outcomes.push("second") });
    pool.submit("thread-b", other, { onOutcome: () => outcomes.push("other") });

    expect(workers).toHaveLength(2);
    const firstWorker = requiredWorker(workers, 0);
    const otherWorker = requiredWorker(workers, 1);
    expect(firstWorker.requests).toHaveLength(1);
    expect(otherWorker.requests).toHaveLength(1);
    const firstRequest = requiredRequest(firstWorker, 0);
    const otherRequest = requiredRequest(otherWorker, 0);

    firstWorker.respond(firstRequest, [rejectedOutcome(first)]);
    expect(firstWorker.requests).toHaveLength(2);
    firstWorker.respond(requiredRequest(firstWorker, 1), [rejectedOutcome(second)]);
    otherWorker.respond(otherRequest, [rejectedOutcome(other)]);

    await expect(pool.waitForThread("thread-a")).resolves.toBeUndefined();
    await expect(pool.waitForThread("thread-b")).resolves.toBeUndefined();
    expect(outcomes).toEqual(["first", "second", "other"]);
    pool.shutdown();
  });

  it("replays an in-flight payload before later payloads after a worker crash", () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 1,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = runtimeTask("thread-a");
    const second = runtimeTask("thread-a");

    pool.submit("thread-a", first, { onOutcome: vi.fn() });
    pool.submit("thread-a", second, { onOutcome: vi.fn() });
    const original = workers[0];
    const originalRequest = original?.requests[0];
    if (!original || !originalRequest) throw new Error("Expected the first task to be in flight");

    original.crash();
    expect(original.terminated).toBe(true);
    vi.advanceTimersByTime(50);

    const replacement = workers[1];
    const replayed = replacement?.requests[0];
    if (!replacement || !replayed) throw new Error("Expected the in-flight task to replay after restart");
    expect(replayed.requestIds[0]).toBe(originalRequest.requestIds[0]);
    expect(replayed.requestIds).toHaveLength(2);
    expect(replayed.requestIds[1]).not.toBe(replayed.requestIds[0]);
    replacement.respond(replayed, [rejectedOutcome(first), rejectedOutcome(second)]);
    pool.shutdown();
  });

  it("retains a seven-turn burst within the fixed-pool capacity", () => {
    const workers: FakeWorker[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 2,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    try {
      for (let index = 0; index < 3_458; index += 1) {
        expect(pool.submit(`thread-${index % 7}`, runtimeTask(`thread-${index % 7}`), { onOutcome: vi.fn() })).toBe(true);
      }
      expect(workers).toHaveLength(2);
    } finally {
      pool.shutdown();
    }
  });

  it("gives a quiet collocated thread work in the next worker batch", () => {
    const workers: FakeWorker[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 1,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = runtimeTask("noisy-thread");
    pool.submit("noisy-thread", first, { onOutcome: vi.fn() });
    for (let index = 0; index < 64; index += 1) {
      pool.submit("noisy-thread", runtimeTask("noisy-thread"), { onOutcome: vi.fn() });
    }
    pool.submit("quiet-thread", runtimeTask("quiet-thread"), { onOutcome: vi.fn() });

    const worker = requiredWorker(workers, 0);
    worker.respond(requiredRequest(worker, 0), [rejectedOutcome(first)]);

    expect(requiredRequest(worker, 1).tasks[1]).toEqual(expect.objectContaining({
      runtimeEvent: expect.objectContaining({ event: expect.objectContaining({ threadId: "quiet-thread" }) }),
    }));
    pool.shutdown();
  });

  it("continues dispatching queued work when an outcome callback throws", () => {
    const workers: FakeWorker[] = [];
    const callbackFailure = new Error("consumer failed");
    const pool = new ThreadEventWorkerPool({
      workerCount: 1,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = runtimeTask("thread-a");
    const second = runtimeTask("thread-a");
    pool.submit("thread-a", first, { onOutcome: () => { throw callbackFailure; } });
    pool.submit("thread-a", second, { onOutcome: vi.fn() });

    const worker = requiredWorker(workers, 0);
    expect(() => worker.respond(requiredRequest(worker, 0), [rejectedOutcome(first)])).toThrow(callbackFailure);
    expect(worker.requests).toHaveLength(2);
    pool.shutdown();
  });

  it("rejects retained work after bounded worker restart failures", async () => {
    vi.useFakeTimers();
    const outcomes: ProviderEventWorkerOutcome[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 1,
      createWorker: () => { throw new Error("worker unavailable"); },
    });
    const idle = pool.waitForThread("thread-a");
    pool.submit("thread-a", runtimeTask("thread-a"), { onOutcome: (outcome) => outcomes.push(outcome) });

    vi.runAllTimers();
    await expect(idle).resolves.toBeUndefined();
    expect(outcomes).toEqual([expect.objectContaining({
      status: "rejected",
      diagnostic: expect.objectContaining({ reason: "worker-failure" }),
    })]);
    pool.shutdown();
  });

  it("rejects retained work during shutdown and releases its thread waiters", async () => {
    const workers: FakeWorker[] = [];
    const outcomes: ProviderEventWorkerOutcome[] = [];
    const pool = new ThreadEventWorkerPool({
      workerCount: 1,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });

    pool.submit("thread-a", runtimeTask("thread-a"), { onOutcome: (outcome) => outcomes.push(outcome) });
    const idle = pool.waitForThread("thread-a");
    pool.shutdown();

    await expect(idle).resolves.toBeUndefined();
    expect(workers[0]?.terminated).toBe(true);
    expect(outcomes).toEqual([expect.objectContaining({
      status: "rejected",
      diagnostic: expect.objectContaining({ reason: "worker-shutdown" }),
    })]);
  });

  it("runs validation in a real module worker", async () => {
    const pool = new ThreadEventWorkerPool({ workerCount: 1 });
    try {
      const outcome = await new Promise<ProviderEventWorkerOutcome>((resolve) => {
        pool.submit("thread-a", runtimeTask("thread-a"), { onOutcome: resolve });
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: "accepted",
        event: expect.objectContaining({
          event: expect.objectContaining({ threadId: "thread-a" }),
        }),
      }));
    } finally {
      pool.shutdown();
    }
  });
});
