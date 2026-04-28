/**
 * Cursor CLI provider via `agent acp` (ACP): persistent subprocess per mcode session,
 * JSON-RPC over NDJSON stdio, mapped into {@link AgentEvent} for AgentService.
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import { getCatalogEntry } from "@mcode/contracts";
import type {
  AttachmentMeta,
  IAgentProvider,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  ProviderModelInfo,
  ReasoningLevel,
  AgentEvent,
} from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { CursorAcpSession } from "./cursor-acp-session.js";
import {
  cursorPermissionDenyFallback,
  mapCursorPermissionRpcResult,
} from "./cursor-permission-mapper.js";
import { fetchCursorCliModels } from "./cursor-cli-models.js";

/** Idle TTL before evicting an idle Cursor ACP session (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** Interval between idle eviction passes (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

/** Minimal fallback when `agent models` cannot be run (offline CLI, parse failure). */
const CURSOR_STATIC_MODEL_FALLBACK: ProviderModelInfo[] = [
  { id: "auto", name: "Auto", group: "Cursor" },
  { id: "composer-2-fast", name: "Composer 2 Fast", group: "Cursor" },
];

interface SessionEntry {
  session: CursorAcpSession;
  lastUsedAt: number;
}

interface PendingPermissionEntry {
  sessionId: string;
  threadId: string;
  toolName: string;
  input: unknown;
  title?: string;
  resolve: (result: unknown) => void;
}

/**
 * Builds prompt text from the user message plus safe attachment references.
 * Images become explicit paths; non-images become labelled mentions without raw FS paths for prompt injection.
 */
function buildCursorPrompt(message: string, attachments?: AttachmentMeta[]): string {
  const lines: string[] = [];
  for (const att of attachments ?? []) {
    if (att.mimeType.startsWith("image/")) {
      lines.push(`[Attached image path: ${att.sourcePath}]`);
    } else {
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      lines.push(`[Attached file: ${safeName} (${safeMime})]`);
    }
  }
  lines.push(message);
  return lines.join("\n\n");
}

/**
 * Cursor CLI-backed agent provider using Cursor's ACP (`agent acp`) integration surface.
 */
