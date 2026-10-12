import type { ApplicationDatabaseWriterRequest, ApplicationDatabaseWriterResponse } from "../application-database-writer-protocol.js";
import { createDatabaseWriterWorker, type DatabaseWriterWorker } from "../application-database-writer.js";

// Vitest runs each test file in its own process, so idle workers never cross files.
const idleWorkers: Worker[] = [];

/**
 * Lease a writer worker that can serve the next test's writer after this one closes.
 * A new worker spends about 250 ms evaluating the writer's module graph, which dominated
 * tests that open a database per test. Only a worker whose last reply was a clean `closed`
 * returns to the pool: the worker's close handler resets everything open sets, so the next
 * lease starts from the state a fresh worker would. Any other termination is real.
 */
export function leaseWriterWorker(): DatabaseWriterWorker {
  return new WriterWorkerLease(idleWorkers.pop() ?? createDatabaseWriterWorker());
}

class WriterWorkerLease extends EventTarget implements DatabaseWriterWorker {
  onmessage: DatabaseWriterWorker["onmessage"] = null;
  onerror: DatabaseWriterWorker["onerror"] = null;
  private closedCleanly = false;
  private ended = false;

  constructor(private readonly worker: Worker) {
    super();
    worker.onmessage = (event: MessageEvent<ApplicationDatabaseWriterResponse>) => {
      this.closedCleanly = event.data.kind === "closed";
      this.onmessage?.(event);
    };
    worker.onerror = (event) => {
      this.closedCleanly = false;
      this.onerror?.(event);
    };
    worker.addEventListener("close", this.forwardClose);
  }

  postMessage(message: ApplicationDatabaseWriterRequest): void {
    this.closedCleanly = false;
    this.worker.postMessage(message);
  }

  terminate(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.closedCleanly) {
      this.worker.terminate();
      return;
    }
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.removeEventListener("close", this.forwardClose);
    idleWorkers.push(this.worker);
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  private readonly forwardClose = (): void => {
    this.ended = true;
    this.dispatchEvent(new Event("close"));
  };
}
