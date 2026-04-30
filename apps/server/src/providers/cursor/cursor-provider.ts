/**
 * Cursor CLI provider via `cursor-agent --print --output-format stream-json`.
 *
 * Each prompt turn spawns a fresh subprocess that resolves the persistent
 * chat from disk via `--resume <chatId>` and exits when the turn completes.
 * This replaces the prior `cursor-agent acp` long-lived subprocess pool: the
 * ACP transport's `session/load` resume path is broken on Cursor's side
 * (sessionIds are subprocess-scoped and cannot be reattached after a
 * restart), and the chat-id namespace exposed via `--resume` is the only
 * stable persistence handle Cursor offers.
 *
 * Trade-offs vs the ACP transport:
 *   - **Resume across restarts** works: chat ids round-trip through
 *     `setSdkSessionId` and disk persistence.
 *   - **Permissions** are simplified: `cursor-agent --print` has no
 *     interactive permission flow ("Has access to all tools, including write
 *     and shell"), so we cannot route per-tool prompts through the UI like
 *     the ACP transport did. Instead we delegate safety to whatever
 *     cursor-agent supports on the host:
 *       - **full mode** (all platforms): `--force --sandbox disabled`
 *         (tool approval + workspace trust, sandbox off — anything goes)
 *       - **default mode on macOS/Linux**: `--trust --sandbox enabled`
 *         (workspace trust granted; OS sandbox blocks writes outside the
 *         workspace and dangerous shell commands)
 *       - **default mode on Windows**: `--trust --sandbox disabled` — the
 *         OS sandbox is unsupported on Windows ("Sandbox requires macOS or
 *         Linux"), so we fall back to cursor-agent's built-in allowlist
 *         mode. Off-allowlist commands are auto-rejected at the agent
 *         layer; this is weaker than the OS sandbox but better than `--force`.
 *     All flags are passed explicitly so the user's local cursor-agent
 *     config cannot override the intended semantics.
 *   - **No subprocess pool / idle eviction** — every turn is fresh, so the
 *     resource model is "pay per turn" instead of "pay to keep alive".
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "node:events";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import { AgentEventType, CURSOR_STATIC_MODEL_FALLBACK, getCatalogEntry } from "@mcode/contracts";
import type {
  AttachmentMeta,
  AgentEvent,
  IAgentProvider,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  ProviderModelInfo,
  ReasoningLevel,
  Settings,
} from "@mcode/contracts";
import { runCursorTurn } from "./cursor-turn-runner.js";
import {
  buildCursorPrompt,
  readCursorUserInstructions,
} from "./cursor-prompt.js";
import {
  createCursorTodoSnapshot,
  type CursorTodoSnapshot,
} from "./cursor-todo-snapshot.js";
import { fetchCursorCliModels } from "./cursor-cli-models.js";

/** Per-mcode-session state that survives across prompt turns. */
interface CursorSessionState {
  /** Persistent cursor chat id (used with `--resume`). Null until first turn captures it. */
  chatId: string | null;
  /** Snapshot for `merge: true` updateTodos reconciliation across turns. */
  todoSnapshot: CursorTodoSnapshot;
  /** AbortController for the in-flight turn (if any), used by stopSession. */
  inFlight: AbortController | null;
}

/** Executable paths to try for cursor-agent (configured override → catalog → bare name). */
function cursorCliProbeBinaries(settings: Settings): string[] {
  const configured = settings.provider.cli.cursor?.trim();
  return configured ? [configured] : [getCatalogEntry("cursor").cliBinary, "agent"];
}

/**
 * Cursor CLI-backed agent provider using the `--print` stream-json transport.
 */
