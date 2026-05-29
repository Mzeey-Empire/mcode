import type { AgentEvent } from "../events/agent-event.js";
import type { InteractionMode } from "../models/enums.js";
import type { AttachmentMeta } from "../models/attachment.js";
import type { PermissionDecision, PermissionRequest } from "../models/permission.js";
import type { ContextWindowMode, ReasoningLevel } from "../models/settings.js";
import type { ProviderModelInfo } from "./models.js";
import type { ProviderUsageInfo } from "./usage.js";

/**
 * Identifier for a supported AI provider.
 * "opencode" remains catalog-only until a server adapter ships.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot" | "cursor" | "opencode";

/** How a provider's `resume` mechanism behaves when used to fork a session. */
export type SessionForkBehavior = "clean" | "mutating" | "unsupported";

/**
 * Per-Provider knobs that ride on a {@link TurnRequest}, keyed by {@link ProviderId}.
 * Generic call sites cannot reach into the wrong Provider's knobs because the
 * field type is selected by the request's `P` type parameter.
 */
export interface ProviderOptionsByProvider {
  /** Claude: context-window tier and the Haiku thinking toggle. */
  claude: { contextWindowMode?: ContextWindowMode; thinking?: boolean };
  /** Codex: request the OpenAI fast service tier. */
  codex: { fastMode?: boolean };
  /** Copilot: sub-agent name ("interactive" | "plan" | "autopilot" | custom YAML name). */
  copilot: { agent?: string };
  cursor: Record<string, never>;
  gemini: Record<string, never>;
  opencode: Record<string, never>;
}

/**
 * The per-Turn value object passed to {@link IAgentProvider.sendTurn}.
 * `P` selects the Provider-specific `providerOptions` shape.
 *
 * Top-level fields are generic per-Turn inputs and knobs the user may change
 * between Turns. Provider-specific knobs live only in `providerOptions`.
 */
export interface TurnRequest<P extends ProviderId = ProviderId> {
  /** SDK session name, currently `mcode-${threadId}`. */
  sessionId: string;
  /** Owning thread id. */
  threadId: string;
  /** User input text (already wire-wrapped by the orchestrator when needed). */
  message: string;
  attachments?: AttachmentMeta[];
  /** Working directory: the thread's effective worktree or workspace path. */
  cwd: string;
  model: string;
  /** Fallback model if the primary is unavailable. Undefined disables fallback. */
  fallbackModel?: string;
  permissionMode: string;
  /** Per-Turn interaction state. Plan suppresses Cursor's native auto-answer. */
  interactionMode: InteractionMode;
  reasoningLevel?: ReasoningLevel;
  /** USD budget cap for this Turn. Undefined or 0 disables. */
  maxBudgetUsd?: number;
  /** Max agent turns for this Turn. Undefined or 0 disables. */
  maxTurns?: number;
  /**
   * SDK session id to resume from. When defined the Provider resumes that
   * session; when undefined it starts fresh. Replaces the previous
   * `setSdkSessionId(...)` + `resume: true` two-step dance.
   */
  resumeFrom?: string;
  /** Provider-specific knobs, walled off by `P`. Required; empty-knob Providers pass `{}`. */
  providerOptions: ProviderOptionsByProvider[P];
}

/** A pluggable agent backend that can run sessions and emit events. */
export interface IAgentProvider {
  readonly id: ProviderId;

  /**
   * Whether this provider supports one-shot text completion (e.g. PR draft generation).
   * Use `isCompletionCapable()` to narrow to `ICompletionCapable` before calling `complete()`.
   */
  readonly supportsCompletion: boolean;

  /**
   * How the provider's `resume` mechanism behaves when used to fork a session
   * for side-channel queries (e.g. handoff generation):
   * - "clean": resuming creates a forked session; the original session is unaffected.
   * - "mutating": resuming mutates the original session's forward history.
   * - "unsupported": resuming is not supported or not yet verified.
   */
  readonly sessionForkOnResume: SessionForkBehavior;

  /**
   * Maximum input characters the provider accepts per turn, across all roles
   * (system + user content + tool results). `string.length` units, not tokens.
   * Tokens vary per model and are not portable.
   *
   * Used to size handoff documents so they fit inside the child provider's
   * first-turn budget.
   * Codex and Copilot use a conservative placeholder of 16_000 until verified.
   */
  readonly maxInputCharactersPerTurn: number;

