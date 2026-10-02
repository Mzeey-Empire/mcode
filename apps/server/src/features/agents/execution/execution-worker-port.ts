import { sameExecution, sameLease } from "./execution-mailbox-protocol.js";
import type {
  ExecutionWorkerPort,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxCommand } from "./execution-mailbox-scheduler.js";
import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWorkCommand,
  ExecutionWorkerResult,
  ExecutionWriteReceipt,
} from "./execution-worker-handler.js";
import { executionWriterFailure, type ExecutionWriterFailure } from "./execution-writer-failure.js";

type Command = ExecutionMailboxCommand<ExecutionWorkCommand>;
type Request = ExecutionWorkerRequest<Command>;
type Reply = ExecutionWorkerReply<ExecutionWorkerResult>;

/** Only data crosses the Worker boundary; the single writer remains on the host. */
export type ExecutionWorkerInbound =
  | { readonly kind: "command"; readonly request: Request }
  | { readonly kind: "writer-receipt"; readonly rpcId: number; readonly receipt: ExecutionWriteReceipt }
  | { readonly kind: "writer-failure"; readonly rpcId: number; readonly failure: ExecutionWriterFailure }
  | { readonly kind: "close" };

/** The Worker requests one durable transaction and returns its acknowledged result. */
export type ExecutionWorkerOutbound =
  | { readonly kind: "ready" }
  | { readonly kind: "writer-request"; readonly rpcId: number; readonly operation: ExecutionSemanticOperation }
  | { readonly kind: "command-reply"; readonly reply: Reply }
  | { readonly kind: "fatal" }
  | { readonly kind: "closed" };

/** A real Bun Worker port for one fixed scheduler slot. */
export class ExecutionThreadWorkerPort implements ExecutionWorkerPort<Command, ExecutionWorkerResult> {
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  private readonly worker: Worker;
  private readonly readyPromise: Promise<boolean>;
  private resolveReady: (ready: boolean) => void = () => {};
  private closePromise: Promise<boolean> | undefined;
  private resolveClose: ((graceful: boolean) => void) | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private state: "starting" | "ready" | "closing" | "closed" = "starting";
  private queuedBeforeReady: Request | undefined;
  private inFlight: Request | undefined;
  private writerRpcPending = false;
  private writerCalled = false;
  private rejectedObservationCheckpointAllowed = false;

  constructor(
    private readonly writer: ExecutionSemanticWriter,
    workerUrl: URL = defaultWorkerUrl(),
  ) {
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    const workerOptions = { type: "module", smol: true } satisfies WorkerOptions & { smol: boolean };
    this.worker = new Worker(workerUrl, workerOptions);
    this.worker.onmessage = (event: MessageEvent<ExecutionWorkerOutbound>) => this.receive(event.data);
    this.worker.onerror = (event) => this.fail(event);
    this.worker.onmessageerror = () => this.fail(new ErrorEvent("error"));
    this.worker.addEventListener("close", () => this.closed());
  }

  /** Startup resolves false if the Worker exits before it can accept commands. */
  whenReady(): Promise<boolean> {
    return this.readyPromise;
  }

  postMessage(request: Request): void {
    if (this.state === "closed" || this.state === "closing") throw new Error("Execution worker is closed");
    if (this.inFlight) throw new Error("Execution worker already has an in-flight command");
    this.inFlight = request;
    this.writerCalled = false;
    this.rejectedObservationCheckpointAllowed = false;
    if (this.state === "starting") this.queuedBeforeReady = request;
    else this.send({ kind: "command", request });
  }

  /** Ask the Worker to close, then force termination if it does not respond. */
  close(): Promise<boolean> {
    if (this.state === "closed") return Promise.resolve(true);
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    this.closeTimer = setTimeout(() => this.terminate(), 2_000);
    this.send({ kind: "close" });
    return this.closePromise;
  }

