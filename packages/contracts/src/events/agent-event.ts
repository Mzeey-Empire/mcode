import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { QuotaCategorySchema } from "../providers/usage.js";

/**
 * All valid `type` discriminants for `AgentEvent`.
 * Use these constants instead of string literals to get autocomplete and
 * a compile-time error if a value is renamed or removed.
 *
 * @example
 * if (event.type === AgentEventType.ToolUse) { ... }
 */
export const AgentEventType = {
  TurnStarted: "turnStarted",
  Message: "message",
  ToolUse: "toolUse",
  ToolResult: "toolResult",
  TurnComplete: "turnComplete",
  Error: "error",
  Ended: "ended",
  System: "system",
  Compacting: "compacting",
  CompactSummary: "compactSummary",
  ModelFallback: "modelFallback",
  TextDelta: "textDelta",
  ToolInputDelta: "toolInputDelta",
  ToolProgress: "toolProgress",
  ContextEstimate: "contextEstimate",
  QuotaUpdate: "quotaUpdate",
  ProviderUnavailable: "providerUnavailable",
  RateLimited: "rateLimited",
  ApiRetry: "apiRetry",
} as const;

/** Union of all valid `AgentEvent` type discriminants. */
export type AgentEventType = typeof AgentEventType[keyof typeof AgentEventType];

