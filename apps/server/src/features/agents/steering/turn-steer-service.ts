/**
 * Durable Send now. A steer row is written before the adapter call and Mcode never sends a
 * steered message twice on its own; see `docs/plans/ready-for-build/sections/05-running-turn.md`
 * section 6 for the step order this follows.
 */
import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import {
  MAX_HELD_STEERS,
  type ListHeldSteersResult,
  type SettleUnknownSteerParams,
  type SettleUnknownSteerResult,
  type TurnSteerParams,
  type TurnSteerResult,
  type SystemNoticeMetadata,
} from "@mcode/contracts";
import { FileService } from "../../projects/files/file-service.js";
import { injectMentionFileContents, validateMessageMentions, type MentionFiles } from "../turns/message-mentions.js";
import { TurnSteerRepo } from "./persistence/turn-steer-repo.js";
import {
  TurnSteerRuntimePort,
  type SteerableTurn,
  type TurnSteerMessage,
  type TurnSteerRuntime,
} from "./turn-steer-runtime-port.js";
import {
  TURN_STEER_RETENTION_DAYS,
  TurnSteerConflictError,
  TurnSteerError,
  TurnSteerMentionError,
  hashTurnSteerInputs,
  toHeldSteer,
  type TurnSteerPayload,
  type TurnSteerRecord,
  type TurnSteerRejection,
} from "./turn-steer.js";

/**
 * How long a steer the provider took waits for its transcript save. A save stuck in retries would
 * otherwise hold the call open; past this the steer is answered as delivered and a late save still
 * adds it to the transcript.
 */
export const TURN_STEER_SAVE_TIMEOUT_MS = 10_000;

/** Test-only points where a steer stops as if the server died there. */
export type TurnSteerFaultPoint = "after-provider-accepted";

/** Thrown at a fault point. The service never catches it, so the row is left exactly as a crash would leave it. */
export class TurnSteerFaultStop extends Error {
  constructor(readonly point: TurnSteerFaultPoint) {
    super(`Steer stopped at ${point}`);
    this.name = "TurnSteerFaultStop";
  }
}

/** Test-only controls for one steer. */
export interface TurnSteerOptions {
  readonly stopAt?: TurnSteerFaultPoint;
  /** Server-authored attribution retained with the durable steer payload. */
  readonly systemNotice?: SystemNoticeMetadata;
}

interface InFlightSteer {
  readonly inputsHash: string;
  readonly result: Promise<TurnSteerResult>;
}

interface NewSteer {
  readonly params: TurnSteerParams;
  readonly payload: TurnSteerPayload;
  readonly inputsHash: string;
  readonly turn: SteerableTurn & { readonly steer: NonNullable<SteerableTurn["steer"]> };
}

/** Runs `agent.steer`, `agent.listHeldSteers` and `agent.settleUnknownSteer`. */
@injectable()
export class TurnSteerService {
  /** Adapter calls this process has not answered yet. A replay joins one instead of calling again. */
  private readonly inFlight = new Map<string, InFlightSteer>();

  constructor(
    @inject(TurnSteerRepo) private readonly repo: TurnSteerRepo,
    @inject(TurnSteerRuntimePort) private readonly runtime: TurnSteerRuntime,
    @inject(FileService) private readonly files: MentionFiles,
  ) {}

  /** Add a message to the running turn. Every thrown `TurnSteerError` means the provider never took it. */
  steer(params: TurnSteerParams, options: TurnSteerOptions = {}): Promise<TurnSteerResult> {
    const payload: TurnSteerPayload = { content: params.content, ...(params.mentions ? { mentions: params.mentions } : {}),
      ...(options.systemNotice ? { systemNotice: options.systemNotice } : {}) };
    const inputsHash = hashTurnSteerInputs({ threadId: params.threadId, turnExecutionId: params.turnExecutionId, payload });
    const running = this.inFlight.get(params.messageId);
    if (running) {
      return running.inputsHash === inputsHash ? running.result : Promise.reject(new TurnSteerConflictError());
    }
    const record = this.repo.find(params.messageId);
    if (record) return this.replay(record, inputsHash);
    let turn: NewSteer["turn"];
    try {
      turn = this.steerableTurn(params);
      this.validateMentions(turn, params);
    } catch (error) {
      return Promise.reject(error);
    }
    // Registered before the first await, so a concurrent replay joins this call.
    const result = this.deliver({ params, payload, inputsHash, turn }, options);
    this.inFlight.set(params.messageId, { inputsHash, result });
    const forget = () => { this.inFlight.delete(params.messageId); };
    result.then(forget, forget);
    return result;
  }

