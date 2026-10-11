import type {
  AgentEvent,
  CanonicalAgentEvent,
  InterruptionCause,
  PersistedTurnFailure,
  TurnFailure,
  TurnStopCause,
} from "@mcode/contracts";

const PERSISTED_FAILURE_MESSAGE_MAX = 8_000;
const FALLBACK_FAILURE_MESSAGE = "Provider turn failed";

/** Structured cause a terminal write records with a non-completed outcome. */
export interface TurnEndingCause {
  readonly stop?: TurnStopCause;
  readonly cause?: InterruptionCause;
  readonly failure?: PersistedTurnFailure;
}

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

/** Rebuild the adapter classification a persisted failure came from, for a synthesized Error event. */
export function adapterTurnFailure(failure: PersistedTurnFailure | undefined): TurnFailure {
  if (!failure) return { kind: "fatal" };
  return {
    kind: failure.kind,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.limitType !== undefined ? { limitType: failure.limitType } : {}),
  };
}

/** Return whether a persisted failure was classified from this adapter failure. */
export function persistedFromAdapterFailure(
  persisted: PersistedTurnFailure | undefined,
  adapter: TurnFailure,
): boolean {
  return persisted !== undefined && persisted.kind === adapter.kind && persisted.status === adapter.status
    && persisted.code === adapter.code && persisted.limitType === adapter.limitType
    && (adapter.retries === undefined
      || (persisted.retries?.made === adapter.retries.made && persisted.retries.max === adapter.retries.max));
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
    case "turn.interrupted": return { ...payload, cause: ending?.cause ?? "unknown" };
    case "turn.errored": return { ...payload,
      failure: ending?.failure ?? { kind: "fatal", provider: providerId, message: boundedFailureMessage(payload.error) } };
    default: return payload;
  }
}

function boundedFailureMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length === 0 ? FALLBACK_FAILURE_MESSAGE : trimmed.slice(0, PERSISTED_FAILURE_MESSAGE_MAX);
}
