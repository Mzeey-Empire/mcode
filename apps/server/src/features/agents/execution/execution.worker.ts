import {
  ExecutionWorkerHandler,
  type ExecutionSemanticOperation,
  type ExecutionSemanticWriter,
  type ExecutionWriteReceipt,
} from "./execution-worker-handler.js";
import type { ExecutionWorkerInbound, ExecutionWorkerOutbound } from "./execution-worker-port.js";

interface PendingWrite {
  readonly rpcId: number;
  readonly operationId: string;
  readonly resolve: (receipt: ExecutionWriteReceipt) => void;
  readonly reject: () => void;
}

class ExecutionWriterRpcFailure extends Error {}

let nextRpcId = 1;
let pendingWrite: PendingWrite | undefined;
let commandActive = false;
let closed = false;

const writer: ExecutionSemanticWriter = {
  transact: (operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> => {
    if (closed || pendingWrite) return Promise.reject(new Error("Execution writer RPC unavailable"));
    const rpcId = nextRpcId++;
    return new Promise((resolve, reject) => {
      pendingWrite = {
        rpcId,
        operationId: operation.operationId,
        resolve,
        reject: () => reject(new ExecutionWriterRpcFailure("Execution writer RPC failed")),
      };
      post({ kind: "writer-request", rpcId, operation });
    });
  },
};

const handler = new ExecutionWorkerHandler(writer);

globalThis.onmessage = (event: MessageEvent<ExecutionWorkerInbound>): void => {
  const message = event.data;
  switch (message.kind) {
    case "command":
      handleCommand(message.request);
      break;
    case "writer-receipt":
      finishWrite(message.rpcId, message.receipt);
      break;
    case "writer-failure":
      failWrite(message.rpcId);
      break;
    case "close":
      closeWorker();
      break;
    default: {
      const exhaustive: never = message;
      throw new Error(`Unknown execution worker input: ${String(exhaustive)}`);
    }
  }
};

post({ kind: "ready" });

function handleCommand(request: Extract<ExecutionWorkerInbound, { kind: "command" }>["request"]): void {
  if (closed || commandActive) {
    failWorker();
    return;
  }
  commandActive = true;
  void handler.handle(request)
    .then((reply) => {
      if (!closed) post({ kind: "command-reply", reply });
    })
    .catch((error: unknown) => {
      if (error instanceof ExecutionWriterRpcFailure) {
        post({ kind: "command-reply", reply: { requestId: request.requestId,
          execution: request.execution, lease: request.lease, ordinal: request.ordinal,
          result: { kind: "rejected", reason: "writer-failure" } } });
      } else {
        failWorker();
      }
    })
    .finally(() => { commandActive = false; });
}

function finishWrite(rpcId: number, receipt: ExecutionWriteReceipt): void {
  const pending = pendingWrite;
  if (!pending || pending.rpcId !== rpcId || pending.operationId !== receipt.operationId) {
    failWorker();
    return;
  }
  pendingWrite = undefined;
  pending.resolve(receipt);
}

function failWrite(rpcId: number): void {
  const pending = pendingWrite;
  if (!pending || pending.rpcId !== rpcId) {
    failWorker();
    return;
  }
  pendingWrite = undefined;
  pending.reject();
}

function failWorker(): void {
  if (closed) return;
  post({ kind: "fatal" });
  closeWorker();
}

function closeWorker(): void {
  if (closed) return;
  closed = true;
  pendingWrite?.reject();
  pendingWrite = undefined;
  post({ kind: "closed" });
  globalThis.close();
}

function post(message: ExecutionWorkerOutbound): void {
  globalThis.postMessage(message);
}
