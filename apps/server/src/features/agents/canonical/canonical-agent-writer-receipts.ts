import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import { CanonicalAgentEventEnvelopeSchema } from "@mcode/contracts";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import {
  canonicalAgentEvents,
  canonicalWriterOperationReceipts,
} from "../../../runtime/persistence/sqlite/schema.js";
import type { CanonicalWriterRequest, CanonicalWriterResponse } from "./canonical-agent-writer-protocol.js";

type WriteRequest = Extract<CanonicalWriterRequest, {
  kind: "commit" | "record-parent-narrative-recovery" | "classify-parent-narrative-recovery";
}>;
type WriteResponse = Extract<CanonicalWriterResponse, {
  kind: "committed" | "parent-narrative-recovery-recorded" | "parent-narrative-recovery-classified";
}>;

const storedReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("committed"),
    receipt: z.object({
      outcome: z.enum(["committed", "duplicate", "conflict", "terminal-outcome-confirmed", "ingest-overflow"]),
      conversationRevision: z.number().int(),
      rosterRevision: z.number().int(),
      acceptedThrough: z.number().int(),
      durableThrough: z.number().int(),
      eventIds: z.array(z.string()),
    }),
  }),
  z.object({
    kind: z.literal("parent-narrative-recovery-recorded"),
    receipt: z.object({ recorded: z.boolean() }),
  }),
  z.object({
    kind: z.literal("parent-narrative-recovery-classified"),
    receipt: z.object({ recorded: z.literal(true), reset: z.literal(true) }),
  }),
]);

/** An operation ID may be retried only with the same kind and semantic input. */
export class CanonicalWriterOperationConflict extends Error {}

/** The caller must acknowledge handled receipts before admitting more writes for an execution. */
export class CanonicalWriterReceiptCapacity extends Error {}

export const MAX_UNACKNOWLEDGED_RECEIPTS_PER_EXECUTION = 16_384;

/** Atomically stores compact receipts so a restarted worker can replay lost acknowledgements. */
export class CanonicalAgentWriterReceipts {
  private readonly orm;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
  }

  execute(request: WriteRequest, apply: () => WriteResponse): WriteResponse {
    const inputHash = fingerprint(request);
    return this.db.transaction(() => {
      const existing = this.orm.select().from(canonicalWriterOperationReceipts)
        .where(and(
          eq(canonicalWriterOperationReceipts.executionId, request.executionId),
          eq(canonicalWriterOperationReceipts.operationId, request.operationId),
        )).get();
      if (existing) {
        if (existing.kind !== request.kind || existing.inputHash !== inputHash) {
          throw new CanonicalWriterOperationConflict("Canonical writer operation ID was reused with different input");
        }
        return this.replay(request, existing.receiptJson);
      }
      const outstanding = this.orm.select({ count: count() }).from(canonicalWriterOperationReceipts)
        .where(eq(canonicalWriterOperationReceipts.executionId, request.executionId)).get()?.count ?? 0;
      if (outstanding >= MAX_UNACKNOWLEDGED_RECEIPTS_PER_EXECUTION) {
        throw new CanonicalWriterReceiptCapacity("Canonical writer receipt capacity reached");
      }
      const response = apply();
      if (response.kind === "parent-narrative-recovery-recorded" && !response.receipt.recorded) {
        return response;
      }
      this.orm.insert(canonicalWriterOperationReceipts).values({
        executionId: request.executionId,
        operationId: request.operationId,
        kind: request.kind,
        inputHash,
        receiptJson: compactReceipt(response),
      }).run();
      return response;
    })();
  }

  /** Removes a receipt only after the caller has completed its dependent publication or journal discard. */
  acknowledge(executionId: string, operationId: string): void {
    this.orm.delete(canonicalWriterOperationReceipts).where(and(
      eq(canonicalWriterOperationReceipts.executionId, executionId),
      eq(canonicalWriterOperationReceipts.operationId, operationId),
    )).run();
  }

  private replay(request: WriteRequest, receiptJson: string): WriteResponse {
    const stored = storedReceiptSchema.parse(JSON.parse(receiptJson));
    const correlation = {
      requestId: request.requestId,
      operationId: request.operationId,
      executionId: request.executionId,
    };
    if (stored.kind === "committed") {
      return {
        ...correlation,
        kind: "committed",
        receipt: {
          outcome: stored.receipt.outcome,
          conversationRevision: stored.receipt.conversationRevision,
          rosterRevision: stored.receipt.rosterRevision,
          acceptedThrough: stored.receipt.acceptedThrough,
          durableThrough: stored.receipt.durableThrough,
          events: stored.receipt.eventIds.map((eventId) => this.loadEvent(request.executionId, eventId)),
        },
      };
    }
    if (stored.kind === "parent-narrative-recovery-recorded") {
      return { ...correlation, kind: stored.kind, receipt: stored.receipt };
    }
    return { ...correlation, kind: stored.kind, receipt: stored.receipt };
  }

  private loadEvent(executionId: string, eventId: string) {
    const row = this.orm.select({ envelopeJson: canonicalAgentEvents.envelopeJson })
      .from(canonicalAgentEvents)
      .where(and(
        eq(canonicalAgentEvents.executionId, executionId),
        eq(canonicalAgentEvents.eventId, eventId),
      ))
      .get();
    if (!row) throw new Error(`Canonical writer receipt event was not found: ${eventId}`);
    return CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
  }
}

function compactReceipt(response: WriteResponse): string {
  if (response.kind !== "committed") {
    return JSON.stringify({ kind: response.kind, receipt: response.receipt });
  }
  const { events, ...receipt } = response.receipt;
  return JSON.stringify({
    kind: response.kind,
    receipt: { ...receipt, eventIds: events.map((event) => event.eventId) },
  });
}

function fingerprint(request: WriteRequest): string {
  if (!request.operationId || request.operationId.length > 256 || !request.executionId) {
    throw new Error("Canonical writer operation and execution IDs are required and bounded");
  }
  const input = stableJson({ kind: request.kind, input: request.input });
  return NodeCrypto.createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value))));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJsonValue(entry)]));
}
