/**
 * Codex provider adapter using the persistent `codex app-server` subprocess.
 *
 * Each session owns one `CodexAppServer` process that stays alive between turns.
 * JSON-RPC 2.0 notifications are translated to `AgentEvent` objects by
 * `CodexEventMapper` and forwarded to subscribers via EventEmitter.
 *
 * Turn lifecycle:
 *   sendMessage → server.sendTurn → notifications stream in → turn.completed/failed
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import { JobObject } from "../../services/job-object.js";
import { EnvService } from "../../services/env-service.js";
import type {
  IAgentProvider,
  TurnRequest,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
} from "@mcode/contracts";
import { AgentEventType, CODEX_STATIC_MODELS, isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { checkCodexVersion, meetsMinVersion } from "./codex-version.js";
import { CodexAppServer } from "./codex-app-server.js";
import type { CodexApprovalRequest } from "./codex-app-server.js";
import { CodexEventMapper } from "./codex-event-mapper.js";
import { traceCodexIngest } from "./codex-trace.js";
import {
  mapDecisionToCodexResponse,
  synthesizeCodexPermissionRequest,
} from "./codex-permission-mapper.js";
import type { TurnInputPart, CodexNotification } from "./codex-types.js";

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;
/**
 * Maximum wall-clock idle between Codex app-server notifications while
 * waiting for `turn/completed`. The timer resets on every notification so
 * quiet stretches without RPC traffic still time out, but active streams and
 * tool output keep the turn alive.
 */
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** Internal: a newer `sendMessage` aborted this turn wait (not user-facing). */
class CodexTurnSupersededError extends Error {
  constructor() {
    super("Codex turn superseded");
    this.name = "CodexTurnSupersededError";
  }
}

interface SessionEntry {
  server: CodexAppServer;
  mapper: CodexEventMapper;
  lastUsedAt: number;
  /** Sandbox mode used when this session was started; used to detect permission mode changes. */
  sandboxMode: string;
  /** Monotonic counter so overlapping `runTurn` waits ignore stale completions. */
  runTurnSeq: number;
  /** Codex `turn.id` from the latest `turn/started` for this session. */
  pendingTurnId: string | null;
  /** Clears the in-flight `runTurn` listener when a new turn preempts it. */
  abortPendingTurnWait?: () => void;
}

/** One pending codex approval bridged into the Phase 1 permission flow. */
interface PendingPermissionEntry {
  sessionId: string;
  threadId: string;
  toolName: string;
  input: unknown;
  title?: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (response: unknown) => void;
}

/**
 * Builds the Codex turn input from a message string and optional attachments.
 * Images become `localImage` parts; non-image files become sanitised text notes
 * that omit internal filesystem paths to prevent prompt injection.
 */
function buildCodexInput(
  message: string,
  attachments?: AttachmentMeta[],
): TurnInputPart[] {
  const inputs: TurnInputPart[] = [];

  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (att.mimeType.startsWith("image/")) {
      inputs.push({ type: "localImage", path: att.sourcePath });
    } else {
      // Strip control characters (including newlines) from user-supplied strings
      // to prevent prompt injection. Do not expose internal filesystem paths.
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      inputs.push({ type: "text", text: `[Attached file: ${safeName} (${safeMime})]` });
    }
  }

  inputs.push({ type: "text", text: message });
  return inputs;
}

/** Maps mcode ReasoningLevel to the codex app-server `effort` field value. */
function toCodexEffort(level?: ReasoningLevel): string | undefined {
  if (!level) return undefined;
  if (level === "max" || level === "ultrathink") return "high";
  return level;
}

