import { AgentEventSchema, type AgentEvent } from "@mcode/contracts";
import * as NodeUtil from "node:util";

import type {
  ExecutionLivePublicationReceipt, ExecutionSemanticOperation, ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";

const MAX_RECENT_PUBLICATIONS = 8_192;
const MAX_RECEIPT_EVENTS = 64;
const MAX_RECEIPT_BYTES = 512 * 1024;

/** The bound public AgentEvent bridge, normally AgentEventPublicationRegistry. */
export interface LiveAgentEventPublisher {
  isBound(): boolean;
  publish(event: AgentEvent): void;
}

/** Releases committed live events with stable identities for transport replay. */
export class ExecutionLivePublicationRelease {
  private readonly published = new Set<string>();

  constructor(private readonly publisher: LiveAgentEventPublisher) {}

  /** Validate the entire receipt before exposing any event in its original order. */
  release(operation: ExecutionSemanticOperation, receipt: ExecutionWriteReceipt): void {
    if (receipt.kind !== "committed" || !receipt.livePublication) return;
    const events = this.validate(operation, receipt);
    if (!this.publisher.isBound()) throw new Error("Live AgentEvent publisher is not bound");
    for (const entry of events) {
      if (this.published.has(entry.key)) continue;
      this.publisher.publish(entry.event);
      // Recent suppression saves repeat host work. The durable wire identity handles older replays.
      this.published.delete(entry.key);
      this.published.add(entry.key);
      if (this.published.size > MAX_RECENT_PUBLICATIONS) {
        this.published.delete(this.published.values().next().value as string);
      }
    }
  }

  private validate(
    operation: ExecutionSemanticOperation,
    receipt: Extract<ExecutionWriteReceipt, { kind: "committed" }>,
  ) {
    const entries = receipt.livePublication ?? [];
    if (receipt.operationId !== operation.operationId || !operation.livePublication
      || entries.length !== operation.livePublication.length || entries.length > MAX_RECEIPT_EVENTS
      || Buffer.byteLength(JSON.stringify(entries), "utf8") > MAX_RECEIPT_BYTES
      || !contiguousPublicationIds(entries)) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    return entries.map((entry, index) => this.validateEntry(operation, entry, index));
  }

  private validateEntry(operation: ExecutionSemanticOperation, entry: ExecutionLivePublicationReceipt, index: number) {
    const expected = operation.livePublication?.[index];
    if (!expected || !samePublicationHeader(operation, entry.after, expected.after)) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    const parsed = AgentEventSchema().safeParse(entry.event);
    const original = AgentEventSchema().safeParse(expected.event);
    if (!parsed.success || !original.success) throw new Error("Live AgentEvent publication receipt is invalid");
    if (parsed.data.threadId !== operation.execution.threadId
      || parsed.data.turnExecutionId !== operation.execution.executionId
      || !samePublishedEvent(operation, parsed.data, original.data)) {
      throw new Error("Live AgentEvent publication receipt is invalid");
    }
    return { key: JSON.stringify([operation.execution.executionId, entry.publicationId]),
      event: { ...parsed.data, publicationId: entry.publicationId } };
  }
}

function samePublicationHeader(
  operation: ExecutionSemanticOperation,
  after: "writer" | "terminal",
  expectedBarrier: "writer" | "terminal",
): boolean {
  return after === expectedBarrier && after === barrierFor(operation.mutation.kind);
}

function contiguousPublicationIds(entries: readonly ExecutionLivePublicationReceipt[]): boolean {
  const first = Number(entries[0]?.publicationId);
  return Number.isSafeInteger(first) && first > 0
    && entries.every((entry, index) => entry.publicationId === String(first + index));
}

function samePublishedEvent(operation: ExecutionSemanticOperation, actual: AgentEvent, expected: AgentEvent): boolean {
  if (NodeUtil.isDeepStrictEqual(actual, expected)) return true;
  if (operation.mutation.kind !== "live-event" || operation.mutation.systemIntents?.[0]?.kind !== "system-notice"
    || actual.type !== "system" || expected.type !== "system" || expected.messageId
    || !actual.messageId) return false;
  const { messageId: _generatedId, ...withoutGeneratedId } = actual;
  return NodeUtil.isDeepStrictEqual(withoutGeneratedId, expected);
}

function barrierFor(kind: ExecutionSemanticOperation["mutation"]["kind"]): "writer" | "terminal" | null {
  if (kind === "begin" || kind === "append-events" || kind === "live-event") return "writer";
  return kind === "finish" ? "terminal" : null;
}
