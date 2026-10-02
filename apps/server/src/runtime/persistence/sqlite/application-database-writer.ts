import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import type { CanonicalWriterRequest, CanonicalWriterResponse } from "../../../features/agents/canonical/canonical-agent-writer-protocol.js";
import { SEMANTIC_PUBLICATION_PAGE_SIZE } from "../../../features/agents/canonical/canonical-agent-writer-protocol.js";
import type { DatabaseWriteOperation } from "./database-write-operation.js";
import type { ApplicationDatabaseWriterRequest, ApplicationDatabaseWriterResponse } from "./application-database-writer-protocol.js";

/** Maximum retained ordinary and canonical command jobs, including reserved control capacity. */
export const DATABASE_WRITER_MAX_PENDING = 256;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const RESERVED_CONTROL = 32;
const RESERVED_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_ATTEMPTS = 3;
const CONTROL_REQUEST_KINDS = new Set<ApplicationDatabaseWriterRequest["kind"]>([
  "close", "ack-operation", "semantic-worker-loss", "query-only-policy",
]);

interface PendingWrite {
  readonly request: ApplicationDatabaseWriterRequest;
  readonly bytes: number;
  readonly resolve: (response: ApplicationDatabaseWriterResponse) => void;
  readonly reject: (error: Error) => void;
  readonly onPublication?: (events: readonly CanonicalAgentEventEnvelope[]) => void;
  attempts: number;
  publishedCount: number;
  attemptPublicationCount: number;
  publicationError?: Error;
}

/** Admission failed before the operation reached SQLite. */
export class DatabaseWriterAdmissionFull extends Error {}

/** The worker disappeared after dispatch; this ordinary mutation must not be blindly retried. */
export class DatabaseWriteOutcomeUnknown extends Error {}

/** Startup initialization belongs to the owner; replacement workers never restore migration backups. */
export interface DatabaseWriterInitialization {
  readonly bootstrap: boolean;
}

