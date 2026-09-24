import { AgentEventSchema, type AgentEvent } from "@mcode/contracts";
import * as NodeUtil from "node:util";

import type {
  ExecutionLivePublicationReceipt, ExecutionSemanticOperation, ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";

const MAX_TRACKED_PUBLICATIONS = 8_192;
const MAX_RECEIPT_EVENTS = 64;
const MAX_RECEIPT_BYTES = 512 * 1024;

/** The bound public AgentEvent bridge, normally AgentEventPublicationRegistry. */
export interface LiveAgentEventPublisher {
  isBound(): boolean;
  publish(event: AgentEvent): void;
}

/** Releases committed live events once per host lifetime, even when a writer reply is replayed. */
export class ExecutionLivePublicationRelease {
  private readonly published = new Set<string>();

  constructor(private readonly publisher: LiveAgentEventPublisher) {}

  /** Validate the entire receipt before exposing any event in its original order. */
  release(operation: ExecutionSemanticOperation, receipt: ExecutionWriteReceipt): void {
    if (receipt.kind !== "committed" || !receipt.livePublication) return;
    const events = this.validate(operation, receipt);
    if (!this.publisher.isBound()) throw new Error("Live AgentEvent publisher is not bound");
    const newCount = events.filter((entry) => !this.published.has(entry.key)).length;
    if (this.published.size + newCount > MAX_TRACKED_PUBLICATIONS) {
      throw new Error("Live AgentEvent publication tracking is full");
    }
    for (const entry of events) {
      if (this.published.has(entry.key)) continue;
      this.publisher.publish(entry.event);
      this.published.add(entry.key);
    }
  }

  private validate(
    operation: ExecutionSemanticOperation,
    receipt: Extract<ExecutionWriteReceipt, { kind: "committed" }>,
  ) {
    const entries = receipt.livePublication ?? [];
    if (receipt.operationId !== operation.operationId || !operation.livePublication
      || entries.length !== operation.livePublication.length || entries.length > MAX_RECEIPT_EVENTS
      || Buffer.byteLength(JSON.stringify(entries), "utf8") > MAX_RECEIPT_BYTES) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    return entries.map((entry, index) => this.validateEntry(operation, entry, index));
  }

  private validateEntry(operation: ExecutionSemanticOperation, entry: ExecutionLivePublicationReceipt, index: number) {
    const expected = operation.livePublication?.[index];
    if (!expected || !samePublicationHeader(operation, entry, expected.after, index)) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    const parsed = AgentEventSchema().safeParse(entry.event);
    const original = AgentEventSchema().safeParse(expected.event);
    if (!parsed.success || !original.success) throw new Error("Live AgentEvent publication receipt is invalid");
    if (parsed.data.threadId !== operation.execution.threadId
      || parsed.data.turnExecutionId !== operation.execution.executionId
      || !NodeUtil.isDeepStrictEqual(parsed.data, original.data)) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    return { key: JSON.stringify([operation.execution.executionId, entry.publicationId]), event: parsed.data };
  }
}

function samePublicationHeader(
  operation: ExecutionSemanticOperation,
  entry: ExecutionLivePublicationReceipt,
  expectedBarrier: "writer" | "terminal",
  index: number,
): boolean {
  return entry.publicationId === `${operation.operationId}:${index}`
    && entry.after === expectedBarrier && entry.after === barrierFor(operation.mutation.kind);
}

function barrierFor(kind: ExecutionSemanticOperation["mutation"]["kind"]): "writer" | "terminal" | null {
  if (kind === "begin" || kind === "append-events" || kind === "live-event") return "writer";
  return kind === "finish" ? "terminal" : null;
}