@injectable()
export class CursorProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "cursor";
  readonly supportsCompletion = false;

  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPermissions = new Map<string, PendingPermissionEntry>();

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /** Lists models by running `cursor-agent models` / `agent models` (falls back if discovery fails). */
  async listModels(): Promise<ProviderModelInfo[]> {
    const settings = this.settingsService.get();
    const configured = settings.provider.cli.cursor?.trim();
    const probeBinaries = configured
      ? [configured]
      : [getCatalogEntry("cursor").cliBinary, "agent"];

    for (const cliPath of probeBinaries) {
      const discovered = await fetchCursorCliModels(cliPath);
      if (discovered?.length) {
        return discovered;
      }
    }

    logger.info("Cursor listModels: using static fallback (CLI discovery unavailable)");
    return [...CURSOR_STATIC_MODEL_FALLBACK];
  }

  /**
   * Sends a user message using Cursor ACP on a persistent subprocess per mcode session id.
   *
   * Emits streaming deltas where available, then Message + TurnComplete + Ended for persistence parity.
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
    const configured = settings.provider.cli.cursor?.trim();
    const cliPath = configured || getCatalogEntry("cursor").cliBinary;

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
    const prompt = buildCursorPrompt(message, attachments);

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => this.evictIdleSessions(), EVICTION_INTERVAL_MS);
    }

    const resumeId = this.sdkSessionIds.get(sessionId);
    const attemptResume = !!(resume && resumeId);

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      try {
        this.emit("event", { type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);
        const { assistantText } = await existing.session.sendPrompt(prompt, model || undefined);
        this.finishTurn(threadId, assistantText);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error("Cursor sendPrompt failed", { sessionId, error: msg });
        this.emit("event", { type: AgentEventType.Error, threadId, error: msg } satisfies AgentEvent);
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      }
      return;
    }

    const trustWorkspace = permissionMode === "full";

    const session = new CursorAcpSession({
      cliPath,
      cwd,
      trustWorkspace,
      resumeSessionId: attemptResume ? resumeId : undefined,
      threadId,
      onAgentEvent: (ev) => this.emit("event", ev),
      handleServerRequest: (req) => this.handleAcpServerRequest(sessionId, threadId, req),
    });

    try {
      await session.start();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("Cursor ACP start failed", { sessionId, error: msg });
      this.emit("event", { type: AgentEventType.Error, threadId, error: msg } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    const sid = session.cursorSessionId;
    if (sid) {
      this.sdkSessionIds.set(sessionId, sid);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: `sdk_session_id:${sid}`,
      } satisfies AgentEvent);
    }

    this.sessions.set(sessionId, { session, lastUsedAt: Date.now() });

    try {
      this.emit("event", { type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);
      const { assistantText } = await session.sendPrompt(prompt, model || undefined);
      this.finishTurn(threadId, assistantText);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("Cursor sendPrompt failed", { sessionId, error: msg });
      this.emit("event", { type: AgentEventType.Error, threadId, error: msg } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
    }
  }

  /** Persists SDK session ids for Cursor resume (`session/load`). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Aborts the Cursor subprocess for this session cancels pending approvals. */
  stopSession(sessionId: string): void {
    this.drainPending((e) => e.sessionId === sessionId);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      void entry.session.kill().catch((err: unknown) => {
        logger.warn("Cursor session kill failed", { sessionId, error: String(err) });
      });
      this.sessions.delete(sessionId);
    }
  }

  /** Kills every Cursor subprocess and clears bookkeeping. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.drainPending(() => true);
    for (const [, entry] of this.sessions) {
      void entry.session.kill().catch(() => {});
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("CursorProvider shutdown complete");
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return false;
    this.pendingPermissions.delete(requestId);

    const owning = this.sessions.get(entry.sessionId);
    if (owning) owning.lastUsedAt = Date.now();

    try {
      entry.resolve(mapCursorPermissionRpcResult(decision));
    } catch {
      entry.resolve(cursorPermissionDenyFallback());
    }

    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId !== threadId) continue;
      out.push({
        requestId,
        threadId: entry.threadId,
        toolName: entry.toolName,
        input: entry.input,
        title: entry.title,
      });
    }
    return out;
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

  private async handleAcpServerRequest(
    sessionId: string,
    threadId: string,
    req: { id: number | string; method: string; params: unknown },
  ): Promise<unknown> {
    const method = req.method;

    if (method === "session/request_permission") {
      return await new Promise<unknown>((resolve) => {
        const requestId = randomUUID();
        const synthesized: PermissionRequest = {
          requestId,
          threadId,
          toolName: "session/request_permission",
          input: req.params,
          title: "Cursor permission",
        };

        this.pendingPermissions.set(requestId, {
          sessionId,
          threadId,
          toolName: synthesized.toolName,
          input: synthesized.input,
          title: synthesized.title,
          resolve,
        });

        this.emit("permission_request", synthesized);
      });
    }

    if (method.startsWith("cursor/")) {
      logger.info("Cursor ACP extension RPC skipped by host", { method });
      return { outcome: { outcome: "skipped", reason: `mcode:unsupported:${method}` } };
    }

    logger.warn("Cursor ACP unknown serverRequest — denying safely", { method });
    return cursorPermissionDenyFallback();
  }

  private drainPending(predicate: (entry: PendingPermissionEntry) => boolean): void {
    for (const [requestId, entry] of [...this.pendingPermissions]) {
      if (!predicate(entry)) continue;
      this.pendingPermissions.delete(requestId);
      entry.resolve(cursorPermissionDenyFallback());
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
  }

  private evictIdleSessions(): void {
    const now = Date.now();
    const busy = new Set<string>();
    for (const e of this.pendingPermissions.values()) {
      busy.add(e.sessionId);
    }
    for (const [sessionId, entry] of this.sessions) {
      if (busy.has(sessionId)) continue;
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicted idle Cursor session", { sessionId });
        void entry.session.kill().catch(() => {});
        this.sessions.delete(sessionId);
      }
    }
  }
}
