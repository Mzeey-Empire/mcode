import { AgentEventType } from "@mcode/contracts";

/**
 * Provider event types that prove the provider has answered a turn. The first accepted event of one of these types marks
 * the turn's `providerStartedAt`, which ends the thread's startup spinner.
 *
 * Excluded on purpose:
 * - `turnStarted`: the server synthesizes it at dispatch, OpenCode emits it before the model replies, and Claude
 *   emits it on resumed turns, so it says nothing about the provider answering.
 * - `error` and `ended`: these mean the turn did not start; the terminal turn event fails or cancels the startup.
 * - `system`, `quotaUpdate`, `contextEstimate`, `mcpServerStartupStatus`, `providerUnavailable`, `modelFallback`:
 *   session noise a provider can emit before or without ever answering the prompt.
 * - `hookStarted`, `rateLimited`, `assistantMessageBoundary`: Claude emits all three before the model answers, and
 *   before a failure such as an unknown model. A `SessionStart` hook runs before the prompt is sent, the SDK
 *   reports rate-limit status on every request, and the mapper emits a boundary for any assistant text, including the
 *   synthetic message the SDK sends when the model is unknown.
 */
export const PROVIDER_FRAME_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  AgentEventType.Message,
  AgentEventType.TextDelta,
  AgentEventType.ToolUse,
  AgentEventType.ToolInputDelta,
  AgentEventType.ToolProgress,
  AgentEventType.ToolResult,
  AgentEventType.TurnComplete,
  AgentEventType.GeneratedAttachment,
  AgentEventType.Compacting,
  AgentEventType.ApiRetry,
]);
