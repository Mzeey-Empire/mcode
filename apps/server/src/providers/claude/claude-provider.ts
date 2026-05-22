/**
 * Claude Agent SDK provider adapter.
 * Implements IAgentProvider using the v1 query() API with a prompt queue pattern.
 * Migrated from apps/desktop/src/main/sidecar/client.ts.
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage, PostCompactHookInput, StopHookInput, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { AgentEventType, isVirtualBrowserContextAttachment } from "@mcode/contracts";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  ContextWindowMode,
  AgentEvent,
  AttachmentMeta,
  ProviderModelInfo,
  ProviderUsageInfo,
  QuotaCategory,
  PermissionDecision,
  PermissionRequest,
} from "@mcode/contracts";
import { buildReasoningOptions } from "./build-reasoning-options.js";
import { listClaudeModels } from "./list-models.js";
import { applyUltrathinkPrefix, resolveSdkModelSlug } from "./resolve-slug.js";
import { readAnthropicOauthToken } from "@mcode/shared/usage";
import { AnthropicOAuthUsageSource } from "./usage/oauth-usage-source.js";
import { AnthropicHeaderUsageSource } from "./usage/header-usage-source.js";
import { CompositeUsageSource } from "./usage/composite-usage-source.js";
import { EnvService } from "../../services/env-service.js";
import { JobObject } from "../../services/job-object.js";
import { listDirectChildren } from "../../services/process-kill.js";

/** Shallow snapshot of `process.env` for temporary Claude SDK subprocess alignment. */
function snapshotProcessEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/** Restores `process.env` after {@link snapshotProcessEnv}. */
function restoreProcessEnv(backup: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in backup)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;
/** Max queued messages before push() warns and drops. */
const MAX_QUEUE_DEPTH = 20;

interface SessionEntry {
  query: Query;
  pushMessage: (msg: SDKUserMessage) => void;
  closeQueue: () => void;
  model: string;
  /**
   * Permission mode the SDK subprocess was spawned with ("full" or "supervised").
   * Compared against incoming requests; when it differs, the subprocess is torn
   * down and a new one is spawned with the new mode because permissionMode is
   * fixed at spawn in the Claude Agent SDK CLI.
   */
  permissionMode: string;
  /**
   * Context window mode the SDK subprocess was spawned with. The 1M window is
   * encoded into the model slug (`<id>[1m]`), so changing this between turns
   * requires a fresh subprocess — the same teardown-and-respawn pattern used
   * for permissionMode.
   */
  contextWindowMode: ContextWindowMode | undefined;
  lastUsedAt: number;
  /** When true, the finally block in startStreamLoop should not emit an "ended" event. */
  suppressEnded?: boolean;
  /** Tool-use IDs whose matching tool_result has not yet been received.
   *  While this set is non-empty, evictIdleSessions() must skip the session
   *  regardless of how long it has been since an SDK message arrived. */
  pendingToolUses: Set<string>;
  /**
   * True once the first tool call for this sendMessage query has been registered.
   * Distinguishes pre-tool preamble text (pendingToolUses=0, no tool fired yet)
   * from post-tool assistant text. Intentionally survives SDK `result` events
   * because the Claude SDK can emit `result` between internal rounds while the
   * same user turn continues.
   */
  hasFiredToolThisTurn: boolean;
}

/**
 * Create an async iterable prompt queue backed by a simple push/pull bridge.
 * Messages pushed via `push()` are yielded by the iterable. Calling `close()`
 * terminates the iterator, signaling the SDK to shut down the subprocess.
 */
export function createPromptQueue(): {
  push: (msg: SDKUserMessage) => void;
  close: () => void;
  iterable: AsyncIterable<SDKUserMessage>;
} {
  const pending: SDKUserMessage[] = [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  let done = false;

  const push = (msg: SDKUserMessage): void => {
    if (done) {
      throw new Error(
        "Prompt queue is closed; message cannot be delivered to the SDK",
      );
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: msg, done: false });
    } else {
      if (pending.length >= MAX_QUEUE_DEPTH) {
        throw new Error(
          `Prompt queue full (depth=${pending.length}), cannot enqueue message`,
        );
      }
      pending.push(msg);
    }
  };

  const close = (): void => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({
        value: undefined as unknown as SDKUserMessage,
        done: true,
      });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (pending.length > 0) {
            return Promise.resolve({
              value: pending.shift()!,
              done: false,
            });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as SDKUserMessage,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };

  return { push, close, iterable };
}

/** Convert a plain string message into an SDKUserMessage. */
function toUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: text,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Checks whether the SDK used a different model than the one requested.
 * Returns the actual model ID if a fallback fired, or null if the requested
 * model ran as expected.
 *
 * @param modelUsage - `SDKResultSuccess.modelUsage` record (keys are model IDs)
 * @param requestedModel - the model ID that was passed to the SDK
 */
export function detectFallbackModel(
  modelUsage: Record<string, unknown>,
  requestedModel: string,
): string | null {
  const usedModels = Object.keys(modelUsage);
  // SDK resolves aliases to dated snapshot IDs (e.g. "claude-sonnet-4-6" → "claude-sonnet-4-6-20250514").
  // Only treat a key as the same model when the suffix after the hyphen is exactly 8 digits (YYYYMMDD),
  // preventing sibling families like "claude-opus-4-6-*" from matching a request for "claude-opus-4".
  const datedSnapshotSuffix = /^\d{8}$/;
  const requestedModelRan = usedModels.some(
    (m) =>
      m === requestedModel ||
      (m.startsWith(requestedModel + "-") &&
        datedSnapshotSuffix.test(m.slice(requestedModel.length + 1))),
  );
  // Only report a fallback when the requested model is completely absent from usage.
  // The SDK may report multiple models (e.g. primary + tool-routing model) in a single
  // turn; that is NOT a fallback as long as the requested model was used.
  if (requestedModelRan) return null;

  return usedModels[0] ?? null;
}

