import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import { AgentProgressPositionSchema, CanonicalAgentEventEnvelopeSchema, CanonicalAgentRevisionSchema } from "@mcode/contracts";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import {
  canonicalAgentEvents,
  canonicalAgentTurns,
  canonicalWriterOperationReceipts,
  canonicalWriterThreadOperationReceipts,
} from "../../../runtime/persistence/sqlite/schema.js";
import type { CanonicalWriterRequest, CanonicalWriterResponse } from "./canonical-agent-writer-protocol.js";
import { StoredCanonicalProviderProjectionSchema } from "./canonical-provider-projection.js";
import { CanonicalAcceptedWriteInputSchema } from "./canonical-accepted-write.js";
import { syntheticThreadExecutionId } from "./canonical-thread-execution.js";

type WriteRequest = Extract<CanonicalWriterRequest, {
  kind: "commit" | "append-accepted" | "record-parent-narrative-recovery" | "classify-parent-narrative-recovery";
}>;
type AtomicWriteRequest = Extract<WriteRequest, { kind: "commit" | "append-accepted" | "classify-parent-narrative-recovery" }>;
type WriteResponse = Extract<CanonicalWriterResponse, {
  kind: "committed" | "accepted-appended" | "parent-narrative-recovery-recorded" | "parent-narrative-recovery-classified";
}>;

type ReceiptOwner = { kind: "execution"; executionId: string }
  | { kind: "thread"; executionId: string; threadId: string };

const storedReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted-appended"), result: z.object({
    receipt: z.object({ operationId: z.string(), contentHash: z.string(), predecessor: AgentProgressPositionSchema,
      through: AgentProgressPositionSchema, durableRevision: z.number().int().nonnegative() }).strict(),
    revision: CanonicalAgentRevisionSchema(), eventIds: z.array(z.string()).max(256),
  }).strict() }).strict(),
  z.object({
    kind: z.literal("committed"),
    receipt: z.object({
      outcome: z.enum(["committed", "duplicate", "conflict", "terminal-outcome-confirmed", "ingest-overflow"]),
      conversationRevision: z.number().int(),
      rosterRevision: z.number().int(),
      acceptedThrough: z.number().int(),
      durableThrough: z.number().int(),
      eventIds: z.array(z.string()),
      providerProjection: StoredCanonicalProviderProjectionSchema.optional(),
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

  execute(request: AtomicWriteRequest, apply: () => WriteResponse): WriteResponse {
    const inputHash = fingerprint(request);
    const owner = receiptOwner(request);
    // Reserve the writer before reading. A peer commit otherwise makes this WAL snapshot impossible to upgrade.
    return this.db.transaction(() => {
      this.assertOwnership(owner);
      const existing = this.loadReceipt(owner, request.operationId);
      if (existing) return this.replayMatching(request, inputHash, existing);
      this.assertCapacity(owner);
      const response = structuredClone(apply());
      this.insertReceipt(owner, request, inputHash, response);
      return response;
    }).immediate();
  }

  /** Recovery upserts are repeatable, so its bounded batches commit before a short final receipt transaction. */
  async executeBatchedRecovery(
    request: Extract<WriteRequest, { kind: "record-parent-narrative-recovery" }>,
    apply: () => Promise<WriteResponse>,
  ): Promise<WriteResponse> {
    const inputHash = fingerprint(request);
    const owner = receiptOwner(request);
    this.assertOwnership(owner);
    const existing = this.loadReceipt(owner, request.operationId);
    if (existing) return this.replayMatching(request, inputHash, existing);
    this.assertCapacity(owner);
    const response = await apply();
    if (response.kind !== "parent-narrative-recovery-recorded") {
      throw new Error("Canonical writer returned the wrong recovery response");
    }
    if (!response.receipt.recorded) return response;
    return this.db.transaction(() => {
      this.assertOwnership(owner);
      const committed = this.loadReceipt(owner, request.operationId);
      if (committed) return this.replayMatching(request, inputHash, committed);
      this.assertCapacity(owner);
      this.insertReceipt(owner, request, inputHash, response);
      return response;
    }).immediate();
  }

  /** Removes a receipt only after the caller has completed its dependent publication or journal discard. */
  acknowledge(executionId: string, operationId: string): void {
    this.db.transaction(() => {
      const turnReceipt = this.loadReceipt({ kind: "execution", executionId }, operationId);
      const threadReceipt = this.orm.select().from(canonicalWriterThreadOperationReceipts).where(and(
        eq(canonicalWriterThreadOperationReceipts.executionId, executionId),
        eq(canonicalWriterThreadOperationReceipts.operationId, operationId),
      )).get();
      if (turnReceipt && threadReceipt) throw new CanonicalWriterOperationConflict("Canonical writer receipt has ambiguous ownership");
      if (threadReceipt) {
        const owner: ReceiptOwner = { kind: "thread", executionId, threadId: threadReceipt.threadId };
        if (syntheticThreadExecutionId(owner.threadId) !== executionId) throw new Error("Canonical thread receipt execution does not match its thread");
        this.assertOwnership(owner);
        this.deleteReceipt(canonicalWriterThreadOperationReceipts, executionId, operationId);
      } else if (turnReceipt) {
        this.assertOwnership({ kind: "execution", executionId });
        this.deleteReceipt(canonicalWriterOperationReceipts, executionId, operationId);
      }
    }).immediate();
  }

  private deleteReceipt(table: typeof canonicalWriterOperationReceipts | typeof canonicalWriterThreadOperationReceipts,
    executionId: string, operationId: string): void {
    this.orm.delete(table).where(and(eq(table.executionId, executionId), eq(table.operationId, operationId))).run();
  }

  private loadReceipt(owner: ReceiptOwner, operationId: string) {
    const table = owner.kind === "thread" ? canonicalWriterThreadOperationReceipts : canonicalWriterOperationReceipts;
    return this.orm.select({ kind: table.kind, inputHash: table.inputHash, receiptJson: table.receiptJson }).from(table)
      .where(and(
        eq(table.executionId, owner.executionId),
        eq(table.operationId, operationId),
        owner.kind === "thread" ? eq(canonicalWriterThreadOperationReceipts.threadId, owner.threadId) : undefined,
      )).get();
  }

  private assertOwnership(owner: ReceiptOwner): void {
    const table = owner.kind === "thread" ? canonicalAgentTurns : canonicalWriterThreadOperationReceipts;
    if (this.orm.select({ executionId: table.executionId }).from(table)
      .where(eq(table.executionId, owner.executionId)).limit(1).get()) {
      throw new CanonicalWriterOperationConflict("Canonical writer receipt execution has conflicting ownership");
    }
  }

  private insertReceipt(owner: ReceiptOwner, request: WriteRequest, inputHash: string, response: WriteResponse): void {
    this.assertOwnership(owner);
    const values = { executionId: owner.executionId, operationId: request.operationId,
      kind: request.kind, inputHash, receiptJson: compactReceipt(response) };
    if (owner.kind === "thread") {
      this.orm.insert(canonicalWriterThreadOperationReceipts).values({ ...values, threadId: owner.threadId }).run();
    } else {
      this.orm.insert(canonicalWriterOperationReceipts).values(values).run();
    }
  }

  private replayMatching(request: WriteRequest, inputHash: string, existing: NonNullable<ReturnType<CanonicalAgentWriterReceipts["loadReceipt"]>>): WriteResponse {
    if (existing.kind !== request.kind || existing.inputHash !== inputHash) {
      throw new CanonicalWriterOperationConflict("Canonical writer operation ID was reused with different input");
    }
    return this.replay(request, existing.receiptJson);
  }

  private assertCapacity(owner: ReceiptOwner): void {
    const table = owner.kind === "thread" ? canonicalWriterThreadOperationReceipts : canonicalWriterOperationReceipts;
    const outstanding = this.orm.select({ count: count() }).from(table)
      .where(eq(table.executionId, owner.executionId)).get()?.count ?? 0;
    if (outstanding >= MAX_UNACKNOWLEDGED_RECEIPTS_PER_EXECUTION) {
      throw new CanonicalWriterReceiptCapacity("Canonical writer receipt capacity reached");
    }
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
          ...(stored.receipt.providerProjection ? { providerProjection: {
            events: stored.receipt.providerProjection.events,
            publications: stored.receipt.providerProjection.publications.map((event) => this.loadEvent(event.executionId, event.eventId)),
          } } : {}),
        },
      };
    }
    if (stored.kind === "accepted-appended") {
      if (request.kind !== "append-accepted") throw new Error("Canonical writer accepted receipt has the wrong operation kind");
      const { eventIds, ...result } = stored.result;
      return { ...correlation, kind: "accepted-appended", result: { ...result,
        events: eventIds.map((id) => this.loadEvent(request.executionId, id, request.input.execution.threadId)) } };
    }
    if (stored.kind === "parent-narrative-recovery-recorded") {
      return { ...correlation, kind: stored.kind, receipt: stored.receipt };
    }
    return { ...correlation, kind: stored.kind, receipt: stored.receipt };
  }

  private loadEvent(executionId: string, eventId: string, threadId?: string) {
    const row = this.orm.select({ envelopeJson: canonicalAgentEvents.envelopeJson })
      .from(canonicalAgentEvents)
      .where(and(
        eq(canonicalAgentEvents.executionId, executionId),
        eq(canonicalAgentEvents.eventId, eventId),
        threadId === undefined ? undefined : eq(canonicalAgentEvents.threadId, threadId),
      ))
      .get();
    if (!row) throw new Error(`Canonical writer receipt event was not found: ${eventId}`);
    return CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
  }
}