  /**
   * Start or continue a Turn. The {@link TurnRequest} carries all per-Turn
   * input, knobs, the resume signal (`resumeFrom`), and Provider-specific
   * options (`providerOptions`). Replaces the former 15-parameter
   * `sendMessage` call.
   */
  sendTurn(req: TurnRequest): Promise<void>;

  /** Abort a running session. */
  stopSession(sessionId: string): void;

  /** Tear down all sessions and release resources. */
  shutdown(): void;

  /** List models available from this provider. */
  listModels(): Promise<ProviderModelInfo[]>;

  /** Return current usage/quota state for this provider. */
  getUsage?(): Promise<ProviderUsageInfo>;

  /**
   * Resolve a pending permission request.
   * Returns true if the requestId was found and resolved, false otherwise.
   */
  resolvePermission?(requestId: string, decision: PermissionDecision): boolean;

  /** Return all pending permission requests for a given thread. */
  listPendingPermissions?(threadId: string): PermissionRequest[];

  /**
   * Run a one-shot query against a forked copy of the parent's session.
   * Only providers with `sessionForkOnResume === "clean"` implement this.
   * The returned string is the assistant's final text output.
   *
   * Throws a provider-specific error on failure. The pipeline classifies via
   * classifyProviderError.
   */
  runSideChannelQuery?(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    /**
     * Conversation history as plain text (budgeted replay). When provided and
     * the session-resume call fails with a session-missing error, the provider
     * retries without `resume:` by baking this history into the prompt so the
     * caller still gets a path-B result rather than falling to path D.
     */
    conversationHistory?: string;
    /**
     * Working directory for the side-channel SDK call. Must be the parent
     * thread's effective worktree (worktree_path if set, otherwise the workspace
     * path). The provider sees the same filesystem state the parent had.
     */
    cwd: string;
  }): Promise<string>;

  /**
   * Run a hidden turn on the parent thread's session. Persists both the
   * request and the assistant reply with isInternal=1. Only providers with
   * `sessionForkOnResume === "mutating"` implement this. After the hidden
   * turn the implementation MUST send a second hidden turn instructing the
   * model to disregard the handoff request and continue normally.
   */
  runHiddenTurn?(args: {
    parentThreadId: string;
    prompt: string;
    abortSignal?: AbortSignal;
  }): Promise<string>;

  /** Subscribe to agent events. */
  on(event: "event", handler: (event: AgentEvent) => void): void;
  /** Subscribe to provider-level errors. */
  on(event: "error", handler: (error: Error) => void): void;
  /** Subscribe to permission request events (emitted when canUseTool fires). */
  on(event: "permission_request", handler: (request: PermissionRequest) => void): void;
  /** Subscribe to permission resolved events (emitted on session stop cancellation). */
  on(event: "permission_resolved", handler: (payload: { requestId: string; decision: PermissionDecision }) => void): void;
  /** Subscribe to ExitPlanMode capture events (Claude SDK plan output). */
  on(event: "exit_plan_mode", handler: (payload: { threadId: string; planMarkdown: string }) => void): void;
}

/**
 * Narrowed view of an agent provider that supports one-shot text completion.
 * Use `isCompletionCapable()` to narrow an `IAgentProvider` to this type.
 */
export interface ICompletionCapable extends IAgentProvider {
  readonly supportsCompletion: true;
  /** Run a one-shot prompt and return the raw text response. */
  complete(prompt: string, model: string, cwd: string): Promise<string>;
}

/**
 * Type guard: returns true when the provider implements one-shot text completion.
 * Narrows `IAgentProvider` to `ICompletionCapable` so `complete()` is callable without casting.
 */
export function isCompletionCapable(provider: IAgentProvider): provider is ICompletionCapable {
  return provider.supportsCompletion === true && typeof (provider as ICompletionCapable).complete === "function";
}

/** Registry that resolves provider instances by ID. */
export interface IProviderRegistry {
  /** Get a single provider by ID. Throws if not registered. */
  resolve(id: ProviderId): IAgentProvider;

  /** Get all registered providers. */
  resolveAll(): IAgentProvider[];

  /** Shut down all providers. */
  shutdown(): void;
}
