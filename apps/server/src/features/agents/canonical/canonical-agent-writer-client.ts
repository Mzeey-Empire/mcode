import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type {
  CanonicalProviderWriteInput,
  CanonicalProviderWriteReceipt,
  CanonicalWriterRequest,
  CanonicalWriterResponse,
} from "./canonical-agent-writer-protocol.js";

const MAX_PENDING_WRITES = 64;
const WRITER_EXECUTION_ID = "writer:init";

interface PendingRequest {
  request: CanonicalWriterRequest;
  resolve(response: CanonicalWriterResponse): void;
  reject(error: Error): void;
}

/** Sends cloneable canonical batches to one dedicated SQLite worker with bounded admission. */
export class CanonicalAgentWriterClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private readonly closed: Promise<void>;
  private markClosed: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(dbPath: string, createWorker: () => Worker = defaultCreateWorker) {
    if (!NodePath.isAbsolute(dbPath)) throw new Error("Canonical writer database path must be absolute");
    this.worker = createWorker();
    this.closed = new Promise((resolve) => { this.markClosed = resolve; });
    this.worker.onmessage = (message: MessageEvent<CanonicalWriterResponse>) => this.receive(message.data);
    this.worker.onerror = () => this.fail(new Error("Canonical writer worker failed"));
    this.worker.addEventListener("close", () => {
      this.markClosed?.();
      this.fail(new Error("Canonical writer worker closed"));
    });
    this.ready = this.send({
      kind: "open",
      requestId: NodeCrypto.randomUUID(),
      operationId: "writer:open",
      executionId: WRITER_EXECUTION_ID,
      dbPath,
    }).then((response) => {
      if (response.kind !== "opened") throw new Error("Canonical writer did not open its database");
    }).catch((error: Error) => {
      this.fail(error);
      throw error;
    });
  }

  /** Waits until the worker has opened the already-migrated database. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Resolves with committed envelopes for main-loop publication; it never publishes them itself. */
  async commit(operationId: string, input: CanonicalProviderWriteInput): Promise<CanonicalProviderWriteReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    await this.ready;
    const response = await this.send({
      kind: "commit",
      requestId: NodeCrypto.randomUUID(),
      operationId,
      executionId: input.executionId,
      input,
    });
    if (response.kind !== "committed") throw new Error("Canonical writer returned an unexpected response");
    return response.receipt;
  }

  /** Closes the database after accepted writes settle, then releases the worker. */
  async close(): Promise<void> {
    try {
      await this.ready;
      if (!this.failure) {
        await this.send({
          kind: "close",
          requestId: NodeCrypto.randomUUID(),
          operationId: "writer:close",
          executionId: WRITER_EXECUTION_ID,
        });
      }
    } catch (error) {
      if (!this.failure) throw error;
    } finally {
      this.fail(new Error("Canonical writer closed"));
      await this.closed;
    }
  }

  private send(request: CanonicalWriterRequest): Promise<CanonicalWriterResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (request.kind === "commit" && this.pending.size >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error("Canonical writer admission is full"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { request, resolve, reject });
      try {
        this.worker.postMessage(request);
      } catch {
        this.pending.delete(request.requestId);
        reject(new Error("Canonical writer request could not be sent"));
      }
    });
  }

  private receive(response: CanonicalWriterResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (pending.request.operationId !== response.operationId
      || pending.request.executionId !== response.executionId) {
      this.fail(new Error("Canonical writer response identity mismatch"));
      return;
    }
    this.pending.delete(response.requestId);
    if (response.kind === "failed") {
      pending.reject(new Error(`Canonical writer ${response.reason}`));
      return;
    }
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
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