function receiptOwner(request: WriteRequest): ReceiptOwner {
  if (request.kind !== "append-accepted") {
    if (request.input.executionId !== request.executionId) throw new Error("Canonical writer execution mismatch");
    if (request.kind === "commit") assertProviderExecution(request.input.threadId, request.executionId);
    return { kind: "execution", executionId: request.executionId };
  }
  const { execution } = CanonicalAcceptedWriteInputSchema.parse(request.input);
  if (execution.executionId !== request.executionId) throw new Error("Canonical writer execution mismatch");
  if (execution.turnId !== "") {
    assertProviderExecution(execution.threadId, execution.executionId);
    return { kind: "execution", executionId: request.executionId };
  }
  if (syntheticThreadExecutionId(execution.threadId) !== execution.executionId) {
    throw new Error("Canonical thread receipt execution does not match its thread");
  }
  return { kind: "thread", executionId: request.executionId, threadId: execution.threadId };
}

function assertProviderExecution(threadId: string, executionId: string): void {
  if (executionId === syntheticThreadExecutionId(threadId)) {
    throw new CanonicalWriterOperationConflict("Canonical writer receipt execution has conflicting ownership");
  }
}

function compactReceipt(response: WriteResponse): string {
  if (response.kind === "accepted-appended") {
    const { events, ...result } = response.result;
    return JSON.stringify({ kind: response.kind, result: { ...result, eventIds: events.map((event) => event.eventId) } });
  }
  if (response.kind !== "committed") {
    return JSON.stringify({ kind: response.kind, receipt: response.receipt });
  }
  const { events, providerProjection, ...receipt } = response.receipt;
  return JSON.stringify(storedReceiptSchema.parse({
    kind: response.kind,
    receipt: { ...receipt, eventIds: events.map((event) => event.eventId),
      ...(providerProjection ? { providerProjection: { events: providerProjection.events,
        publications: providerProjection.publications.map((event) => ({
          executionId: event.routing.executionId, eventId: event.eventId,
        })) } } : {}),
    },
  }));
}

function fingerprint(request: WriteRequest): string {
  if (!request.operationId || request.operationId.length > 256 || !request.executionId) {
    throw new Error("Canonical writer operation and execution IDs are required and bounded");
  }
  const input = stableJson({ kind: request.kind, input: request.input,
    ...(request.kind === "commit" && request.projectProviderEvents ? { projectProviderEvents: true } : {}) });
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