  /** Every held steer, oldest first, so a reconnecting client can restore its tray. */
  listHeldSteers(): ListHeldSteersResult {
    return this.repo.listHeld(MAX_HELD_STEERS).flatMap((record) => toHeldSteer(record) ?? []);
  }

  /** Send again or Remove an uncertain steer. Replays return the stored intent. */
  async settleUnknownSteer(params: SettleUnknownSteerParams): Promise<SettleUnknownSteerResult> {
    await this.inFlight.get(params.messageId)?.result.catch(() => undefined);
    await this.settleStalePending(params.messageId);
    if (params.action === "remove") {
      return await this.repo.remove(params.messageId) ? { status: "removed" } : { status: "closed" };
    }
    // A fresh id, because the provider may already hold the original under its own. Whether this
    // call or a racing window queued it, the stored row is the answer.
    await this.repo.requeue(params.messageId, NodeCrypto.randomUUID());
    return this.storedResend(params.messageId);
  }

  /** At startup no adapter call survives: pending steers become uncertain and old settled rows go. */
  async reconcileAtStartup(): Promise<{ unknown: number; deleted: number }> {
    const unknown = await this.repo.markPendingUnknown();
    const deleted = await this.repo.deleteSettledOlderThan(TURN_STEER_RETENTION_DAYS);
    return { unknown, deleted };
  }

  private steerableTurn(params: TurnSteerParams): NewSteer["turn"] {
    if (this.repo.isReplacementId(params.messageId)) {
      throw new TurnSteerError("steer_unsupported", "A resend can only be sent as a new turn.");
    }
    const turn = this.runtime.runningTurn(params.threadId);
    if (!turn || turn.turnExecutionId !== params.turnExecutionId) {
      throw new TurnSteerError("turn_not_running", "The turn is no longer running.");
    }
    const steer = turn.steer;
    if (!steer) throw new TurnSteerError("steer_unsupported", "This provider cannot add a message to a running turn.");
    return { ...turn, steer };
  }

  /** The checks `agent.send` applies, so a steer cannot carry a mention a new turn would refuse. */
  private validateMentions(turn: SteerableTurn, params: TurnSteerParams): void {
    if (!params.mentions?.length) return;
    try {
      validateMessageMentions(this.files, { workspaceId: turn.workspaceId, threadId: params.threadId,
        providerId: turn.providerId }, params.content, params.mentions);
    } catch (error) {
      throw new TurnSteerMentionError(error);
    }
  }

  /** The provider gets the text `agent.send` would give it; the transcript keeps what the user wrote. */
  private async providerMessage(turn: NewSteer["turn"], params: TurnSteerParams): Promise<TurnSteerMessage> {
    const mentions = params.mentions ?? [];
    if (mentions.length === 0) return { steerId: params.messageId, message: params.content };
    if (turn.providerId === "codex") return { steerId: params.messageId, message: params.content, mentions };
    try {
      const message = await injectMentionFileContents(this.files, { workspaceId: turn.workspaceId,
        threadId: params.threadId }, mentions, params.content);
      return { steerId: params.messageId, message, mentions };
    } catch (error) {
      throw new TurnSteerMentionError(error);
    }
  }