/** Discriminated union of all events emitted by an agent provider. */
export const AgentEventSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      /** Emitted at the start of a new turn, before any other events. Mirrors TurnComplete/Ended.
       *  Used by the client to populate `runningThreadIds` for live-session UI indicators. */
      type: z.literal(AgentEventType.TurnStarted),
      threadId: z.string(),
    }),
    z.object({
      type: z.literal(AgentEventType.Message),
      threadId: z.string(),
      content: z.string(),
      tokens: z.number().nullable(),
      /** Server-assigned message ID, injected after DB persistence. Used by the client for stable branching. */
      messageId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.ToolUse),
      threadId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      toolInput: z.record(z.unknown()),
      parentToolCallId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.ToolResult),
      threadId: z.string(),
      toolCallId: z.string(),
      output: z.string(),
      isError: z.boolean(),
    }),
    z.object({
      type: z.literal(AgentEventType.TurnComplete),
      threadId: z.string(),
      reason: z.string(),
      costUsd: z.number().nullable(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      /** Model's max context window reported by the SDK, if available. */
      contextWindow: z.number().optional(),
      /** Accumulated total tokens processed across all API calls in the session. */
      totalProcessedTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
      costMultiplier: z.number().optional(),
      providerId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.Error),
      threadId: z.string(),
      error: z.string(),
    }),
    z.object({
      type: z.literal(AgentEventType.Ended),
      threadId: z.string(),
    }),
    z.object({
      type: z.literal(AgentEventType.System),
      threadId: z.string(),
      subtype: z.string(),
    }),
    z.object({
      /** Emitted when the SDK starts or finishes compacting the context window. */
      type: z.literal(AgentEventType.Compacting),
      threadId: z.string(),
      /** True when compaction is starting, false when it has finished. */
      active: z.boolean(),
    }),
    z.object({
      /** Emitted when a provider completes context compaction, carrying the generated summary. */
      type: z.literal(AgentEventType.CompactSummary),
      threadId: z.string(),
      /** Full compaction summary text produced by the SDK. Used to seed branched thread replays. */
      summary: z.string(),
    }),
    z.object({
      /** Emitted when the SDK fell back to an alternate model. */
      type: z.literal(AgentEventType.ModelFallback),
      threadId: z.string(),
      /** The model that was originally requested. */
      requestedModel: z.string(),
      /** The model that actually ran. */
      actualModel: z.string(),
    }),
    z.object({
      /** A streaming text chunk emitted as Claude types its response. */
      type: z.literal(AgentEventType.TextDelta),
      threadId: z.string(),
      /** Partial response text - append to accumulate the full response. */
      delta: z.string(),
    }),
    z.object({
      /** Incremental JSON fragment emitted while Claude builds a tool call's input. */
      type: z.literal(AgentEventType.ToolInputDelta),
      threadId: z.string(),
      /** Partial JSON string to append to the tool input being assembled. */
      partialJson: z.string(),
    }),
    z.object({
      /** Heartbeat emitted while a tool is executing, carrying elapsed wall-clock time. */
      type: z.literal(AgentEventType.ToolProgress),
      threadId: z.string(),
      /** Identifier of the tool call this progress event belongs to. */
      toolCallId: z.string(),
      /** Name of the tool currently executing. */
      toolName: z.string(),
      /** Elapsed seconds since the tool started, as reported by the SDK. */
      elapsedSeconds: z.number(),
    }),
    z.object({
      /**
       * Incremental context token estimate emitted during a turn (after each
       * tool result) and immediately after compaction finishes. Replaces the
       * stale snapshot in contextByThread without waiting for turnComplete.
       */
      type: z.literal(AgentEventType.ContextEstimate),
      threadId: z.string(),
      /** Estimated total tokens currently occupying the context window. */
      tokensIn: z.number(),
      /** Model context window size, forwarded from SDK when available. */
      contextWindow: z.number().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.QuotaUpdate),
      threadId: z.string(),
      providerId: z.string(),
      categories: z.array(QuotaCategorySchema()),
      sessionCostUsd: z.number().optional(),
      serviceTier: z.enum(["standard", "priority", "batch"]).optional(),
      numTurns: z.number().int().optional(),
      durationMs: z.number().optional(),
    }),
    z.object({
      /** Emitted when sendMessage is gated because the provider is disabled or its CLI is missing. */
      type: z.literal(AgentEventType.ProviderUnavailable),
      threadId: z.string(),
      providerId: z.enum(["claude", "codex", "gemini", "copilot", "cursor", "opencode"]),
      reason: z.enum(["disabled", "cli_missing"]),
      /**
       * Configured CLI path the server tried to resolve. Only populated when
       * `reason === "cli_missing"`; emitters must leave this undefined when
       * `reason === "disabled"`. The shape cannot be expressed with superRefine
       * because discriminatedUnion rejects ZodEffects wrappers — the server
       * enforces this at emission, and consumers can rely on the invariant.
       */
      configuredPath: z.string().optional(),
    }),
    z.object({
      /** Emitted when the provider is rate-limited or approaching its rate limit. */
      type: z.literal(AgentEventType.RateLimited),
      threadId: z.string(),
      /** Whether the rate limit is currently active (warning or rejected). False clears the indicator. */
      active: z.boolean(),
      /** Milliseconds until the rate limit resets. Computed from the SDK's absolute timestamp at emission time. */
      retryAfterMs: z.number().optional(),
      /** Provider-specific rate limit category (e.g. 'five_hour', 'seven_day'). */
      limitType: z.string().optional(),
      /** Utilization fraction (0-1) of the current rate limit window, if available. */
      utilization: z.number().optional(),
    }),
    z.object({
      /** Emitted when an API request fails with a retryable error and the provider will retry. */
      type: z.literal(AgentEventType.ApiRetry),
      threadId: z.string(),
      /** Human-readable reason for the retry (e.g. 'rate_limit', 'server_error'). */
      reason: z.string(),
      /** Current retry attempt number (1-based). */
      attempt: z.number().optional(),
      /** Maximum number of retries the provider will attempt. */
      maxRetries: z.number().optional(),
      /** Milliseconds until the next retry attempt. */
      delayMs: z.number().optional(),
      /** HTTP status code that triggered the retry, if available. Omitted for connection errors. */
      errorStatus: z.number().optional(),
    }),
  ]),
);
/** Union of all events emitted by an agent provider. */
export type AgentEvent = z.infer<ReturnType<typeof AgentEventSchema>>;
