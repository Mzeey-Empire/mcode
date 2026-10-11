/**
 * Domain model of one durable Send now steer. A steer is a union over its state, so code that
 * reads a `resend_queued` row always has the replacement id and code that reads a `rejected`
 * row always has the stored failure.
 */
import * as NodeCrypto from "node:crypto";
import { z } from "zod";
import {
  MessageMentionsSchema,
  TurnSteerErrorCodeSchema,
  type HeldSteer,
  type TurnSteerErrorCode,
} from "@mcode/contracts";

/** Settled rows are kept this long for replays, then deleted at startup. Held rows never expire. */
export const TURN_STEER_RETENTION_DAYS = 30;

/** Message fields stored with a steer so an uncertain steer survives a reload. */
export const TurnSteerPayloadSchema = z.object({
  content: z.string().min(1),
  mentions: MessageMentionsSchema().optional(),
}).strict();
/** Message fields stored with a steer. */
export type TurnSteerPayload = z.infer<typeof TurnSteerPayloadSchema>;

/** Why the provider refused a steer before taking it. */
export const TurnSteerRejectionSchema = z.object({
  code: z.enum(["turn_not_running", "steer_rejected"]),
  detail: z.string(),
}).strict();
/** Why the provider refused a steer before taking it. */
export type TurnSteerRejection = z.infer<typeof TurnSteerRejectionSchema>;

const TurnSteerBaseSchema = z.object({
  messageId: z.string().uuid(),
  threadId: z.string().min(1),
  turnExecutionId: z.string().min(1),
  inputsHash: z.string().min(1),
  payload: TurnSteerPayloadSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

/** Fields written before the adapter call. */
export const PendingTurnSteerInputSchema = TurnSteerBaseSchema.omit({ createdAt: true, updatedAt: true });
/** Fields written before the adapter call. */
export type PendingTurnSteerInput = z.infer<typeof PendingTurnSteerInputSchema>;

/** One stored steer, by state. */
export const TurnSteerRecordSchema = z.discriminatedUnion("state", [
  TurnSteerBaseSchema.extend({ state: z.literal("pending") }),
  TurnSteerBaseSchema.extend({ state: z.literal("delivered") }),
  TurnSteerBaseSchema.extend({ state: z.literal("rejected"), rejection: TurnSteerRejectionSchema }),
  TurnSteerBaseSchema.extend({ state: z.literal("delivery_unknown") }),
  TurnSteerBaseSchema.extend({ state: z.literal("resend_queued"), replacementMessageId: z.string().uuid() }),
  // A closed resend keeps its replacement id so that id can never be steered later.
  TurnSteerBaseSchema.extend({ state: z.literal("closed"), replacementMessageId: z.string().uuid().nullable() }),
]);
/** One stored steer, by state. */
export type TurnSteerRecord = z.infer<typeof TurnSteerRecordSchema>;
/** Lifecycle state of a stored steer. */
export type TurnSteerState = TurnSteerRecord["state"];

/** How the adapter call settled a `pending` steer. `delivered` is written with the transcript message instead. */
export const TurnSteerSettlementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("rejected"), rejection: TurnSteerRejectionSchema }).strict(),
  z.object({ state: z.literal("delivery_unknown") }).strict(),
]);
/** How the adapter call settled a `pending` steer. */
export type TurnSteerSettlement = z.infer<typeof TurnSteerSettlementSchema>;

/** Inputs a replay must repeat exactly. */
export interface TurnSteerInputs {
  threadId: string;
  turnExecutionId: string;
  payload: TurnSteerPayload;
}

/** sha256 of the validated steer inputs. A replay with another hash is a different request. */
export function hashTurnSteerInputs(inputs: TurnSteerInputs): string {
  const canonical = JSON.stringify([
    inputs.threadId,
    inputs.turnExecutionId,
    inputs.payload.content,
    inputs.payload.mentions ?? null,
  ]);
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

/** Project a held row for `agent.listHeldSteers`; other states are not held. */
export function toHeldSteer(record: TurnSteerRecord): HeldSteer | null {
  const common = {
    messageId: record.messageId,
    threadId: record.threadId,
    content: record.payload.content,
    ...(record.payload.mentions ? { mentions: record.payload.mentions } : {}),
  };
  if (record.state === "delivery_unknown") return { ...common, state: "delivery_unknown" };
  if (record.state === "resend_queued") {
    return { ...common, state: "resend_queued", replacementMessageId: record.replacementMessageId };
  }
  return null;
}

/** Error name that survives the database writer boundary, which keeps only name, message and code. */
export const TURN_STEER_ERROR_NAME = "TurnSteerError";

/** A steer or resend failure the client acts on. The provider never took the message. */
export class TurnSteerError extends Error {
  constructor(readonly code: TurnSteerErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = TURN_STEER_ERROR_NAME;
  }
}

/** A replay reused a steer id with different inputs. The client sent a malformed request. */
export class TurnSteerConflictError extends Error {
  readonly code = "INVALID_PARAMS";

  constructor() {
    super("This steer id was already used with different inputs.");
    this.name = "TurnSteerConflictError";
  }
}

/** A steer's mentions failed the checks `agent.send` applies, so it was never sent. */
export class TurnSteerMentionError extends Error {
  readonly code = "INVALID_PARAMS";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TurnSteerMentionError";
  }
}

/**
 * Recover a steer failure thrown inside a database writer transaction. The writer rebuilds
 * errors as plain `Error`s, so the class is matched by name and code instead.
 */
export function asTurnSteerError(error: unknown): TurnSteerError | null {
  if (error instanceof TurnSteerError) return error;
  if (!(error instanceof Error) || error.name !== TURN_STEER_ERROR_NAME) return null;
  const code = TurnSteerErrorCodeSchema().safeParse("code" in error ? error.code : undefined);
  return code.success ? new TurnSteerError(code.data, error.message) : null;
}
