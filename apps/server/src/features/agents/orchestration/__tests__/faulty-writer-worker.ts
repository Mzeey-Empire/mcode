import type { ApplicationDatabaseWriterRequest, ApplicationDatabaseWriterResponse } from "../../../../runtime/persistence/sqlite/application-database-writer-protocol.js";
import { createDatabaseWriterWorker, type DatabaseWriterWorker } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import type { WriterFailure } from "../../canonical/canonical-agent-writer-protocol.js";
import { AcceptedContentRejected } from "../../canonical/accepted-save-failure.js";

type Match = (request: ApplicationDatabaseWriterRequest) => boolean;
const rejection = new AcceptedContentRejected("Injected invalid content");

/** Worker failure envelopes matching the production writer's thrown errors. */
export const writerFailures = {
  identity: { name: "Error", message: "Invalid accepted semantic operation" },
  content: { name: rejection.name, message: rejection.message, code: rejection.code, contentRejection: rejection.reason },
  busy: { name: "Error", message: "database is locked", code: "SQLITE_BUSY" },
} satisfies Record<string, WriterFailure>;

/** Match accepted canonical storage for one conversation. */
export function threadWrite(threadId: string): Match {
  return (request) => request.kind === "append-accepted" && request.input.execution.threadId === threadId;
}

/** Match the accepted compatibility operation carrying a turn's finish. */
export function terminalWrite(threadId: string, turnId: string): Match {
  return (request) => threadWrite(threadId)(request) && request.kind === "append-accepted"
    && request.input.execution.turnId === turnId
    && request.input.compatibility?.mutation.kind === "finish-live-event";
}

/** Narrow a match to the original write of a batch, leaving its replacement for rejected content unmatched. */
export function originalWrite(match: Match): Match {
  return (request) => match(request) && request.kind === "append-accepted" && request.input.replaced === undefined;
}

interface Rule {
  match: Match;
  remaining: number | "always";
  failure: WriterFailure;
  /** When set, the rule refuses only the operation of the first request it matched. */
  pinOperation: boolean;
  pinnedOperationId?: string;
  hits: number;
  active: boolean;
  reached: Promise<void>;
  markReached: () => void;
}

interface RefuseOptions {
  times: number | "always";
  /**
   * Refuse only the first matched operation from then on. A real refusal is deterministic for one operation, so a
   * product fix that writes a fresh operation instead of resending the stuck one must not be refused as well.
   */
  pinOperation?: boolean;
}

/** A fault plan survives worker replacement while each factory call creates a fresh wrapper. */
export class WriterFaultPlan {
  private readonly rules: Rule[] = [];

  /** Refuse matching requests before they reach SQLite. */
  refuse(match: Match, failure: WriterFailure, options: RefuseOptions) {
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const rule: Rule = { match, remaining: options.times, failure, pinOperation: options.pinOperation ?? false, hits: 0,
      active: true, reached, markReached };
    this.rules.push(rule);
    return { reached, clear: () => { rule.active = false; }, get hits() { return rule.hits; } };
  }

  /** Create an independently owned real worker attached to this plan. */
  readonly createWorker = (): DatabaseWriterWorker => new FaultyWriterWorker(createDatabaseWriterWorker(), this.rules);
}

class FaultyWriterWorker extends EventTarget implements DatabaseWriterWorker {
  onmessage: DatabaseWriterWorker["onmessage"] = null;
  onerror: DatabaseWriterWorker["onerror"] = null;

  constructor(private readonly worker: Worker, private readonly rules: Rule[]) {
    super();
    worker.onmessage = (event: MessageEvent<ApplicationDatabaseWriterResponse>) => {
      this.onmessage?.(event);
    };
    worker.onerror = (event) => this.onerror?.(event);
    worker.addEventListener("close", () => this.dispatchEvent(new Event("close")));
  }

  postMessage(request: ApplicationDatabaseWriterRequest): void {
    const rule = this.rules.find((candidate) => candidate.active && candidate.remaining !== 0 && candidate.match(request)
      && (!candidate.pinOperation || candidate.pinnedOperationId === undefined || candidate.pinnedOperationId === operationIdOf(request)));
    if (!rule) { this.worker.postMessage(request); return; }
    if (rule.pinOperation) rule.pinnedOperationId ??= operationIdOf(request);
    rule.hits += 1;
    rule.markReached();
    if (rule.remaining !== "always") rule.remaining -= 1;
    const failure = rule.failure;
    const response: ApplicationDatabaseWriterResponse = request.kind === "ordinary-write" || request.kind === "query-only-policy"
      ? { kind: "ordinary-failed", requestId: request.requestId, name: request.name, failure }
      : { kind: "failed", requestId: request.requestId, operationId: request.operationId,
        executionId: request.executionId, reason: "write-failed", failure };
    // A real worker's reply arrives as a message event on a later macrotask, never within the posting call's microtasks.
    setImmediate(() => this.onmessage?.(new MessageEvent("message", { data: response })));
  }

  terminate(): void { this.worker.terminate(); }
}

function operationIdOf(request: ApplicationDatabaseWriterRequest): string | undefined {
  return "operationId" in request ? request.operationId : undefined;
}