/** Codex provider adapter implementing IAgentProvider with a persistent app-server process per session. */
@injectable()
export class CodexProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "codex";
  /** Codex CLI is an agentic tool with no one-shot text completion mode. */
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "unsupported" as const;
  readonly maxInputCharactersPerTurn = 16_000;

  /** Returns the static Codex model catalog. Codex does not support dynamic model discovery. */
  async listModels(): Promise<ProviderModelInfo[]> {
    return CODEX_STATIC_MODELS.map((m) => ({ ...m }));
  }

  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending host-side permission approvals keyed by requestId. */
  private pendingPermissions = new Map<string, PendingPermissionEntry>();

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("JobObject") private readonly jobObject: JobObject,
    @inject(EnvService) private readonly envService: EnvService,
  ) {
    super();
  }

  /**
   * Starts or continues a session by sending a message to the Codex app-server.
   * For new sessions, spawns a subprocess and runs the JSON-RPC handshake first.
   * The method returns immediately; events stream via the `event` EventEmitter channel.
   */
  async sendTurn(req: TurnRequest<"codex">): Promise<void> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.codex || "codex";

    // `resumeFrom` defined ⇒ resume that Codex thread; undefined ⇒ fresh.
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }
    const {
      sessionId, message, cwd, model, permissionMode,
      reasoningLevel, attachments,
    } = req;
    const resume = req.resumeFrom !== undefined;
    const codexFastMode = req.providerOptions.fastMode;

    const input = buildCodexInput(message, attachments);
    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";
    const approvalPolicy = permissionMode === "full" ? "never" : "on-request";
    const existing = this.sessions.get(sessionId);

    const useFastTier =
      codexFastMode !== undefined
        ? codexFastMode
        : settings.provider.codex?.fastMode === true;
    const fastServiceTier = useFastTier ? "fast" : undefined;

    const turnOptions = {
      model: model || undefined,
      effort: toCodexEffort(reasoningLevel),
      ...(fastServiceTier && { serviceTier: fastServiceTier }),
    };

    if (existing) {
      // Resilience: the cached SessionEntry may point at a dead app-server
      // (codex CLI idle-killed, host suspend/resume, or the "exit" event has
      // not yet drained the EventEmitter queue). Reusing a dead server makes
      // the next user message hang on a turn/start RPC until the 30s timeout
      // fires, surfaced to the user as a generic timeout error. Detect the
      // dead-server case and fall through to a clean respawn instead.
      if (!existing.server.isAlive) {
        logger.info("Codex session was dead; respawning", { sessionId });
        this.drainPending((e) => e.sessionId === sessionId);
        this.sessions.delete(sessionId);
      } else if (existing.sandboxMode === sandbox) {
        // Same permission mode - reuse the running session
        existing.lastUsedAt = Date.now();
        existing.mapper.reset();
        void this.runTurn(sessionId, threadId, existing.server, input, turnOptions);
        return;
      } else {
      // Permission mode changed - kill the old session so we can start fresh with the correct sandbox
      logger.info("Codex session restarted due to permission mode change", {
        sessionId,
        from: existing.sandboxMode,
        to: sandbox,
      });
      // Drain pending permissions for this session before kill. The app-server's
      // graceful exit path suppresses the "fatal" emit (killRequested=true), so
      // attachFatalDrain won't fire here; cancel any open cards explicitly so
      // the UI doesn't keep a stale amber dot on an orphaned request.
      this.drainPending((e) => e.sessionId === sessionId);
      this.sessions.delete(sessionId);
      // Clear the stored SDK thread ID so the new session starts fresh rather than
      // resuming the old thread (which would inherit the old sandbox mode).
      this.sdkSessionIds.delete(sessionId);
      existing.server.kill().catch((err: unknown) => {
        logger.warn("Codex session kill on permission change failed", { error: String(err) });
      });
      }
    }

    // Version check only when starting a new session (cached in codex-version per CLI path).
    const versionResult = checkCodexVersion(cliPath);
    if (!versionResult.ok) {
      this.emit("event", { type: AgentEventType.Error, threadId, error: versionResult.error } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    if (!meetsMinVersion(versionResult.version, "0.37.0")) {
      const errorMsg = `Codex CLI version ${versionResult.version} is not supported. Minimum required: 0.37.0. Update with: npm install -g @openai/codex`;
      this.emit("event", { type: AgentEventType.Error, threadId, error: errorMsg } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    const resumeId = this.sdkSessionIds.get(sessionId);
    const attemptResume = !!(resume && resumeId);

    // Only register the handler in supervised mode. The CodexAppServer
    // ignores approvalHandler when approvalPolicy === "never" (auto-approve
    // still runs locally), so this guard is defensive and keeps the wiring
    // obvious in logs.
    const supervised = approvalPolicy === "on-request";

    const server = new CodexAppServer({
      cliPath,
      workingDirectory: cwd,
      model: model || undefined,
      sandbox,
      approvalPolicy,
      resumeThreadId: attemptResume ? resumeId : undefined,
      approvalHandler: supervised
        ? (req) => this.handleApprovalRequest(sessionId, threadId, req)
        : undefined,
      jobObject: this.jobObject,
      getSpawnEnv: () => this.envService.getEnv(),
    });

    const mapper = new CodexEventMapper(threadId);

    server.on("notification", (notification) => {
      const n = notification as { method?: string; params?: Record<string, unknown> };
      if (n.method === "turn/started") {
        const turn = n.params?.turn as { id?: string } | undefined;
        const entry = this.sessions.get(sessionId);
        if (entry && turn?.id) entry.pendingTurnId = turn.id;
      }
      const events = mapper.mapNotification(notification as CodexNotification);
      traceCodexIngest(threadId, n.method, n.params, events);
      for (const event of events) {
        this.emit("event", event);
      }
    });

    // When the codex thread ID rotates mid-session (context compaction, etc.),
    // update the in-memory map and persist the new ID so future app restarts
    // resume the correct thread instead of a stale one.
    server.on("threadIdChanged", (newThreadId: string) => {
      this.sdkSessionIds.set(sessionId, newThreadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + newThreadId,
      } satisfies AgentEvent);
    });

    server.on("fatal", (error: string) => {
      logger.error("CodexAppServer fatal", { sessionId, error });
      this.emit("event", { type: AgentEventType.Error, threadId, error } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      this.sessions.delete(sessionId);
    });

    this.attachFatalDrain(sessionId, server);

    server.on("exit", () => {
      if (!server.isAlive) {
        this.sessions.delete(sessionId);
      }
    });

    try {
      await server.start();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CodexAppServer start failed", { sessionId, error: errorMessage });
      this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    if (server.resumeFailed) {
      logger.warn("Codex session context lost; resume failed, started fresh thread", { sessionId });
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "context_lost",
      } satisfies AgentEvent);
    }

    if (server.threadId) {
      this.sdkSessionIds.set(sessionId, server.threadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + server.threadId,
      } satisfies AgentEvent);
    }

    this.sessions.set(sessionId, {
      server,
      mapper,
      lastUsedAt: Date.now(),
      sandboxMode: sandbox,
      runTurnSeq: 0,
      pendingTurnId: null,
    });

    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new Codex session", { sessionId });
      void server.kill().catch((err: unknown) => {
        logger.warn("Codex pending-stop kill failed", { sessionId, error: String(err) });
      });
      this.sessions.delete(sessionId);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    void this.runTurn(sessionId, threadId, server, input, turnOptions);
  }

  /**
   * Sends a single turn to the app-server and waits for matching `turn/completed`.
   * Overlapping sends preempt prior waits so stale completions cannot finish
   * the wrong promise. Emits `ended` when the turn finishes for this wait only.
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions?: { model?: string; effort?: string; serviceTier?: string },
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.abortPendingTurnWait?.();
    entry.abortPendingTurnWait = undefined;

    entry.runTurnSeq += 1;
    const seq = entry.runTurnSeq;
    entry.pendingTurnId = null;

    await server.interruptTurn();

    let serverDied = false;
    let endedEmitted = false;

    try {
      await new Promise<void>((resolve, reject) => {
        let activityTimer: ReturnType<typeof setTimeout>;
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(activityTimer);
          server.removeListener("notification", onNotification);
          server.removeListener("fatal", onFatal);
          if (entry.abortPendingTurnWait === abortThis) entry.abortPendingTurnWait = undefined;
        };

        const armTimer = () => {
          clearTimeout(activityTimer);
          activityTimer = setTimeout(() => {
            cleanup();
            reject(new Error(`Codex turn timed out after ${TURN_TIMEOUT_MS / 1000}s with no app-server notifications`));
          }, TURN_TIMEOUT_MS);
        };

        const abortThis = () => {
          cleanup();
          reject(new CodexTurnSupersededError());
        };
        entry.abortPendingTurnWait = abortThis;

        const onNotification = (notification: unknown) => {
          armTimer();
          const n = notification as { method?: string; params?: Record<string, unknown> };
          if (n.method === "turn/completed") {
            const turn = n.params?.turn as { id?: string } | undefined;
            const tid = turn?.id;
            if (!tid || !entry.pendingTurnId || tid !== entry.pendingTurnId) {
              logger.debug("Codex turn/completed ignored (stale or unmatched)", {
                tid,
                pending: entry.pendingTurnId,
                seq,
                liveSeq: entry.runTurnSeq,
              });
              return;
            }
            if (seq !== entry.runTurnSeq) return;
            cleanup();
            resolve();
          }
        };

        const onFatal = () => {
          cleanup();
          serverDied = true;
          reject(new Error("Codex app-server died during turn"));
        };

        armTimer();
        server.on("notification", onNotification);
        server.once("fatal", onFatal);

        void server.sendTurn(input, turnOptions).catch((err) => {
          cleanup();
          reject(err);
        });
      });
    } catch (e: unknown) {
      if (e instanceof CodexTurnSupersededError) return;
      if (!serverDied && seq === entry.runTurnSeq) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Codex turn failed", { sessionId, error: errorMessage });
        this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      }
    } finally {
      if (!serverDied && seq === entry.runTurnSeq && !endedEmitted) {
        endedEmitted = true;
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      }
    }
  }

  /**
   * Bridges a codex app-server serverRequest into the Phase 1 permission flow.
   * Allocates a requestId, synthesises a PermissionRequest for the card UI,
   * emits permission_request, and returns a promise that the app-server
   * response listener awaits. Resolved by resolvePermission or by session
   * shutdown/stop (which supply "cancelled").
   */
  private handleApprovalRequest(
    sessionId: string,
    threadId: string,
    request: CodexApprovalRequest,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const synthesized = synthesizeCodexPermissionRequest({
      threadId,
      requestId,
      method: request.method,
      params: request.params,
    });

    return new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, {
        sessionId,
        threadId,
        toolName: synthesized.toolName,
        input: synthesized.input,
        title: synthesized.title,
        method: request.method,
        params: request.params,
        resolve,
      });
      this.emit("permission_request", synthesized satisfies PermissionRequest);
    });
  }

  /**
   * Resolve a pending permission request. Mirrors ClaudeProvider.resolvePermission.
   * Returns true if requestId was found. On resolve, the codex app-server unblocks.
   */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return false;
    this.pendingPermissions.delete(requestId);

    // Reset idle timer on the owning session so user attention counts as activity.
    const session = this.sessions.get(entry.sessionId);
    if (session) session.lastUsedAt = Date.now();

    const response = mapDecisionToCodexResponse(entry.method, decision, entry.params);
    entry.resolve(response);
    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  /** List pending permissions for a given thread. */
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

  /**
   * Install a fatal listener on a CodexAppServer that drains pending permissions
   * for this session when the child process dies unexpectedly. Kept as its own
   * method so tests can invoke it against a stub EventEmitter.
   */
  private attachFatalDrain(sessionId: string, server: { on: (e: string, h: (...args: unknown[]) => void) => void }): void {
    server.on("fatal", () => {
      this.drainPending((e) => e.sessionId === sessionId);
    });
  }

  /**
   * Drain all pending permissions that match a predicate, resolving each as "cancelled".
   * Used by stopSession and shutdown to unblock any in-flight approvals so the
   * codex turn can tear down cleanly.
   */
  private drainPending(predicate: (entry: PendingPermissionEntry) => boolean): void {
    for (const [requestId, entry] of [...this.pendingPermissions]) {
      if (!predicate(entry)) continue;
      this.pendingPermissions.delete(requestId);
      const response = mapDecisionToCodexResponse(entry.method, "cancelled", entry.params);
      entry.resolve(response);
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
  }

  /** Evicts sessions that have been idle longer than IDLE_TTL_MS. Sessions with pending permissions are spared. */
  private evictIdleSessions(): void {
    const now = Date.now();
    // Build the set of sessionIds with at least one pending permission once
    // rather than iterating the map per session.
    const hasPending = new Set<string>();
    for (const entry of this.pendingPermissions.values()) {
      hasPending.add(entry.sessionId);
    }
    for (const [sessionId, entry] of this.sessions) {
      if (hasPending.has(sessionId)) continue;
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicted idle Codex session", { sessionId });
        void entry.server.kill();
        this.sessions.delete(sessionId);
      }
    }
  }


  /** Kills a running session's subprocess and cancels any pending permissions for its thread. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    // Drain first so handler promises resolve with the cancel response BEFORE
    // we kill(). That way the app-server sees the cancel decision, interrupts
    // the turn cleanly, and there is no race with the process exiting.
    this.drainPending((e) => e.sessionId === sessionId);
    if (entry) {
      void entry.server.kill();
      this.sessions.delete(sessionId);
    } else {
      this.pendingStops.add(sessionId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /** Tears down all sessions, drains pending permissions, and stops the eviction timer. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.drainPending(() => true);
    for (const [, entry] of this.sessions) {
      void entry.server.kill();
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("CodexProvider shutdown complete");
  }
}
