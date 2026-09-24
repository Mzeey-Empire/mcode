import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type {
  CanonicalParentNarrativeClassificationReceipt,
  CanonicalParentNarrativeRecoveryReceipt,
  CanonicalProviderWriteInput,
  CanonicalProviderWriteReceipt,
  CanonicalWriterRequest,
  CanonicalWriterResponse,
} from "./canonical-agent-writer-protocol.js";
import type { ParentNarrativeRecoveryCommitInput } from "./canonical-agent-boundary.js";

const MAX_PENDING_WRITES = 64;
const MAX_WORKER_ATTEMPTS = 3;
const WRITER_EXECUTION_ID = "writer:init";

interface PendingRequest {
  request: CanonicalWriterRequest;
  resolve(response: CanonicalWriterResponse): void;
  reject(error: Error): void;
}

class CanonicalWriterWorkerLost extends Error {}

/** Sends cloneable canonical commands to a dedicated SQLite worker with bounded admission and crash retries. */
export class CanonicalAgentWriterClient {
  private worker: Worker | undefined;
  private workerReady: Promise<void>;
  private restart: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private generation = 0;
  private stopping = false;

  constructor(
    private readonly dbPath: string,
    private readonly createWorker: () => Worker = defaultCreateWorker,
  ) {
    if (!NodePath.isAbsolute(dbPath)) throw new Error("Canonical writer database path must be absolute");
    this.workerReady = this.startWorker();
  }

  /** Waits until the worker has opened the already-migrated database. */
  whenReady(): Promise<void> {
    return this.workerReady;
  }

  /** Resolves with committed envelopes for main-loop publication; it never publishes them itself. */
  async commit(operationId: string, input: CanonicalProviderWriteInput): Promise<CanonicalProviderWriteReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    const response = await this.sendWithRetry({
      kind: "commit", requestId: NodeCrypto.randomUUID(), operationId, executionId: input.executionId, input,
    });
    if (response.kind !== "committed") throw new Error("Canonical writer returned an unexpected response");
    return response.receipt;
  }

  /** Resolves after recovery writes finish; a lost reply replays the durable receipt. */
  async recordParentNarrativeRecovery(
    operationId: string,
    input: ParentNarrativeRecoveryCommitInput,
  ): Promise<CanonicalParentNarrativeRecoveryReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    const response = await this.sendWithRetry({
      kind: "record-parent-narrative-recovery", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.executionId, input,
    });
    if (response.kind !== "parent-narrative-recovery-recorded") {
      throw new Error("Canonical writer returned an unexpected response");
    }
    return response.receipt;
  }

  /** Atomically persists recovery and resets provisional assistant text; the caller retires its journal after receipt. */
  async classifyParentNarrativeRecovery(
    operationId: string,
    input: ParentNarrativeRecoveryCommitInput,
  ): Promise<CanonicalParentNarrativeClassificationReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    const response = await this.sendWithRetry({
      kind: "classify-parent-narrative-recovery", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.executionId, input,
    });
    if (response.kind !== "parent-narrative-recovery-classified") {
      throw new Error("Canonical writer returned an unexpected response");
    }
    return response.receipt;
  }

  /** Releases a receipt after its caller has finished publication or journal discard. Never acknowledge before that work. */
  async acknowledgeOperation(executionId: string, operationId: string): Promise<void> {
    if (!executionId || !operationId) throw new Error("Canonical writer operation and execution IDs are required");
    const response = await this.sendWithRetry({
      kind: "ack-operation", requestId: NodeCrypto.randomUUID(), operationId, executionId,
    });
    if (response.kind !== "operation-acknowledged") {
      throw new Error("Canonical writer returned an unexpected response");
    }
  }

  /** Closes the database after accepted writes settle, then releases the worker. */
  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.workerReady;
      if (this.worker) {
        await this.sendRaw({
          kind: "close", requestId: NodeCrypto.randomUUID(), operationId: "writer:close",
          executionId: WRITER_EXECUTION_ID,
        });
      }
    } catch {
      // A failed worker is already closed; caller writes have their own visible failures.
    } finally {
      this.loseWorker(new Error("Canonical writer closed"));
    }
  }

  private async sendWithRetry(request: CanonicalWriterRequest): Promise<CanonicalWriterResponse> {
    for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS; attempt++) {
      if (this.stopping) throw new Error("Canonical writer closed");
      try {
        await this.workerReady;
        return await this.sendRaw(request);
      } catch (error) {
        if (!(error instanceof CanonicalWriterWorkerLost) || attempt === MAX_WORKER_ATTEMPTS) throw error;
        try {
          await this.restartWorker();
        } catch (restartError) {
          if (!(restartError instanceof CanonicalWriterWorkerLost)) throw restartError;
        }
      }
    }
    throw new Error("Canonical writer retry limit reached");
  }

  private async restartWorker(): Promise<void> {
    if (this.stopping) throw new Error("Canonical writer closed");
    if (!this.restart) {
      this.restart = (async () => {
        if (!this.worker) this.workerReady = this.startWorker();
        await this.workerReady;
      })().finally(() => { this.restart = undefined; });
    }
    await this.restart;
  }

  private async startWorker(): Promise<void> {
    const generation = ++this.generation;
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (message: MessageEvent<CanonicalWriterResponse>) => {
      if (this.generation === generation) this.receive(message.data);
    };
    worker.onerror = () => this.loseWorker(new CanonicalWriterWorkerLost("Canonical writer worker failed"), generation);
    worker.addEventListener("close", () => {
      this.loseWorker(new CanonicalWriterWorkerLost("Canonical writer worker closed"), generation);
    });
    const response = await this.sendRaw({
      kind: "open", requestId: NodeCrypto.randomUUID(), operationId: "writer:open",
      executionId: WRITER_EXECUTION_ID, dbPath: this.dbPath,
    });
    if (response.kind !== "opened") throw new Error("Canonical writer did not open its database");
  }

  private sendRaw(request: CanonicalWriterRequest): Promise<CanonicalWriterResponse> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new CanonicalWriterWorkerLost("Canonical writer worker closed"));
    if (request.kind !== "open" && request.kind !== "close" && this.pending.size >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error("Canonical writer admission is full"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { request, resolve, reject });
      try {
        worker.postMessage(request);
      } catch {
        this.loseWorker(new CanonicalWriterWorkerLost("Canonical writer request could not be sent"));
      }
    });
  }

  private receive(response: CanonicalWriterResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (pending.request.operationId !== response.operationId
      || pending.request.executionId !== response.executionId) {
      this.loseWorker(new Error("Canonical writer response identity mismatch"));
      return;
    }
    this.pending.delete(response.requestId);
    if (response.kind === "failed") {
      pending.reject(new Error(`Canonical writer ${response.reason}`));
      return;
    }
    pending.resolve(response);
  }

  private loseWorker(error: Error, generation = this.generation): void {
    if (generation !== this.generation) return;
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function defaultCreateWorker(): Worker {
  const workerFile = import.meta.url.endsWith(".cjs")
    ? "./canonical-agent-writer.worker.cjs"
    : "./canonical-agent-writer.worker.ts";
  return new Worker(new URL(workerFile, import.meta.url), { type: "module" });
}