  terminate(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.worker.terminate();
    this.finishClose(false);
  }

  private receive(message: ExecutionWorkerOutbound): void {
    if (this.state === "closed") return;
    switch (message.kind) {
      case "ready":
        this.ready();
        break;
      case "writer-request":
        void this.write(message.rpcId, message.operation);
        break;
      case "command-reply":
        this.reply(message.reply);
        break;
      case "fatal":
        this.fail(new ErrorEvent("error"));
        break;
      case "closed":
        this.closed();
        break;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unknown execution worker message: ${String(exhaustive)}`);
      }
    }
  }

  private ready(): void {
    if (this.state !== "starting") return;
    this.state = "ready";
    this.resolveReady(true);
    const request = this.queuedBeforeReady;
    this.queuedBeforeReady = undefined;
    if (request) this.send({ kind: "command", request });
  }

  private async write(rpcId: number, operation: ExecutionSemanticOperation): Promise<void> {
    if (!this.canWrite(operation)) {
      this.fail(new ErrorEvent("error"));
      return;
    }
    this.writerRpcPending = true;
    this.writerCalled = true;
    this.rejectedObservationCheckpointAllowed = false;
    try {
      const receipt = await this.writer.transact(operation);
      if (this.state === "ready") this.send({ kind: "writer-receipt", rpcId, receipt });
    } catch (error) {
      const failure = executionWriterFailure(error);
      // Only a proven pre-acceptance rejection may consume this same ordinal with an empty checkpoint.
      this.rejectedObservationCheckpointAllowed = operation.mutation.kind === "append-events" && failure.observationRejected === true;
      if (this.state === "ready") this.send({ kind: "writer-failure", rpcId, failure });
    } finally {
      this.writerRpcPending = false;
    }
  }

  private canWrite(operation: ExecutionSemanticOperation): boolean {
    return this.state === "ready" && !this.writerRpcPending && matchesOperation(this.inFlight, operation)
      && (!this.writerCalled || this.rejectedObservationCheckpointAllowed && operation.mutation.kind === "checkpoint");
  }

  private reply(reply: Reply): void {
    if (this.state !== "ready" || !matchesReply(this.inFlight, reply)) {
      this.fail(new ErrorEvent("error"));
      return;
    }
    this.inFlight = undefined;
    this.onmessage?.(new MessageEvent("message", { data: reply }));
  }

  private send(message: ExecutionWorkerInbound): void {
    try {
      this.worker.postMessage(message);
    } catch {
      this.fail(new ErrorEvent("error"));
    }
  }

  private fail(event: ErrorEvent): void {
    if (this.state === "closed") return;
    try {
      this.onerror?.(event);
    } finally {
      this.terminate();
    }
  }

  private closed(): void {
    if (this.state === "closed") return;
    const graceful = this.state === "closing";
    this.state = "closed";
    this.worker.terminate();
    this.finishClose(graceful);
    this.onclose?.();
  }

  private finishClose(graceful: boolean): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.resolveReady(false);
    this.resolveClose?.(graceful);
    this.resolveClose = undefined;
  }
}

function defaultWorkerUrl(): URL {
  const workerFile = import.meta.url.endsWith(".cjs") ? "./execution.worker.cjs" : "./execution.worker.ts";
  return new URL(workerFile, import.meta.url);
}

function matchesOperation(request: Request | undefined, operation: ExecutionSemanticOperation): boolean {
  return request !== undefined && request.ordinal === operation.ordinal
    && sameExecution(request.execution, operation.execution)
    && sameLease(request.lease, operation.lease)
    && operation.operationId === `${request.lease.leaseId}:${request.ordinal}`;
}

function matchesReply(request: Request | undefined, reply: Reply): boolean {
  return request !== undefined && request.requestId === reply.requestId
    && request.ordinal === reply.ordinal
    && sameExecution(request.execution, reply.execution)
    && sameLease(request.lease, reply.lease);
}