/** Claude Agent SDK adapter implementing IAgentProvider with prompt queue pattern. */
@injectable()
export class ClaudeProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "claude";
  /** Claude supports one-shot text completion via sdkQuery with maxTurns: 1. */
  readonly supportsCompletion = true;

  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  /**
   * Active goals keyed by sessionId (mcode-${threadId}). When set, the SDK
   * Stop hook installed in baseOptions blocks the agent from ending its turn
   * with a "Goal not yet met" message until the goal is cleared. Set by the
   * `/goal <condition>` chat command (intercepted in AgentService) and
   * cleared by `/goal clear`. In-memory only — does not persist across
   * server restarts.
   */
  private goalsBySession = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked by doSendMessage after session creation; if found the session is
   * torn down immediately so the agent never starts.
   */
  private pendingStops = new Set<string>();
  /** Threads currently in plan-answer mode. ExitPlanMode is only captured for these. */
  private planAnswerThreads = new Set<string>();
  /** Pending permission requests awaiting user decision, keyed by requestId. */
  private pendingPermissions = new Map<
    string,
    {
      threadId: string;
      toolName: string;
      input: unknown;
      title?: string;
      resolve: (decision: PermissionDecision) => void;
    }
  >();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private lastSessionCostUsd?: number;
  private lastServiceTier?: "standard" | "priority" | "batch";
  private lastNumTurns?: number;
  private lastDurationMs?: number;
  private readonly usageSource: CompositeUsageSource = new CompositeUsageSource([
    new AnthropicOAuthUsageSource(readAnthropicOauthToken),
    new AnthropicHeaderUsageSource(),
  ]);

  constructor(
    @inject(EnvService) private readonly envService: EnvService,
    @inject("JobObject") private readonly jobObject: JobObject,
  ) {
    super();
  }

  /**
   * Merges {@link EnvService.getEnv} into `process.env` for the Claude SDK spawn window
   * only, then restores the previous environment.
   */
  private withSdkSpawnEnv<T>(fn: () => T): T {
    const backup = snapshotProcessEnv();
    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }
      return fn();
    } finally {
      restoreProcessEnv(backup);
    }
  }

  /** Start or continue a session by sending a message via the SDK. */
  async sendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
    contextWindowMode?: ContextWindowMode;
    thinking?: boolean;
    maxBudgetUsd?: number;
    maxTurns?: number;
  }): Promise<void> {
    try {
      await this.doSendMessage(params);
    } catch (e: unknown) {
      logger.error("sendMessage error", {
        sessionId: params.sessionId,
        error: String(e),
      });
      throw e;
    }
  }

  /**
   * One-shot text completion using the same prompt queue pattern as chat.
   * Spawns an ephemeral SDK subprocess (not persisted to disk) with tools
   * disabled and maxTurns: 1, collects the response text, then tears down.
   */
  async complete(prompt: string, model: string, cwd: string): Promise<string> {
    const backup = snapshotProcessEnv();
    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }

      const queue = createPromptQueue();
      const ephemeralId = `complete-${crypto.randomUUID()}`;

      // Note: the Claude Agent SDK spawns a 'claude' CLI subprocess internally.
      // That subprocess PID is not exposed by the SDK, so it cannot be added to
      // the server's Job Object. On server crash, this subprocess may briefly
      // outlive the server until the OS job-object kill propagates via inheritance.
      // Track: expose subprocess PID from claude-agent-sdk for explicit assignment.
      const q = sdkQuery({
        prompt: queue.iterable,
        options: {
          cwd,
          model,
          maxTurns: 1,
          tools: [],
          systemPrompt: "Respond with exactly what is requested. No questions, no commentary.",
          settingSources: [],
          permissionMode: "default" as const,
          persistSession: false,
          includePartialMessages: true,
        },
      });

      queue.push(toUserMessage(prompt, ephemeralId));
      // Close immediately: the message is already queued. This signals end-of-input
      // so the SDK subprocess exits after processing instead of blocking on the
      // next read from the queue (which would deadlock the for-await loop below).
      queue.close();

      let resultText = "";
      let assistantText = "";
      let deltaText = "";

      for await (const msg of q) {
        const anyMsg = msg as Record<string, unknown>;

        if (anyMsg.type === "result") {
          if (anyMsg.is_error) {
            const errors = (anyMsg.errors as string[]) ?? [];
            throw new Error(`Claude SDK error: ${errors.join(", ") || "unknown error"}`);
          }
          const res = anyMsg.result;
          if (typeof res === "string" && res) resultText = res;
        }

        if (anyMsg.type === "assistant") {
          const content =
            (anyMsg.message as { content?: Array<{ type: string; text?: string }> })
              ?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) assistantText += block.text;
          }
        }

        // Collect incremental text deltas as a third fallback source
        if (anyMsg.type === "stream_event") {
          const streamEvent = anyMsg.event as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (
            streamEvent?.type === "content_block_delta" &&
            streamEvent.delta?.type === "text_delta" &&
            streamEvent.delta.text
          ) {
            deltaText += streamEvent.delta.text;
          }
        }
      }

      const text = resultText || assistantText || deltaText;
      if (!text) throw new Error("Claude SDK returned no text content");
      return text.trim();
    } finally {
      restoreProcessEnv(backup);
    }
  }

  private async doSendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
    contextWindowMode?: ContextWindowMode;
    thinking?: boolean;
    maxBudgetUsd?: number;
    maxTurns?: number;
  }): Promise<void> {
    const {
      sessionId,
      message,
      cwd,
      model,
      fallbackModel,
      resume,
      permissionMode,
      attachments,
      reasoningLevel,
      contextWindowMode,
      thinking,
    } = params;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const existing = this.sessions.get(sessionId);
    const isBypass = permissionMode === "full";
    const sdkPermissionMode = isBypass
      ? ("bypassPermissions" as const)
      : ("default" as const);
    const uuid = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    const tid = uuid;
    const resolvedCwd = cwd || process.cwd();
    const resolvedModel = model || "claude-sonnet-4-6";
    // The "[1m]" suffix is appended only when the user opted into the 1M context
    // window AND the model supports it. The SDK translates it into the
    // `context-1m-2025-08-07` beta header.
    const sdkModelSlug = resolveSdkModelSlug(resolvedModel, contextWindowMode);

    // Ultrathink prepends "Ultrathink:\n" to the user prompt for models that
    // support it. The matching `effort: "max"` is emitted by buildReasoningOptions.
    const finalMessage = applyUltrathinkPrefix(message, reasoningLevel, resolvedModel);

    const prompt =
      attachments && attachments.length > 0
        ? await this.buildMultimodalMessage(finalMessage, attachments, sessionId)
        : toUserMessage(finalMessage, sessionId);

    if (existing) {
      // Permission mode is fixed at SDK subprocess spawn. setPermissionMode()
      // cannot enter bypassPermissions without the --dangerously-skip-permissions
      // flag at spawn time (mutually exclusive with canUseTool), so we match
      // the codex provider's teardown-and-respawn pattern here. The new session
      // resumes the same conversation via the persisted sdkSessionIds entry.
      if (existing.permissionMode !== permissionMode) {
        logger.info("permissionMode changed, recreating session", {
          sessionId,
          from: existing.permissionMode,
          to: permissionMode,
        });
        existing.suppressEnded = true;
        existing.closeQueue();
        existing.query.close();
        this.sessions.delete(sessionId);
        return this.doSendMessage(params);
      }

      // Context window mode is part of the model slug at spawn time, so the SDK
      // subprocess must be torn down and respawned when the user toggles 200k/1M.
      // setModel() can change the model ID but cannot toggle the [1m] suffix beta
      // header, which is only attached at session creation.
      if (existing.contextWindowMode !== contextWindowMode) {
        logger.info("contextWindowMode changed, recreating session", {
          sessionId,
          from: existing.contextWindowMode,
          to: contextWindowMode,
        });
        existing.suppressEnded = true;
        existing.closeQueue();
        existing.query.close();
        this.sessions.delete(sessionId);
        return this.doSendMessage(params);
      }

      existing.lastUsedAt = Date.now();

      if (existing.model !== resolvedModel) {
        logger.info("Model changed, calling setModel()", {
          sessionId,
          model: sdkModelSlug,
        });
        try {
          // Always pass the slug (with optional [1m] suffix) to the SDK; the
          // entry stores the bare model ID so fallback detection compares
          // against the base name the SDK reports in modelUsage.
          await existing.query.setModel(sdkModelSlug);
          existing.model = resolvedModel;
        } catch (err) {
          logger.error(
            "setModel() failed, closing session for recreation",
            {
              sessionId,
              error:
                err instanceof Error ? err.message : String(err),
            },
          );
          existing.suppressEnded = true;
          existing.closeQueue();
          existing.query.close();
          this.sessions.delete(sessionId);
          return this.doSendMessage({ ...params, resume: false });
        }
      }

      try {
        existing.pushMessage(prompt);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        // push() throws two distinct errors: "Prompt queue is closed" (race
        // with idle eviction / stopSession()) and "Prompt queue full" (caller
        // is pushing faster than the SDK can drain). Only the closed case
        // means the session is gone; overflow leaves the session healthy.
        const isClosed = errorMessage.includes("queue is closed");
        if (isClosed) {
          logger.error("Prompt queue push failed on existing session", {
            sessionId,
            error: errorMessage,
          });
          this.emit("event", {
            type: AgentEventType.Error,
            threadId: tid,
            error: "Message could not be delivered: session was shutting down. Please try again.",
          } satisfies AgentEvent);
          // Drop the stale entry so the next send creates a fresh session.
          // Safe to delete here even if startStreamLoop is mid-iteration: its
          // finally block guards with `current?.query === q` before re-deleting,
          // so a second delete is a no-op and the terminal Ended event still
          // fires via the `(!current || current.query === q)` condition.
          this.sessions.delete(sessionId);
        } else {
          // Transient overflow: surface via Error event but keep the session.
          logger.warn("Prompt queue full on existing session", {
            sessionId,
            error: errorMessage,
          });
          this.emit("event", {
            type: AgentEventType.Error,
            threadId: tid,
            error: errorMessage,
          } satisfies AgentEvent);
        }
        throw err;
      }
      return;
    }

    const resumeId = this.sdkSessionIds.get(sessionId) ?? uuid;

    const baseOptions = {
      cwd: resolvedCwd,
      // sdkModelSlug appends "[1m]" when the user opted into the 1M context window
      // and the model supports it. Plain `resolvedModel` is preserved on the
      // session entry as well so the existing-session branch can detect changes.
      model: sdkModelSlug,
      settingSources: [
        "user" as const,
        "project" as const,
        "local" as const,
      ],
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      tools: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      // EnterPlanMode is disallowed because Mcode controls plan entry.
      // ExitPlanMode is NOT disallowed: we intercept it in canUseTool.
      // In plan-answer mode we capture the plan; in normal mode we deny
      // it silently so the model doesn't get stuck.
      // AskUserQuestion is disallowed: no result handler here.
      disallowedTools: ["EnterPlanMode", "AskUserQuestion"],
      permissionMode: sdkPermissionMode,
      canUseTool: (async (
        toolName: string,
        input: Record<string, unknown>,
        options: Parameters<CanUseTool>[2],
      ) => {
        try {
          // ExitPlanMode: only capture the plan when the thread is in
          // plan-answer mode. In normal chat, deny silently so the model
          // doesn't get stuck calling a tool with no handler.
          if (toolName === "ExitPlanMode") {
            if (this.planAnswerThreads.has(tid)) {
              const planMd = typeof input?.plan === "string" ? input.plan.trim() : "";
              if (planMd.length > 0) {
                this.planAnswerThreads.delete(tid);
                this.emit("exit_plan_mode", {
                  threadId: tid,
                  planMarkdown: planMd,
                });
              }
              return {
                behavior: "deny" as const,
                message:
                  "The client captured your proposed plan. Stop here and wait for the user to review it.",
              };
            }
            // Not in plan mode - deny without capturing
            return {
              behavior: "deny" as const,
              message: "Plan mode is not active. Continue with the user's request normally.",
            };
          }

          const requestId = crypto.randomUUID();
          logger.debug("canUseTool called", { toolName, requestId, threadId: tid });
          const decision = await new Promise<PermissionDecision>((resolve) => {
            this.pendingPermissions.set(requestId, {
              threadId: tid,
              toolName,
              input,
              title: options?.title,
              resolve,
            });
            this.emit("permission_request", {
              requestId,
              threadId: tid,
              toolName,
              input,
              title: options?.title,
            } satisfies PermissionRequest);

            // Auto-cancel if the SDK aborts the tool call (e.g. timeout).
            if (options?.signal) {
              const onAbort = () => {
                if (this.pendingPermissions.delete(requestId)) {
                  resolve("cancelled");
                  this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
                }
              };
              options.signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          logger.debug("canUseTool decision", { toolName, requestId, decision });
          let result;
          switch (decision) {
            case "allow":
              // updatedInput is required by the CLI's runtime Zod schema (not optional
              // despite the SDK TypeScript type). Pass the original input unchanged.
              result = {
                behavior: "allow" as const,
                updatedInput: input,
              };
              break;
            case "allow-session":
              // Use the SDK-provided suggestions. They encode the correct
              // PermissionUpdate shape for the specific tool being allowed.
              result = {
                behavior: "allow" as const,
                updatedInput: input,
                updatedPermissions: options?.suggestions,
              };
              break;
            case "deny":
            case "cancelled":
              result = {
                behavior: "deny" as const,
                message: decision === "cancelled"
                  ? "Session stopped by user"
                  : "User denied",
              };
              break;
            default:
              logger.error("canUseTool received unexpected decision", { toolName, requestId, decision });
              result = {
                behavior: "deny" as const,
                message: "Unexpected permission decision value",
              };
          }
          logger.debug("canUseTool returning", { toolName, requestId, behavior: result.behavior });
          return result;
        } catch (err) {
          logger.error("canUseTool callback threw unexpectedly", { toolName, err });
          return {
            behavior: "deny" as const,
            message: "Permission check encountered an internal error",
          };
        }
      }) satisfies CanUseTool,
      ...buildReasoningOptions(reasoningLevel, resolvedModel, thinking),
      ...(fallbackModel && { fallbackModel }),
      includePartialMessages: true,
      // Guardrails are fixed at session creation. If the user changes the
      // setting between turns while the session is still live in memory, the
      // original values remain in effect until the session is evicted or the
      // server restarts.
      ...(params.maxBudgetUsd != null && params.maxBudgetUsd > 0 && { maxBudgetUsd: params.maxBudgetUsd }),
      ...(params.maxTurns != null && params.maxTurns > 0 && { maxTurns: params.maxTurns }),
      hooks: {
        PostCompact: [{
          // @ts-expect-error: HookCallback accepts 3 params but we only need input
          hooks: [async (input) => {
            const { compact_summary } = (input as PostCompactHookInput);
            // Derive threadId the same way startStreamLoop does.
            const tid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
            this.emit("event", {
              type: AgentEventType.CompactSummary,
              threadId: tid,
              summary: compact_summary,
            } satisfies AgentEvent);
            return {};
          }],
        }],
        Stop: [{
          // @ts-expect-error: HookCallback accepts 3 params but we only need input
          hooks: [async (input) => {
            const stopInput = input as StopHookInput;
            const goal = this.goalsBySession.get(sessionId);
            // No goal set or hook is already re-prompting → allow stop. The
            // `stop_hook_active` guard prevents an infinite block loop when the
            // model insists on stopping after the first re-prompt.
            if (!goal || stopInput.stop_hook_active) {
              return {};
            }
            return {
              decision: "block" as const,
              reason:
                `Goal not yet met: "${goal}". Continue working until the goal is satisfied. ` +
                `If you have satisfied it, ask the user to clear it with "/goal clear".`,
            };
          }],
        }],
      },
    };
    const options = resume
      ? { ...baseOptions, resume: resumeId }
      : { ...baseOptions, sessionId: uuid };

    const queue = createPromptQueue();

    logger.info("Starting query()", {
      sessionId,
      resume,
      resumeId,
      model: resolvedModel,
      cwd: resolvedCwd,
    });

    let beforePids: Set<number> | undefined;
    if (this.jobObject.isWindowsJob) {
      try {
        const children = await listDirectChildren(process.pid);
        beforePids = new Set(children.map((c) => c.pid));
      } catch {
        // Best-effort
      }
    }

    const q = this.withSdkSpawnEnv(() => sdkQuery({ prompt: queue.iterable, options }));

    if (beforePids) {
      void this.labelSdkSubprocess(beforePids);
    }

    const entry: SessionEntry = {
      query: q,
      pushMessage: queue.push,
      closeQueue: queue.close,
      // Store the bare model ID; the [1m] suffix is only attached at the SDK
      // boundary so detectFallbackModel can compare against the dated snapshot
      // IDs the SDK reports in modelUsage.
      model: resolvedModel,
      permissionMode,
      contextWindowMode,
      lastUsedAt: Date.now(),
      pendingToolUses: new Set<string>(),
      hasFiredToolThisTurn: false,
    };
    this.sessions.set(sessionId, entry);

    // A stop was requested while sendMessage was still in flight (race
    // between concurrent agent.send and agent.stop RPCs). Tear down
    // immediately so the agent never starts.
    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new session", {
        sessionId,
      });
      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
      // TurnStarted was already emitted by AgentService before calling the
      // provider, so the frontend thinks the agent is running. Emit Ended
      // to clear that state.
      this.emit("event", {
        type: AgentEventType.Ended,
        threadId: tid,
      } satisfies AgentEvent);
      return;
    }

    if (resume) {
      const failedEvent = `_resumeFailed:${sessionId}`;
      const doneEvent = `_streamDone:${sessionId}`;

      let resumeHandler: (() => void) | null = null;
      let doneHandler: (() => void) | null = null;

      const retryPromise = new Promise<boolean>((resolve) => {
        resumeHandler = () => resolve(true);
        doneHandler = () => resolve(false);
        this.once(failedEvent, resumeHandler);
        this.once(doneEvent, doneHandler);
      });

      this.startStreamLoop(sessionId, q);
      queue.push(prompt);

      let needsRetry: boolean;
      try {
        needsRetry = await retryPromise;
      } finally {
        // Guarantee both listeners are removed regardless of how the
        // promise settled (resolve, reject, or upstream cancellation).
        if (resumeHandler) this.removeListener(failedEvent, resumeHandler);
        if (doneHandler) this.removeListener(doneEvent, doneHandler);
      }

      if (needsRetry) {
        logger.info("Resume failed, falling back to fresh query()", {
          sessionId,
        });
        this.sdkSessionIds.delete(sessionId);

        const freshQueue = createPromptQueue();
        const freshOptions = { ...baseOptions, sessionId: uuid };

        let freshBeforePids: Set<number> | undefined;
        if (this.jobObject.isWindowsJob) {
          try {
            const children = await listDirectChildren(process.pid);
            freshBeforePids = new Set(children.map((c) => c.pid));
          } catch {
            // Best-effort
          }
        }

        const freshQ = this.withSdkSpawnEnv(() =>
          sdkQuery({
            prompt: freshQueue.iterable,
            options: freshOptions,
          }),
        );

        if (freshBeforePids) {
          void this.labelSdkSubprocess(freshBeforePids);
        }
        const freshEntry: SessionEntry = {
          query: freshQ,
          pushMessage: freshQueue.push,
          closeQueue: freshQueue.close,
          model: resolvedModel,
          permissionMode,
          contextWindowMode,
          lastUsedAt: Date.now(),
          pendingToolUses: new Set<string>(),
          hasFiredToolThisTurn: false,
        };
        this.sessions.set(sessionId, freshEntry);

        if (this.pendingStops.delete(sessionId)) {
          logger.info("Pending stop consumed on resume fallback", {
            sessionId,
          });
          this.sessions.delete(sessionId);
          freshEntry.closeQueue();
          freshEntry.query.close();
          this.emit("event", {
            type: AgentEventType.Ended,
            threadId: tid,
          } satisfies AgentEvent);
          return;
        }

        this.startStreamLoop(sessionId, freshQ);
        freshQueue.push(prompt);
      }
    } else {
      this.startStreamLoop(sessionId, q);
      queue.push(prompt);
    }
  }

  /** Run the stream loop for a query, mapping SDK events to AgentEvent types. */
  private startStreamLoop(sessionId: string, q: Query): void {
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    (async () => {
      let suppressEnded = false;
      try {
        let lastAssistantText = "";
        let sessionInitialized = false;
        /** Tracks whether the SDK has signalled compaction is active for this stream. */
        let sessionCompacting = false;
        /** Tracks the last known context window size for post-compaction estimation. */
        let lastContextWindow: number | undefined = undefined;
        /** Per-API-call input token count from the most recent stream_event message_start.
         * Consumed by the result handler to use as tokensIn on turnComplete (authoritative
         * context fill vs. the accumulated result.usage which inflates across API calls).
         * Reset to undefined after each turnComplete. */
        let lastStreamInputTokens: number | undefined = undefined;
        /** Set after a `result` (TurnComplete). When the SDK auto-resumes
         *  (e.g. ScheduleWakeup/loop), the next non-system/non-result event
         *  triggers a synthetic TurnStarted so the server and UI know a new
         *  turn has begun without going through sendMessage(). */
        let awaitingResume = false;

        /** Suppresses duplicate ToolUse events when the SDK emits the same id on assistant blocks and tool_use messages. */
        const emittedToolUseIds = new Set<string>();

        /**
         * Emit an Error event with a best-effort message extracted from an SDK
         * result payload. The full raw payload is logged so operators can see
         * every field the SDK sent, while the Error event stays compatible with
         * the string-shaped `error` field on AgentEvent.
         */
        const emitResultError = (anyMsg: Record<string, unknown>): void => {
          const errors = (anyMsg.errors as string[] | undefined) ?? [];
          let errorMessage: string;
          if (errors.length > 0) {
            errorMessage = errors.join(", ");
          } else if (typeof anyMsg.result === "string") {
            errorMessage = anyMsg.result;
          } else {
            try {
              errorMessage = JSON.stringify(anyMsg.result ?? anyMsg);
            } catch {
              errorMessage = "Claude SDK returned an error result";
            }
          }
          logger.error("Claude SDK result error", {
            sessionId,
            threadId,
            errors,
            subtype: anyMsg.subtype,
            payload: anyMsg,
          });
          this.emit("event", {
            type: AgentEventType.Error,
            threadId,
            error: errorMessage || "Claude SDK returned an error result",
          } satisfies AgentEvent);
        };

        for await (const msg of q) {
          const entry = this.sessions.get(sessionId);
          if (entry) entry.lastUsedAt = Date.now();

          const anyMsg = msg as Record<string, unknown>;

          if (!sessionInitialized && anyMsg.type !== "result") {
            sessionInitialized = true;
          }

          // Capture SDK session ID
          const sdkSid = anyMsg.session_id as string | undefined;
          if (
            sdkSid &&
            sessionInitialized &&
            !this.sdkSessionIds.has(sessionId)
          ) {
            this.sdkSessionIds.set(sessionId, sdkSid);
            logger.info("Captured SDK session ID", {
              sessionId,
              sdkSessionId: sdkSid,
            });
            this.emit("event", {
              type: AgentEventType.System,
              threadId,
              subtype: "sdk_session_id:" + sdkSid,
            } satisfies AgentEvent);
          }

          // Auto-resume detection: the SDK can start a new turn without
          // going through sendMessage() (e.g. ScheduleWakeup/loop timer).
          // Emit a synthetic TurnStarted so AgentService re-adds to
          // activeSessionIds and the frontend shows the running indicator.
          if (awaitingResume && anyMsg.type !== "result" && anyMsg.type !== "system") {
            awaitingResume = false;
            this.emit("event", {
              type: AgentEventType.TurnStarted,
              threadId,
            } satisfies AgentEvent);
          }

          // Detect failed resume
          if (
            anyMsg.type === "result" &&
            anyMsg.is_error === true &&
            !sessionInitialized
          ) {
            const errors = anyMsg.errors as string[] | undefined;
            const isNoConversation = errors?.some(
              (e) =>
                typeof e === "string" &&
                e.includes("No conversation found"),
            );
            if (isNoConversation) {
              logger.warn(
                "Resume failed: conversation not found, will retry with fresh query()",
                { sessionId },
              );
              this.sdkSessionIds.delete(sessionId);
              this.emit("event", {
                type: AgentEventType.System,
                threadId,
                subtype: "session_restarted",
              } satisfies AgentEvent);
              this.emit(`_resumeFailed:${sessionId}`);
              suppressEnded = true;
              return;
            }
          }

          switch (anyMsg.type) {
            case "assistant": {
              const innerMessage = anyMsg.message as {
                content?: Array<Record<string, unknown>>;
                stop_reason?: string | null;
              } | undefined;
              const contentBlocks = innerMessage?.content ?? [];
              const text = contentBlocks
                .filter((b) => b.type === "text")
                .map((b) => (b.text as string) ?? "")
                .join("");

              if (text && text !== lastAssistantText) {
                lastAssistantText = text;
              }

              // Anthropic message-level stop_reason is the authoritative
              // discriminator between thoughts and final response text.
              // {end_turn, stop_sequence, max_tokens} → final response
              // {tool_use, pause_turn, null, anything else} → preamble/thought
              // Only emit a boundary when this message actually carried text;
              // pure tool-call messages have no streamed deltas to reclassify.
              if (text.length > 0) {
                const stopReason = innerMessage?.stop_reason ?? null;
                const isFinalResponse =
                  stopReason === "end_turn" ||
                  stopReason === "stop_sequence" ||
                  stopReason === "max_tokens";
                this.emit("event", {
                  type: AgentEventType.AssistantMessageBoundary,
                  threadId,
                  isFinalResponse,
                } satisfies AgentEvent);
              }

              // Read parent_tool_use_id from the SDK message top-level.
              // When subagents run in parallel, this is the ONLY reliable way
              // to determine which Agent owns a given child tool call - the
              // server-side agentCallStack approach fails for parallel dispatch
              // because LIFO returns only the most recent Agent.
              // Treat empty string the same as null/undefined: an empty parent id
              // would otherwise be stored as a truthy value and break nesting
              // (build-narrative.ts groups by parentToolCallId, and "" never matches
              // an Agent id, so children get silently dropped from the tree).
              const sdkParentRaw = anyMsg.parent_tool_use_id as string | null | undefined;
              const sdkParentToolUseId =
                typeof sdkParentRaw === "string" && sdkParentRaw.length > 0
                  ? sdkParentRaw
                  : undefined;

              for (const block of contentBlocks) {
                if (block.type === "tool_use") {
                  const toolId = (block.id as string) || "";
                  if (toolId && emittedToolUseIds.has(toolId)) {
                    continue;
                  }
                  if (toolId) {
                    emittedToolUseIds.add(toolId);
                    const entry = this.sessions.get(sessionId);
                    if (entry) {
                      entry.pendingToolUses.add(toolId);
                      entry.hasFiredToolThisTurn = true;
                    }
                  }
                  const toolName = (block.name as string) || "unknown";
                  logger.debug("Claude ToolUse from assistant block", {
                    toolId, toolName, parent_tool_use_id: sdkParentToolUseId ?? null,
                  });
                  this.emit("event", {
                    type: AgentEventType.ToolUse,
                    threadId,
                    toolCallId: toolId,
                    toolName,
                    toolInput:
                      (block.input as Record<
                        string,
                        unknown
                      >) || {},
                    parentToolCallId: sdkParentToolUseId,
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "result": {
              if (anyMsg.is_error === true) {
                // The "No conversation found" resume-recovery branch above
                // handles its own flow and returns early; any other is_error
                // result lands here and must be surfaced as an Error event
                // rather than silently completing the turn.
                emitResultError(anyMsg);
                lastAssistantText = "";
                lastStreamInputTokens = undefined;
                awaitingResume = false;
                break;
              }
              if (lastAssistantText) {
                this.emit("event", {
                  type: AgentEventType.Message,
                  threadId,
                  content: lastAssistantText,
                  tokens:
                    (
                      anyMsg.usage as {
                        output_tokens?: number;
                      }
                    )?.output_tokens ?? null,
                } satisfies AgentEvent);
              }

              // Detect if the SDK used a fallback model. Guard on entry?.model
              // to avoid a spurious event if the session was evicted mid-stream.
              const requestedModel = entry?.model;
              if (requestedModel) {
                const usedFallback = detectFallbackModel(
                  (anyMsg.modelUsage as Record<string, unknown>) ?? {},
                  requestedModel,
                );
                if (usedFallback) {
                  this.emit("event", {
                    type: AgentEventType.ModelFallback,
                    threadId,
                    requestedModel,
                    actualModel: usedFallback,
                  } satisfies AgentEvent);
                }
              }

              // Extract the authoritative context window from SDK modelUsage.
              // modelUsage is Record<modelId, { contextWindow?: number, ... }>.
              const sdkModelUsage = (anyMsg.modelUsage ?? {}) as Record<
                string,
                { contextWindow?: number }
              >;
              const sdkContextWindow = Object.values(sdkModelUsage).find(
                (u) => typeof u.contextWindow === "number",
              )?.contextWindow;

              const usage = (anyMsg.usage ?? {}) as {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };

              // Accumulated total tokens processed across all API calls this session.
              // result.usage is accumulated (like total_cost_usd and num_turns),
              // so this already includes all previous API calls in the turn.
              const totalProcessedTokens =
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.output_tokens ?? 0);

              // Current context fill: prefer the last stream_event message_start
              // usage (per-API-call, authoritative). Fall back to a heuristic
              // from result.usage only if stream events were not captured.
              const tokensIn = lastStreamInputTokens ?? (
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0)
              );

              this.lastSessionCostUsd = (anyMsg.total_cost_usd as number) ?? undefined;
              this.lastNumTurns = (anyMsg.num_turns as number) ?? undefined;
              this.lastDurationMs = (anyMsg.duration_ms as number) ?? undefined;
              const resultUsage = (anyMsg.usage ?? {}) as { service_tier?: string };
              const rawTier = resultUsage.service_tier;
              this.lastServiceTier = (rawTier === "standard" || rawTier === "priority" || rawTier === "batch")
                ? rawTier
                : undefined;

              this.emit("event", {
                type: AgentEventType.TurnComplete,
                threadId,
                reason:
                  (anyMsg.stop_reason as string) ||
                  (anyMsg.subtype as string) ||
                  "end_turn",
                costUsd:
                  (anyMsg.total_cost_usd as number) ?? null,
                tokensIn,
                tokensOut: usage.output_tokens ?? 0,
                contextWindow: sdkContextWindow,
                totalProcessedTokens,
                cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
                cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
                providerId: "claude",
              } satisfies AgentEvent);

              // Invalidate the usage cache so the warm-refresh call from the
              // client picks up fresh plan utilization after this turn.
              this.usageSource.invalidate();
              this.emit("event", {
                type: AgentEventType.QuotaUpdate,
                threadId,
                providerId: "claude",
                categories: [],
                sessionCostUsd: this.lastSessionCostUsd,
                serviceTier: this.lastServiceTier,
                numTurns: this.lastNumTurns,
                durationMs: this.lastDurationMs,
              } satisfies AgentEvent);

              lastContextWindow = sdkContextWindow;
              // Reset for next turn
              lastStreamInputTokens = undefined;

              lastAssistantText = "";
              awaitingResume = true;
              // Keep `hasFiredToolThisTurn` for the lifetime of this `sendMessage`
              // query. The SDK emits `result` between internal API rounds while the
              // same user turn continues; clearing the flag there made every
              // post-`result` textDelta look like pre-tool preamble so
              // `isFinalResponse` never fired and the reply duplicated THOUGHT rows.
              break;
            }

            case "system": {
              // subtype 'status' carries the SDK's compaction state.
              // Only emit a compacting event on known transitions to avoid
              // spurious "active: false" from unrelated status strings (e.g.
              // "idle", "ready") that the SDK may send during session lifecycle.
              if ((anyMsg.subtype as string) === "status") {
                const sdkStatus = (anyMsg as { status?: string | null }).status;
                if (sdkStatus === "compacting" && !sessionCompacting) {
                  sessionCompacting = true;
                  this.emit("event", {
                    type: AgentEventType.Compacting,
                    threadId,
                    active: true,
                  } satisfies AgentEvent);
                } else if (sdkStatus !== "compacting" && sessionCompacting) {
                  sessionCompacting = false;
                  this.emit("event", {
                    type: AgentEventType.Compacting,
                    threadId,
                    active: false,
                  } satisfies AgentEvent);
                  // Ring hides during compaction (lastTokensIn: 0 sentinel).
                  // It stays hidden until the next authoritative turnComplete
                  // or stream_event message_start provides real usage data.
                }
              } else if ((anyMsg.subtype as string) === "compact_boundary") {
                const metadata = (anyMsg as { compact_metadata?: { pre_tokens?: number; trigger?: string } }).compact_metadata;
                if (metadata) {
                  logger.info("Compact boundary received", {
                    threadId,
                    preTokens: metadata.pre_tokens,
                    trigger: metadata.trigger,
                  });
                }
              } else if ((anyMsg.subtype as string) === "api_retry") {
                this.emit("event", {
                  type: AgentEventType.ApiRetry,
                  threadId,
                  reason: (anyMsg.error as string) || "unknown",
                  attempt: anyMsg.attempt as number | undefined,
                  maxRetries: anyMsg.max_retries as number | undefined,
                  delayMs: anyMsg.retry_delay_ms as number | undefined,
                  errorStatus: (anyMsg.error_status as number | undefined) ?? undefined,
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_started") {
                this.emit("event", {
                  type: AgentEventType.HookStarted,
                  threadId,
                  hookName: (anyMsg.hook_name as string) || "unknown",
                  hookType: anyMsg.tool_name ? "permission" : "stop",
                  ...(anyMsg.tool_name ? { toolName: anyMsg.tool_name as string } : {}),
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_progress") {
                this.emit("event", {
                  type: AgentEventType.HookProgress,
                  threadId,
                  hookName: (anyMsg.hook_name as string) || "unknown",
                  output: (anyMsg.output as string) || "",
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_response") {
                this.emit("event", {
                  type: AgentEventType.HookCompleted,
                  threadId,
                  hookName: (anyMsg.hook_name as string) || "unknown",
                  exitCode: (anyMsg.exit_code as number) ?? 1,
                  durationMs: (anyMsg.duration_ms as number) ?? 0,
                  didBlock: (anyMsg.did_block as boolean) ?? false,
                } satisfies AgentEvent);
              } else {
                this.emit("event", {
                  type: AgentEventType.System,
                  threadId,
                  subtype: (anyMsg.subtype as string) || "unknown",
                } satisfies AgentEvent);
              }
              break;
            }

            case "tool_use": {
              const toolId = (anyMsg.id as string) || "";
              if (toolId && emittedToolUseIds.has(toolId)) {
                break;
              }
              if (toolId) {
                emittedToolUseIds.add(toolId);
                const entry = this.sessions.get(sessionId);
                if (entry) {
                  entry.pendingToolUses.add(toolId);
                  entry.hasFiredToolThisTurn = true;
                }
              }
              // See sdkParentToolUseId above: empty string breaks nesting.
              const parentRaw = anyMsg.parent_tool_use_id as string | null | undefined;
              const parentToolCallId =
                typeof parentRaw === "string" && parentRaw.length > 0
                  ? parentRaw
                  : undefined;
              const toolName =
                (anyMsg.tool_name as string) ||
                (anyMsg.name as string) ||
                "unknown";
              logger.debug("Claude ToolUse from tool_use message", {
                toolId, toolName, parent_tool_use_id: parentToolCallId ?? null,
              });
              this.emit("event", {
                type: AgentEventType.ToolUse,
                threadId,
                toolCallId: toolId,
                toolName,
                toolInput:
                  (anyMsg.tool_input as Record<
                    string,
                    unknown
                  >) ||
                  (anyMsg.input as Record<
                    string,
                    unknown
                  >) ||
                  {},
                parentToolCallId,
              } satisfies AgentEvent);
              break;
            }

            case "tool_result": {
              const toolUseId = (anyMsg.tool_use_id as string) || "";
              const content = anyMsg.content;
              this.emit("event", {
                type: AgentEventType.ToolResult,
                threadId,
                toolCallId: toolUseId,
                output:
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content ?? ""),
                isError: Boolean(anyMsg.is_error),
              } satisfies AgentEvent);
              if (toolUseId) {
                const entry = this.sessions.get(sessionId);
                entry?.pendingToolUses.delete(toolUseId);
              }
              break;
            }

            case "stream_event": {
              const streamEvent = anyMsg.event as {
                type?: string;
                delta?: { type?: string; text?: string; partial_json?: string };
                message?: {
                  usage?: {
                    input_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              };
              if (streamEvent?.type === "message_start" && streamEvent.message?.usage) {
                const u = streamEvent.message.usage;
                lastStreamInputTokens =
                  (u.input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0);

                // Emit mid-turn context estimate so the ring updates on each API call.
                // contextWindow is undefined on the very first API call of a session
                // because lastContextWindow is only populated after the first result.
                // contextEstimate.contextWindow is optional and consumers handle undefined
                // gracefully via their own lastContextWindowByThread map.
                if (lastStreamInputTokens > 0) {
                  this.emit("event", {
                    type: AgentEventType.ContextEstimate,
                    threadId,
                    tokensIn: lastStreamInputTokens,
                    contextWindow: lastContextWindow,
                  } satisfies AgentEvent);
                }
              }
              if (streamEvent?.type === "content_block_delta") {
                if (
                  streamEvent.delta?.type === "text_delta" &&
                  typeof streamEvent.delta.text === "string" &&
                  streamEvent.delta.text
                ) {
                  // Determine whether this delta is part of the final user-facing
                  // response. The condition holds when all tool calls have resolved
                  // (pendingToolUses empty) AND at least one tool has fired this
                  // turn — distinguishing post-tool final-response text from
                  // pre-tool preamble, both of which have pendingToolUses===0.
                  const sessionEntry = this.sessions.get(sessionId);
                  const isFinalResponse =
                    sessionEntry !== undefined &&
                    sessionEntry.pendingToolUses.size === 0 &&
                    sessionEntry.hasFiredToolThisTurn === true;
                  this.emit("event", {
                    type: AgentEventType.TextDelta,
                    threadId,
                    delta: streamEvent.delta.text,
                    ...(isFinalResponse && { isFinalResponse: true }),
                  } satisfies AgentEvent);
                } else if (
                  streamEvent.delta?.type === "input_json_delta" &&
                  typeof streamEvent.delta.partial_json === "string" &&
                  streamEvent.delta.partial_json
                ) {
                  this.emit("event", {
                    type: AgentEventType.ToolInputDelta,
                    threadId,
                    partialJson: streamEvent.delta.partial_json,
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "tool_progress": {
              const toolUseId = (anyMsg.tool_use_id as string | undefined) ?? "";
              const toolName = (anyMsg.tool_name as string | undefined) ?? "unknown";
              const elapsedSeconds = (anyMsg.elapsed_time_seconds as number | undefined) ?? 0;
              if (toolUseId) {
                this.emit("event", {
                  type: AgentEventType.ToolProgress,
                  threadId,
                  toolCallId: toolUseId,
                  toolName,
                  elapsedSeconds,
                } satisfies AgentEvent);
              }
              break;
            }

            case "rate_limit_event": {
              const info = anyMsg.rate_limit_info as {
                status?: string;
                resetsAt?: number;
                rateLimitType?: string;
                utilization?: number;
              } | undefined;
              const status = info?.status;

              // Only surface warnings and rejections; 'allowed' is noise
              if (status === "allowed_warning" || status === "rejected") {
                const retryAfterMs = info?.resetsAt
                  ? Math.max(0, info.resetsAt * 1000 - Date.now())
                  : undefined;
                this.emit("event", {
                  type: AgentEventType.RateLimited,
                  threadId,
                  active: true,
                  retryAfterMs,
                  limitType: info?.rateLimitType,
                  utilization: info?.utilization,
                } satisfies AgentEvent);
              } else if (status === "allowed") {
                // Clear any previously active rate limit indicator
                this.emit("event", {
                  type: AgentEventType.RateLimited,
                  threadId,
                  active: false,
                } satisfies AgentEvent);
              }
              break;
            }
          }
        }
      } catch (e: unknown) {
        const errorMessage =
          e instanceof Error ? e.message : String(e);
        // Gate the Error event with the same "still the active stream" check
        // as the Ended event below. When a session is intentionally torn down
        // (mode change, setModel failure) the Claude CLI subprocess exits
        // non-zero after its stdin is closed, which propagates here as a
        // thrown exit error. That exit is expected, not a user-visible crash,
        // because a fresh session has already taken over the sessionId.
        const current = this.sessions.get(sessionId);
        const superseded =
          (current !== undefined && current.query !== q) ||
          current?.suppressEnded === true;
        if (superseded) {
          logger.debug("SDK stream error suppressed (session superseded)", {
            sessionId,
            error: errorMessage,
          });
        } else {
          logger.error("SDK stream error", {
            sessionId,
            error: errorMessage,
          });
          this.emit("event", {
            type: AgentEventType.Error,
            threadId,
            error: errorMessage,
          } satisfies AgentEvent);
        }
      } finally {
        const current = this.sessions.get(sessionId);
        if (current?.query === q) {
          this.sessions.delete(sessionId);
        }
        logger.info("Session stream ended", { sessionId });
        this.emit(`_streamDone:${sessionId}`);
        if (!suppressEnded && !current?.suppressEnded && (!current || current.query === q)) {
          this.emit("event", {
            type: AgentEventType.Ended,
            threadId,
          } satisfies AgentEvent);
        }
      }
    })();
  }

  /**
   * Discover and label new child PIDs spawned by sdkQuery().
   * Compares direct children of the server process before and after the spawn.
   * Best-effort: races with other concurrent spawns are tolerated because
   * labelling a wrong process is harmless (the description is overwritten
   * on the next setDescription call for that PID).
   */
  private async labelSdkSubprocess(beforePids: Set<number>): Promise<void> {
    if (!this.jobObject.isWindowsJob) return;
    try {
      const after = await listDirectChildren(process.pid);
      for (const child of after) {
        if (!beforePids.has(child.pid)) {
          this.jobObject.assign(child.pid);
          this.jobObject.setDescription(child.pid, "Mcode Agent: Claude");
        }
      }
    } catch {
      // Best-effort: process enumeration can fail transiently
    }
  }

  /** Build a multimodal SDKUserMessage from text and attachments. */
  private async buildMultimodalMessage(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): Promise<SDKUserMessage> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
      if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
      try {
        const data = await readFile(att.sourcePath);

        if (att.mimeType.startsWith("image/")) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.mimeType,
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "application/pdf") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "text/plain") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: data.toString("utf-8"),
            },
          });
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logger.error("Failed to read attachment", {
          id: att.id,
          path: att.sourcePath,
          error: errMsg,
        });
        contentBlocks.push({
          type: "text",
          text: `[Attachment failed to load: ${att.name} - ${errMsg}]`,
        });
      }
    }

    if (message.trim().length > 0) {
      contentBlocks.push({ type: "text", text: message });
    }

    return {
      type: "user" as const,
      message: {
        role: "user" as const,
        content:
          contentBlocks as unknown as SDKUserMessage["message"]["content"],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  /** Evict sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        // Skip sessions with in-flight tool calls: a long-running tool (build,
        // test suite, large file op) may not emit any SDK message for minutes.
        if (entry.pendingToolUses.size > 0) {
          logger.debug("Skipping eviction: pending tool calls", {
            sessionId,
            pending: entry.pendingToolUses.size,
          });
          continue;
        }
        // Never evict a session that is actively awaiting a user permission response —
        // the user may be on another thread and is about to respond.
        const tid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
        const hasPending = [...this.pendingPermissions.values()].some(
          (p) => p.threadId === tid,
        );
        if (hasPending) continue;

        logger.info("Evicting idle session", { sessionId });
        this.sessions.delete(sessionId);
        entry.closeQueue();
        entry.query.close();
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /**
   * Install a goal on a session. The next Stop event from the SDK will be
   * blocked with a "Goal not yet met" reason until {@link clearGoal} is
   * called. Storage is in-memory and tied to the sessionId; restarting the
   * server clears all goals.
   */
  setGoal(sessionId: string, condition: string): void {
    this.goalsBySession.set(sessionId, condition);
  }

  /** Remove an active goal so the next Stop event is allowed through. */
  clearGoal(sessionId: string): void {
    this.goalsBySession.delete(sessionId);
  }

  /** Return the active goal condition for a session, or undefined. */
  getGoal(sessionId: string): string | undefined {
    return this.goalsBySession.get(sessionId);
  }

  /** Abort a running session, or record a pending stop if the session hasn't been created yet. */
  stopSession(sessionId: string): void {
    // Normalize to the raw UUID that canUseTool stores as threadId.
    const tid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    // Reject all pending permission requests for this session and notify frontend.
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId === tid) {
        this.pendingPermissions.delete(requestId);
        entry.resolve("cancelled");
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      }
    }
    this.goalsBySession.delete(sessionId);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
    } else {
      // Session not yet created (sendMessage still in flight). Record the
      // stop so doSendMessage tears the session down immediately after
      // creation, preventing the agent from ever starting.
      this.pendingStops.add(sessionId);
      // Auto-expire after 10s in case the send never arrives (network
      // error, client disconnect, etc.) so the set doesn't leak.
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /**
   * Stop a session and wait for the underlying subprocess to exit.
   * Resolves when the stream loop emits _streamDone or when the timeout
   * elapses — whichever comes first. Safe to call if the session does not
   * exist (resolves immediately). The once-listener is always cleaned up,
   * even on timeout, to prevent EventEmitter listener accumulation.
   */
  async waitForSessionExit(sessionId: string, timeoutMs = 5000): Promise<void> {
    // Register the listener BEFORE checking sessions so we never miss an
    // event that fires between the check and the once() call.
    await new Promise<void>((resolve) => {
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(`_streamDone:${sessionId}`, done);
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);
      this.once(`_streamDone:${sessionId}`, done);

      const entry = this.sessions.get(sessionId);
      if (!entry) {
        // No active session — resolve immediately without waiting.
        done();
        return;
      }

      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
    });
  }

  /** Returns Claude plan utilization plus accumulated session stats. */
  async getUsage(): Promise<ProviderUsageInfo> {
    let categories: QuotaCategory[] | null = null;
    try {
      categories = await this.usageSource.fetch();
    } catch (error) {
      logger.warn("Failed to fetch Claude usage categories", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      providerId: "claude",
      quotaCategories: categories ?? [],
      sessionCostUsd: this.lastSessionCostUsd,
      serviceTier: this.lastServiceTier,
      numTurns: this.lastNumTurns,
      durationMs: this.lastDurationMs,
    };
  }

  /** Fetch available Claude models from the Anthropic REST API. */
  async listModels(): Promise<ProviderModelInfo[]> {
    return listClaudeModels();
  }

  /** Resolves a pending permission request by ID. Deletes the entry before calling resolve to prevent re-entrant calls. Returns false if the requestId is unknown. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) {
      logger.warn("resolvePermission: requestId not found in pendingPermissions", { requestId, decision, mapSize: this.pendingPermissions.size });
      return false;
    }
    logger.debug("resolvePermission", { requestId, decision, toolName: entry.toolName });
    this.pendingPermissions.delete(requestId);

    // Reset the session's idle timer so the 10-minute eviction clock starts
    // from the moment the user responds, not from when the request was sent.
    const sessionId = `mcode-${entry.threadId}`;
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsedAt = Date.now();

    entry.resolve(decision);
    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  /** Returns all pending permission requests for the given thread, including tool input and optional title for display. Used by the frontend to re-hydrate cards after a WebSocket reconnect. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId === threadId) {
        results.push({
          requestId,
          threadId: entry.threadId,
          toolName: entry.toolName,
          input: entry.input,
          title: entry.title,
        });
      }
    }
    return results;
  }

  /**
   * Toggle plan-answer mode for a thread. When enabled, the canUseTool
   * callback captures ExitPlanMode calls instead of denying them.
   * When disabled (or after capture), the model's ExitPlanMode calls
   * are denied silently.
   */
  setPlanAnswerMode(threadId: string, enabled: boolean): void {
    if (enabled) {
      this.planAnswerThreads.add(threadId);
    } else {
      this.planAnswerThreads.delete(threadId);
    }
  }

  /** Tear down all sessions and release resources. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    // Drain all pending permission requests so their promises settle
    for (const [requestId, entry] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      entry.resolve("cancelled");
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
    for (const [sessionId, entry] of this.sessions) {
      if (entry.pendingToolUses.size > 0) {
        logger.warn("Shutting down session with pending tool calls", {
          sessionId,
          pending: entry.pendingToolUses.size,
        });
      }
      entry.closeQueue();
      entry.query.close();
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    this.goalsBySession.clear();
    logger.info("ClaudeProvider shutdown complete");
  }
}