/** Owns one bounded FIFO and the application's only writable runtime connection. */
export class ApplicationDatabaseWriter {
  private worker: Worker | undefined;
  private readonly queue: PendingWrite[] = [];
  private retainedBytes = 0;
  private dispatched: PendingWrite | undefined;
  private ready: Promise<void>;
  private initialize: { resolve(): void; reject(error: Error): void } | undefined;
  private generation = 0;
  private recovering: Promise<void> | undefined;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly dbPath: string,
    private readonly createWorker: () => Worker = defaultCreateWorker,
    private readonly initialization: DatabaseWriterInitialization = { bootstrap: false },
  ) {
    if (!NodePath.isAbsolute(dbPath)) throw new Error("Database writer path must be absolute");
    this.ready = this.startWorker();
  }

  /** Wait until the writable connection is ready without blocking the server event loop. */
  whenReady(): Promise<void> { return this.ready; }

  /** Apply the isolated reliability harness fault to the writable owner connection. */
  async setQueryOnlyForReliability(enabled: boolean): Promise<void> {
    const response = await this.admit({ kind: "query-only-policy", requestId: NodeCrypto.randomUUID(),
      name: "database.queryOnly", enabled });
    if (response.kind !== "ordinary-written" || response.name !== "database.queryOnly" || response.result !== undefined) {
      throw new DatabaseWriteOutcomeUnknown("Database policy returned an unexpected committed result");
    }
  }

  /** Resolve only with a validated result from a committed allowlisted operation. */
  async execute<Input, Output>(operation: DatabaseWriteOperation<Input, Output>, input: Input): Promise<Output> {
    const parsed = operation.input.parse(input);
    const response = await this.admit({ kind: "ordinary-write", requestId: NodeCrypto.randomUUID(),
      name: operation.name, input: structuredClone(parsed) });
    if (response.kind !== "ordinary-written" || response.name !== operation.name) {
      throw new DatabaseWriteOutcomeUnknown("Database writer returned an unexpected operation result");
    }
    const output = operation.output.safeParse(response.result);
    if (!output.success) throw new DatabaseWriteOutcomeUnknown(
      `Committed response validation failed for ${operation.name}`, { cause: output.error });
    return output.data;
  }

  /** Receipt-backed canonical commands share admission and preserve their replay/publication identities. */
  async sendCanonical(
    request: CanonicalWriterRequest,
    onPublication?: (events: readonly CanonicalAgentEventEnvelope[]) => void,
  ): Promise<CanonicalWriterResponse> {
    if (request.kind === "open" || request.kind === "close") throw new Error("Database lifecycle belongs to its owner");
    const response = await this.admit(request, onPublication);
    if (response.kind === "ordinary-written" || response.kind === "ordinary-failed") {
      throw new Error("Database writer returned an unexpected canonical result");
    }
    return response;
  }

  /** Wait until all previously admitted work has settled. */
  barrier(): Promise<void> {
    if (this.queue.length === 0 && !this.dispatched) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop admission, drain producers' admitted work, then close and terminate the worker. */
  close(): Promise<void> {
    this.closeTask ??= this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    try {
      await this.barrier();
      await this.ready;
      const response = await this.admit({ kind: "close", requestId: NodeCrypto.randomUUID(),
        operationId: "writer:close", executionId: "writer:init" }, undefined, true);
      if (response.kind !== "closed") throw new Error("Database writer did not close its connection");
    } finally {
      const worker = this.worker;
      this.worker = undefined;
      if (worker) await terminateWorker(worker);
    }
  }

  private admit(
    request: ApplicationDatabaseWriterRequest,
    onPublication?: (events: readonly CanonicalAgentEventEnvelope[]) => void,
    duringClose = false,
  ): Promise<ApplicationDatabaseWriterResponse> {
    if (this.closing && !duringClose) return Promise.reject(new Error("Database writer closed"));
    const immutable = structuredClone(request);
    const bytes = NodeV8.serialize(immutable).byteLength;
    const control = isControlRequest(request);
    if (this.queue.length >= DATABASE_WRITER_MAX_PENDING - (control ? 0 : RESERVED_CONTROL)
      || this.retainedBytes + bytes > MAX_PENDING_BYTES - (control ? 0 : RESERVED_CONTROL_BYTES)) {
      return Promise.reject(new DatabaseWriterAdmissionFull("Database writer admission is full"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request: immutable, bytes, resolve, reject, onPublication,
        attempts: 0, publishedCount: 0, attemptPublicationCount: 0 });
      this.retainedBytes += bytes;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.dispatched || this.recovering) return;
    const pending = this.queue[0];
    if (!pending) { this.releaseIdle(); return; }
    this.dispatched = pending;
    try {
      if (!this.worker) this.ready = this.startWorker();
      await this.ready;
      if (!this.ownsPending(pending)) return;
      const worker = this.worker;
      if (!worker) throw new Error("Database writer is unavailable");
      pending.attempts++;
      pending.attemptPublicationCount = 0;
      worker.postMessage(pending.request);
    } catch (error) {
      if (this.ownsPending(pending)) this.finish(undefined, asError(error));
    }
  }

  private ownsPending(pending: PendingWrite): boolean {
    return this.dispatched === pending && this.recovering === undefined;
  }

  private startWorker(): Promise<void> {
    const generation = ++this.generation;
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<ApplicationDatabaseWriterResponse>) => {
      if (this.generation === generation) this.receive(event.data);
    };
    worker.onerror = () => this.workerLost(worker, generation, false);
    worker.addEventListener("close", () => this.workerLost(worker, generation, true));
    return new Promise((resolve, reject) => {
      this.initialize = { resolve, reject };
      worker.postMessage({ kind: "open", requestId: "writer:open", operationId: "writer:open",
        executionId: "writer:init", dbPath: this.dbPath,
        bootstrap: generation === 1 && this.initialization.bootstrap } satisfies CanonicalWriterRequest);
    });
  }

  private receive(response: ApplicationDatabaseWriterResponse): void {
    if (response.requestId === "writer:open") {
      this.receiveOpen(response);
      return;
    }
    const pending = this.dispatched;
    if (!pending || response.requestId !== pending.request.requestId) return;
    if (!matchesResponse(pending.request, response)) {
      const worker = this.worker;
      if (worker) this.workerLost(worker, this.generation, false);
      return;
    }
    if (response.kind === "semantic-publication") {
      this.receivePublication(pending, response.events);
      return;
    }
    if (response.kind === "failed" || response.kind === "ordinary-failed") {
      this.finish(undefined, responseError(response));
    } else this.finish(response, pending.publicationError);
  }

  private receiveOpen(response: ApplicationDatabaseWriterResponse): void {
    if (response.kind === "opened") this.initialize?.resolve();
    else this.initialize?.reject(responseError(response));
    this.initialize = undefined;
  }

  private receivePublication(pending: PendingWrite, events: readonly CanonicalAgentEventEnvelope[]): void {
    if (pending.publicationError) return;
    try { this.deliverPublication(pending, events); }
    catch (error) { pending.publicationError = asError(error); }
  }

  private deliverPublication(pending: PendingWrite, events: readonly CanonicalAgentEventEnvelope[]): void {
    if (!pending.onPublication || events.length === 0 || events.length > SEMANTIC_PUBLICATION_PAGE_SIZE) {
      throw new Error("Database writer publication page is invalid");
    }
    const skipped = Math.min(events.length, Math.max(0, pending.publishedCount - pending.attemptPublicationCount));
    if (skipped < events.length) pending.onPublication(events.slice(skipped));
    pending.attemptPublicationCount += events.length;
    pending.publishedCount = Math.max(pending.publishedCount, pending.attemptPublicationCount);
  }

  private workerLost(worker: Worker, generation: number, terminated: boolean): void {
    if (this.generation !== generation || this.worker !== worker) return;
    this.worker = undefined;
    const failure = new Error("Canonical writer worker closed");
    this.initialize?.reject(failure);
    this.initialize = undefined;
    const pending = this.dispatched;
    this.recovering = (async () => {
      // Install the recovery fence before settling the head can release unsent jobs.
      await Promise.resolve();
      if (!terminated) await terminateWorker(worker);
      if (pending && (pending.request.kind === "ordinary-write" || pending.request.kind === "query-only-policy") && pending.attempts > 0) {
        this.finish(undefined, new DatabaseWriteOutcomeUnknown(
          `Outcome unknown for ${pending.request.name}; the dispatched write was not replayed`, { cause: failure }));
      } else if (pending && pending.attempts >= MAX_RECEIPT_ATTEMPTS) {
        this.finish(undefined, failure);
      } else this.dispatched = undefined;
      if (this.queue.length) {
        this.ready = this.startWorker();
        await this.ready;
      }
    })().catch((error: unknown) => {
      while (this.queue.length) this.finish(undefined, asError(error));
    }).finally(() => {
      this.recovering = undefined;
      void this.pump();
    });
  }

  private finish(response?: ApplicationDatabaseWriterResponse, error?: Error): void {
    const pending = this.queue.shift();
    this.dispatched = undefined;
    if (!pending) return;
    this.retainedBytes -= pending.bytes;
    if (error) pending.reject(error);
    else if (response) pending.resolve(response);
    else pending.reject(new Error("Database writer operation has no result"));
    if (!this.recovering) void this.pump();
  }

  private releaseIdle(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

function matchesResponse(request: ApplicationDatabaseWriterRequest, response: ApplicationDatabaseWriterResponse): boolean {
  if (request.kind === "ordinary-write" || request.kind === "query-only-policy") {
    return (response.kind === "ordinary-written" || response.kind === "ordinary-failed") && response.name === request.name;
  }
  return response.kind !== "ordinary-written" && response.kind !== "ordinary-failed"
    && request.operationId === response.operationId && request.executionId === response.executionId;
}

function responseError(response: ApplicationDatabaseWriterResponse): Error {
  if (response.kind !== "failed" && response.kind !== "ordinary-failed") return new Error("Unexpected database writer response");
  const failure = response.failure;
  const error = new Error(failureMessage(response));
  if (!failure) return error;
  error.name = failure.name;
  if (failure.code) Object.assign(error, { code: failure.code });
  if ("retryAfterSeconds" in failure && typeof failure.retryAfterSeconds === "number") {
    Object.assign(error, { retryAfterSeconds: failure.retryAfterSeconds });
  }
  return error;
}

function failureMessage(response: Extract<ApplicationDatabaseWriterResponse, { kind: "failed" | "ordinary-failed" }>): string {
  if (response.kind === "ordinary-failed") return response.failure.message;
  const suffix = response.failure ? ": " + response.failure.message : "";
  return "Canonical writer " + response.reason + suffix;
}

function isControlRequest(request: ApplicationDatabaseWriterRequest): boolean {
  return CONTROL_REQUEST_KINDS.has(request.kind)
    || request.kind === "ordinary-write" && request.name === "database.optimize";
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function terminateWorker(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    worker.addEventListener("close", () => resolve(), { once: true });
    worker.terminate();
  });
}

function defaultCreateWorker(): Worker {
  const filename = import.meta.url.endsWith(".cjs")
    ? "./canonical-agent-writer.worker.cjs"
    : "../../../features/agents/canonical/canonical-agent-writer.worker.ts";
  const url = new URL(filename, import.meta.url);
  const options = { type: "module", smol: true } satisfies WorkerOptions & { smol: boolean };
  return new Worker(url, options);
}
