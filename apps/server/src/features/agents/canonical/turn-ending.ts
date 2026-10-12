import type {
  AgentEvent,
  CanonicalAgentEvent,
  InterruptionCause,
  PersistedTurnFailure,
  TurnFailure,
  TurnStopCause,
  TurnUsageLimit,
} from "@mcode/contracts";

const PERSISTED_FAILURE_MESSAGE_MAX = 8_000;
const FALLBACK_FAILURE_MESSAGE = "Provider turn failed";
const INTERRUPTION_REASON_MAX = 2_000;

/** A provider usage limit that interrupted the turn, with the reset the provider reported. */
export interface UsageLimitEnding {
  readonly cause: "usage_limit";
  readonly usageLimit: TurnUsageLimit;
  readonly stop?: never;
  readonly failure?: never;
}

/** A classified provider failure that errored the turn. */
export interface FailureEnding {
  readonly failure: PersistedTurnFailure;
  readonly stop?: never;
  readonly cause?: never;
  readonly usageLimit?: never;
}

/**
 * Structured cause a terminal write records with a non-completed outcome. Each member names one cause, so a
 * usage limit can only be recorded with its "usage_limit" interruption cause.
 */
export type TurnEndingCause =
  | { readonly stop: TurnStopCause; readonly cause?: never; readonly usageLimit?: never; readonly failure?: never }
  | {
    readonly cause: Exclude<InterruptionCause, "usage_limit">;
    readonly stop?: never;
    readonly usageLimit?: never;
    readonly failure?: never;
  }
  | UsageLimitEnding
  | FailureEnding;

/** Terminal outcome and ending recorded for a provider Error. */
export type ProviderFailureTerminal =
  | { readonly outcome: "interrupted"; readonly ending: UsageLimitEnding }
  | { readonly outcome: "errored"; readonly ending: FailureEnding };

/** Provider retry progress last reported by an ApiRetry event. */
export interface ObservedProviderRetries {
  readonly made: number;
  readonly max?: number;
}

/** Read bounded retry progress from an ApiRetry event, ignoring values the persisted schema would reject. */
export function observedProviderRetries(
  event: Extract<AgentEvent, { type: "apiRetry" }>,
): ObservedProviderRetries | undefined {
  if (!Number.isSafeInteger(event.attempt) || event.attempt === undefined || event.attempt < 0) return undefined;
  const max = event.maxRetries;
  return Number.isSafeInteger(max) && max !== undefined && max > 0
    ? { made: event.attempt, max }
    : { made: event.attempt };
}

/**
 * Convert an adapter failure into its durable form where the execution accepts the terminal error.
 * The reset time becomes absolute here because a relative wait is meaningless once the turn is replayed.
 */
export function persistTurnFailure(input: {
  readonly failure: TurnFailure;
  readonly provider: string;
  readonly message: string;
  readonly acceptedAt: number;
  readonly lastRetries?: ObservedProviderRetries;
}): PersistedTurnFailure {
  const { failure } = input;
  const retries = failure.retries ?? input.lastRetries;
  return {
    kind: failure.kind,
    provider: input.provider,
    message: boundedFailureMessage(input.message),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.retryAfterMs !== undefined
      ? { resetsAt: new Date(input.acceptedAt + failure.retryAfterMs).toISOString() } : {}),
    ...(failure.limitType !== undefined ? { limitType: failure.limitType } : {}),
    ...(retries ? { retries: { ...retries } } : {}),
  };
}

/**
 * A usage limit pauses the turn until the limit resets, so it ends interrupted with the reset kept for Resume;
 * every other classified failure ends errored with the failure kept for Retry and Details.
 */
export function providerFailureTerminal(failure: PersistedTurnFailure): ProviderFailureTerminal {
  if (failure.kind !== "usage_limit") return { outcome: "errored", ending: { failure } };
  const usageLimit: TurnUsageLimit = {
    ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
    ...(failure.limitType !== undefined ? { limitType: failure.limitType } : {}),
  };
  return { outcome: "interrupted", ending: { cause: "usage_limit", usageLimit } };
}

/** Rebuild the adapter classification an ending came from, for a synthesized Error event. */
export function adapterTurnFailure(ending: TurnEndingCause | undefined): TurnFailure {
  if (ending?.cause === "usage_limit") {
    const { limitType } = ending.usageLimit;
    return { kind: "usage_limit", ...(limitType !== undefined ? { limitType } : {}) };
  }
  const failure = ending?.failure;
  if (!failure) return { kind: "fatal" };
  return {
    kind: failure.kind,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.limitType !== undefined ? { limitType: failure.limitType } : {}),
  };
}

/** Return whether an ending was classified from this adapter failure. */
export function endingFromAdapterFailure(ending: TurnEndingCause | undefined, adapter: TurnFailure): boolean {
  if (ending?.cause === "usage_limit") {
    return adapter.kind === "usage_limit" && ending.usageLimit.limitType === adapter.limitType;
  }
  const persisted = ending?.failure;
  return persisted !== undefined && sameClassification(persisted, adapter) && sameRetries(persisted.retries, adapter.retries);
}

function sameClassification(persisted: PersistedTurnFailure, adapter: TurnFailure): boolean {
  return persisted.kind === adapter.kind && persisted.status === adapter.status
    && persisted.code === adapter.code && persisted.limitType === adapter.limitType;
}

function sameRetries(persisted: PersistedTurnFailure["retries"], adapter: TurnFailure["retries"]): boolean {
  return adapter === undefined || (persisted?.made === adapter.made && persisted.max === adapter.max);
}

/**
 * Attach the ending cause to a terminal payload so every new terminal write records one.
 * A writer without a cause records the same defaults the reducer applies to legacy envelopes.
 */
export function withTurnEnding(
  payload: CanonicalAgentEvent,
  ending: TurnEndingCause | undefined,
  providerId: string,
): CanonicalAgentEvent {
  switch (payload.type) {
    case "turn.cancelled": return { ...payload, stop: ending?.stop ?? { by: "user" } };
    case "turn.interrupted": return withInterruptionCause(payload, ending);
    case "turn.errored": return { ...payload,
      failure: ending?.failure ?? { kind: "fatal", provider: providerId, message: boundedFailureMessage(payload.error) } };
    default: return payload;
  }
}

function withInterruptionCause(
  payload: Extract<CanonicalAgentEvent, { type: "turn.interrupted" }>,
  ending: TurnEndingCause | undefined,
): CanonicalAgentEvent {
  return ending?.cause === "usage_limit"
    ? { ...payload, cause: ending.cause, usageLimit: ending.usageLimit }
    : { ...payload, cause: ending?.cause ?? "unknown" };
}

/**
 * Reason text for an interrupted turn. A usage limit carries the provider's own message, which can exceed the
 * interruption reason bound that failure messages do not share.
 */
export function interruptionReason(error: string | undefined): string {
  const trimmed = error?.trim() ?? "";
  return trimmed.length === 0 ? "Turn interrupted" : trimmed.slice(0, INTERRUPTION_REASON_MAX);
}

function boundedFailureMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length === 0 ? FALLBACK_FAILURE_MESSAGE : trimmed.slice(0, PERSISTED_FAILURE_MESSAGE_MAX);
}