  private async deliver(steer: NewSteer, options: TurnSteerOptions): Promise<TurnSteerResult> {
    const { params, payload, inputsHash, turn } = steer;
    const messageId = params.messageId;
    // Before the row, so a mention whose file cannot be read leaves nothing held.
    const message = await this.providerMessage(turn, params);
    await this.repo.insertPending({ messageId, threadId: params.threadId, turnExecutionId: params.turnExecutionId,
      inputsHash, payload });
    const outcome = await this.callAdapter(turn, params, message);
    if (outcome.outcome === "rejected") {
      const rejection: TurnSteerRejection = { code: outcome.reason === "turn_not_running" ? "turn_not_running" : "steer_rejected",
        detail: outcome.detail };
      await this.repo.settle(messageId, { state: "rejected", rejection });
      throw rejectionError(rejection);
    }
    if (outcome.outcome === "unknown") return this.markUnknown(messageId);
    stopAt(options, "after-provider-accepted");
    try {
      await withinSaveTimeout(this.runtime.recordDelivered({ threadId: params.threadId, turnExecutionId: params.turnExecutionId,
        messageId, content: payload.content, ...(payload.mentions ? { mentions: payload.mentions } : {}),
        ...(payload.systemNotice ? { systemNotice: payload.systemNotice } : {}) }));
    } catch (error) {
      // The provider holds the message, so it is delivered even though the transcript may not have it
      // yet. Held as uncertain, it would offer Send again and the agent could get it twice.
      logger.error("Steered message was taken but not saved", { threadId: params.threadId, messageId,
        errorType: error instanceof Error ? error.name : "unknown" });
      if (!await this.repo.settle(messageId, { state: "delivered" })) return this.replayStored(messageId);
    }
    return { status: "delivered", messageId };
  }

  private async callAdapter(turn: NewSteer["turn"], params: TurnSteerParams, message: TurnSteerMessage) {
    try {
      return await turn.steer(message);
    } catch (error) {
      // A throw after the request may have gone out cannot prove the provider refused it.
      logger.warn("Steer adapter call failed", { threadId: params.threadId, messageId: params.messageId,
        errorType: error instanceof Error ? error.name : "unknown" });
      return { outcome: "unknown" as const, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async markUnknown(messageId: string): Promise<TurnSteerResult> {
    if (await this.repo.settle(messageId, { state: "delivery_unknown" })) return { status: "delivery_unknown", messageId };
    return this.replayStored(messageId);
  }

  private async replay(record: TurnSteerRecord, inputsHash: string): Promise<TurnSteerResult> {
    if (record.inputsHash !== inputsHash) throw new TurnSteerConflictError();
    switch (record.state) {
      case "delivered":
      case "delivery_unknown":
      case "closed":
        return { status: record.state, messageId: record.messageId };
      case "resend_queued":
        return { status: "closed", messageId: record.messageId };
      case "rejected":
        throw rejectionError(record.rejection);
      case "pending":
        return this.markUnknown(record.messageId);
    }
  }

  private replayStored(messageId: string): Promise<TurnSteerResult> {
    const record = this.repo.find(messageId);
    if (!record) throw new Error(`Steer ${messageId} disappeared while settling`);
    return this.replay(record, record.inputsHash);
  }

  /** A pending row with no call in flight here was left by a failed attempt; the provider may hold it. */
  private async settleStalePending(messageId: string): Promise<void> {
    if (this.repo.find(messageId)?.state === "pending") await this.repo.settle(messageId, { state: "delivery_unknown" });
  }

  private storedResend(messageId: string): SettleUnknownSteerResult {
    const record = this.repo.find(messageId);
    return record?.state === "resend_queued"
      ? { status: "requeued", replacementMessageId: record.replacementMessageId }
      : { status: "closed" };
  }
}

function rejectionError(rejection: TurnSteerRejection): TurnSteerError {
  return rejection.code === "turn_not_running"
    ? new TurnSteerError("turn_not_running", "The turn ended before the provider took the message.")
    : new TurnSteerError("steer_rejected", "The provider refused the message.", rejection.detail);
}

async function withinSaveTimeout(save: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnSteerSaveTimeout()), TURN_STEER_SAVE_TIMEOUT_MS);
  });
  try {
    await Promise.race([save, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class TurnSteerSaveTimeout extends Error {
  constructor() {
    super(`Steered message was not saved within ${TURN_STEER_SAVE_TIMEOUT_MS}ms`);
    this.name = "TurnSteerSaveTimeout";
  }
}

function stopAt(options: TurnSteerOptions, point: TurnSteerFaultPoint): void {
  if (options.stopAt === point) throw new TurnSteerFaultStop(point);
}