@injectable()
export class CursorProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "cursor";
  readonly supportsCompletion = false;

  private states = new Map<string, CursorSessionState>();
  /** Mirror of states[*].chatId so `setSdkSessionId` works before first send. */
  private sdkSessionIds = new Map<string, string>();

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /** Lists models by running `cursor-agent models` (falls back when discovery fails). */
  async listModels(): Promise<ProviderModelInfo[]> {
    const settings = this.settingsService.get();

    for (const cliPath of cursorCliProbeBinaries(settings)) {
      const discovered = await fetchCursorCliModels(cliPath);
      if (discovered?.length) {
        return discovered;
      }
    }

    logger.info("Cursor listModels: using static fallback (CLI discovery unavailable)");
    return [...CURSOR_STATIC_MODEL_FALLBACK];
  }

  /**
   * Sends a user message by spawning one cursor-agent --print turn.
   *
   * Emits TurnStarted, then streamed deltas/tool events from the runner,
   * then Message + TurnComplete + Ended for persistence parity. On error,
   * emits Error + Ended so the UI doesn't show a stuck spinner.
   */
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
  }): Promise<void> {
    void params.fallbackModel;
    void params.reasoningLevel;

    const settings = this.settingsService.get();

    const {
      sessionId,
      message,
      cwd,
      model,
      resume,
      permissionMode,
      attachments,
    } = params;

    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    const prompt = buildCursorPrompt(message, attachments, readCursorUserInstructions());

    const state = this.getOrCreateState(sessionId);
    const chatId = resume ? state.chatId ?? this.sdkSessionIds.get(sessionId) ?? null : null;

    const abort = new AbortController();
    state.inFlight = abort;

    this.emit("event", { type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);

    const cliCandidates = cursorCliProbeBinaries(settings);
    let lastErr: unknown = null;
    for (const cliPath of cliCandidates) {
      try {
        const { chatId: capturedChatId, assistantText } = await runCursorTurn(
          {
            cliPath,
            prompt,
            cwd,
            threadId,
            model: model || undefined,
            permissionMode: permissionMode === "full" ? "full" : "default",
            chatId,
          },
          (ev) => this.emit("event", ev),
          state.todoSnapshot,
          abort.signal,
        );
        if (capturedChatId) {
          state.chatId = capturedChatId;
          this.sdkSessionIds.set(sessionId, capturedChatId);
        }
        state.inFlight = null;
        this.finishTurn(threadId, assistantText);
        return;
      } catch (e) {
        lastErr = e;
        // ENOENT / spawn errors → try the next probed binary.
        const msg = e instanceof Error ? e.message : String(e);
        if (/Failed to spawn cursor-agent/i.test(msg)) continue;
        // All other errors are real turn failures — surface immediately.
        break;
      }
    }

    state.inFlight = null;
    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "cursor-agent failed");
    logger.error("Cursor turn failed", { sessionId, error: errMsg });
    this.emit("event", { type: AgentEventType.Error, threadId, error: errMsg } satisfies AgentEvent);
    this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
  }

  /** Persists chat ids so subsequent turns resume the same cursor chat. */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
    const state = this.states.get(sessionId);
    if (state) state.chatId = sdkSessionId;
  }

  /** Aborts the in-flight turn (if any). State is preserved for the next turn. */
  stopSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state?.inFlight) return;
    try {
      state.inFlight.abort();
    } catch {
      /* ignore */
    }
    state.inFlight = null;
  }

  /** Aborts every in-flight turn and clears bookkeeping. */
  shutdown(): void {
    for (const state of this.states.values()) {
      if (state.inFlight) {
        try {
          state.inFlight.abort();
        } catch {
          /* ignore */
        }
      }
    }
    this.states.clear();
    this.sdkSessionIds.clear();
    logger.info("CursorProvider shutdown complete");
  }

  /**
   * Stream-json --print mode does not surface interactive permission prompts.
   * The method is preserved on the interface as a no-op so the WebSocket RPC
   * router can call it uniformly across providers.
   */
  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false;
  }

  /** Stream-json --print mode never produces pending permissions. */
  listPendingPermissions(_threadId: string): PermissionRequest[] {
    return [];
  }

  private finishTurn(threadId: string, assistantText: string): void {
    if (assistantText.trim()) {
      this.emit("event", {
        type: AgentEventType.Message,
        threadId,
        content: assistantText,
        tokens: null,
      } satisfies AgentEvent);
    }

    this.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      providerId: "cursor",
    } satisfies AgentEvent);

    this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
  }

  private getOrCreateState(sessionId: string): CursorSessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        chatId: this.sdkSessionIds.get(sessionId) ?? null,
        todoSnapshot: createCursorTodoSnapshot(),
        inFlight: null,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
