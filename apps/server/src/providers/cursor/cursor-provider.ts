/**
 * Cursor CLI provider via long-lived `cursor-agent acp` (Agent Client Protocol).
 *
 * One subprocess per Mcode thread keeps JSON-RPC on stdio stable across turns.
 * When `session/load` fails (known Cursor limitations), we fall back to `session/new`
 * and emit `sdk_session_id` so the DB tracks the active session id.
 */

import { injectable, inject } from "tsyringe";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { logger } from "@mcode/shared";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { SettingsService } from "../../services/settings-service.js";
import { SkillService } from "../../services/skill-service.js";
import { EnvService } from "../../services/env-service.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { JobObject } from "../../services/job-object.js";
import {
  AgentEventType,
  CURSOR_STATIC_MODEL_FALLBACK,
  getCatalogEntry,
} from "@mcode/contracts";
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
import {
  createCursorTodoSnapshot,
  cursorUpdateTodosExtNotificationToAgentEvents,
  type CursorTodoSnapshot,
} from "./cursor-todo-snapshot.js";
import { fetchCursorCliModels } from "./cursor-cli-models.js";
import { buildCursorAcpArgs } from "./cursor-acp-spawn-args.js";
import { buildCursorAcpPromptBlocks } from "./cursor-acp-prompt.js";
import {
  buildCursorAgentGuidanceMarkdown,
  formatCursorSkillsAndCommandsForPrompt,
} from "./cursor-agent-guidance.js";
import { readCursorUserInstructions } from "./cursor-prompt.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
  type CursorAcpTurnState,
} from "./cursor-acp-event-mapper.js";
import { resolveCursorAssistantMessageContent } from "./cursor-stream-event-mapper.js";
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
  synthesizeCursorAcpPermissionRequest,
} from "./cursor-acp-permission-mapper.js";
import { resolveCursorStickyInstructionBlob } from "./cursor-acp-sticky-instructions.js";
import { buildCursorAskQuestionExtResponse } from "./cursor-acp-ask-question.js";
import {
  looksLikeUpstreamStreamCancel,
  isLikelyTransientCursorPromptFailure,
} from "./cursor-acp-transient-retry.js";
import {
  shouldEmitCursorSessionTrace,
  summarizeCursorSessionNotification,
  summarizeEmittedAgentEventsForTrace,
} from "./cursor-acp-session-trace.js";
import { cursorTaskExtToAgentEvents } from "./cursor-acp-task.js";

const CURSOR_STDERR_TAIL_MAX = 48;
const EVICTION_INTERVAL_MS = 60 * 1000;

function cursorCliProbeBinaries(settings: Settings): string[] {
  const configured = settings.provider.cli.cursor?.trim();
  return configured ? [configured] : [getCatalogEntry("cursor").cliBinary, "agent"];
}

interface PendingAcpPermission {
  mcodeSessionId: string;
  threadId: string;
  options: PermissionOption[];
  request: PermissionRequest;
  resolve: (value: RequestPermissionResponse) => void;
}

interface CursorAcpSessionEntry {
  mcodeSessionId: string;
  threadId: string;
  child: ChildProcess;
  connection: ClientSideConnection;
  acpSessionId: string;
  cwd: string;
  permissionMode: "full" | "default";
  lastUsedAt: number;
  todoSnapshot: CursorTodoSnapshot;
  turnChain: Promise<void>;
  activeTurnState: CursorAcpTurnState | null;
  /** True once a heavy stitched instructions blob (> threshold) shipped on this MCP session. */
  stickyHeavyInstructionsSent: boolean;
  /** Monotonic prompts across the MCP subprocess lifetime (sticky preamble pacing). */
  cursorPromptOrdinal: number;
  /** Recent stderr snippets for diagnosing opaque CLI failures. */
  stderrTailLines: string[];
  /** Last stable `modelId` handshake for this MCP session (`acpSessionId` rotation forces re-apply). */
  cursorModelAppliedPair: { acpSessionId: string; modelId: string } | null;
  /** Set immediately before issuing ACP cancel while a prompt is in flight (explicit Stop vs noisy upstream errors). */
  pendingUserStopAbort: boolean;
}

/** Cursor ACP (Agent Communication Protocol) adapter implementing IAgentProvider via a MCP subprocess per session. */
@injectable()
export class CursorProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "cursor";
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "mutating" as const;
  readonly maxInputCharactersPerTurn = 4_000;

  private sessions = new Map<string, CursorAcpSessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  private pendingPermissions = new Map<string, PendingAcpPermission>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject(SkillService) private readonly skillService: SkillService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("JobObject") private readonly jobObject: JobObject,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
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

  /** Queues an ACP `session/prompt` on the session subprocess (serialized per thread). */
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

    const {
      sessionId,
      message,
      cwd,
      model,
      resume,
      permissionMode,
      attachments,
    } = params;

    const pm: "full" | "default" = permissionMode === "full" ? "full" : "default";
    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => this.evictIdleSessions(), EVICTION_INTERVAL_MS);
    }

    const settings = this.settingsService.get();
    let entry = this.sessions.get(sessionId);
    if (entry) {
      const dead =
        entry.child.exitCode != null ||
        entry.child.signalCode != null;
      const mismatch = entry.permissionMode !== pm || entry.cwd !== cwd;
      if (mismatch || dead) {
        await this.teardownSessionEntry(sessionId, entry, false);
        entry = undefined;
      }
    }

    if (!entry) {
      try {
        entry = await this.spawnChild(sessionId, threadId, cwd, pm, settings);
        this.sessions.set(sessionId, entry);

        if (this.pendingStops.delete(sessionId)) {
          logger.info("Pending stop consumed, tearing down new Cursor session", { sessionId });
          this.sessions.delete(sessionId);
          await this.teardownSessionEntry(sessionId, entry, false);
          this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
          return;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("Cursor ACP spawn failed", { sessionId, error: errMsg });
        this.emit("event", { type: AgentEventType.Error, threadId, error: errMsg } satisfies AgentEvent);
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
        return;
      }
    }

    entry.lastUsedAt = Date.now();
    const scheduled = entry.turnChain.then(() =>
      this.runTurn(entry!, { message, model, resume, attachments }),
    );
    entry.turnChain = scheduled.then(
      () => {},
      () => {},
    );
    await scheduled;
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Cancel the active ACP session. Records a pending stop if the session hasn't been created yet. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    this.cancelPendingForThread(sessionId);
    if (entry?.acpSessionId && entry.activeTurnState) {
      entry.pendingUserStopAbort = true;
    }
    if (entry?.acpSessionId) {
      void entry.connection.cancel({ sessionId: entry.acpSessionId }).catch(() => {});
    } else if (entry) {
      // Entry exists but ACP session hasn't opened yet; tear down immediately.
      const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
      this.sessions.delete(sessionId);
      void this.teardownSessionEntry(sessionId, entry, false);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
    } else {
      this.pendingStops.add(sessionId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /** Tear down all sessions, cancel pending permissions, and stop the eviction timer. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.drainAllPendingCancelled();
    for (const [id, entry] of this.sessions) {
      void this.teardownSessionEntry(id, entry, false);
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("CursorProvider shutdown complete");
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    try {
      this.emit("permission_resolved", { requestId, decision });
    } catch {
      /* ignore subscriber errors */
    }
    pending.resolve({ outcome: mapDecisionToAcpOutcome(decision, pending.options) });
    return true;
  }

  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const p of this.pendingPermissions.values()) {
      if (p.threadId === threadId) out.push(p.request);
    }
    return out;
  }

  /**
   * Invoked once the SkillWatcher debouncer finishes flushing filesystem events so
   * sticky Cursor preambles can pick up regenerated skill inventories.
   */
  onSkillRegistryDebouncedInvalidation(): void {
    for (const e of this.sessions.values()) {
      e.stickyHeavyInstructionsSent = false;
    }
  }

  private cancelPendingForThread(mcodeSessionId: string): void {
    for (const [requestId, p] of this.pendingPermissions) {
      if (p.mcodeSessionId !== mcodeSessionId) continue;
      this.pendingPermissions.delete(requestId);
      p.resolve({ outcome: { outcome: "cancelled" } });
      try {
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      } catch {
        /* ignore */
      }
    }
  }

  private drainAllPendingCancelled(): void {
    for (const [requestId, p] of this.pendingPermissions) {
      p.resolve({ outcome: { outcome: "cancelled" } });
      try {
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      } catch {
        /* ignore */
      }
    }
    this.pendingPermissions.clear();
  }

  private async spawnChild(
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
    settings: Settings,
  ): Promise<CursorAcpSessionEntry> {
    const cliCandidates = cursorCliProbeBinaries(settings);
    let lastErr: unknown = null;
    for (const cliPath of cliCandidates) {
      try {
        return await this.spawnOneCli(cliPath, mcodeSessionId, threadId, cwd, permissionMode);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (/Failed to spawn cursor-agent/i.test(msg)) continue;
        break;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "Failed to spawn cursor-agent (acp)"));
  }

  private async spawnOneCli(
    cliPath: string,
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
  ): Promise<CursorAcpSessionEntry> {
    const args = buildCursorAcpArgs({ permissionMode });
    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      shell: process.platform === "win32",
      env: this.envService.getEnv(),
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("Failed to spawn cursor-agent: stdio pipes unavailable");
    }

    if (child.pid) {
      this.jobObject.assign(child.pid);
      this.jobObject.setDescription(child.pid, "Mcode Agent: Cursor");
    }

    const out = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const inp = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(out, inp);

    const entry: Omit<CursorAcpSessionEntry, "connection"> & {
      connection?: CursorAcpSessionEntry["connection"];
    } = {
      mcodeSessionId,
      threadId,
      child,
      acpSessionId: "",
      cwd,
      permissionMode,
      lastUsedAt: Date.now(),
      todoSnapshot: createCursorTodoSnapshot(),
      turnChain: Promise.resolve(),
      activeTurnState: null,
      stickyHeavyInstructionsSent: false,
      cursorPromptOrdinal: 0,
      stderrTailLines: [],
      cursorModelAppliedPair: null,
      pendingUserStopAbort: false,
    };

    entry.connection = new ClientSideConnection(
      () => this.buildAcpClient(entry as CursorAcpSessionEntry),
      stream,
    ) as CursorAcpSessionEntry["connection"];

    const connection = entry.connection;

    child.stderr?.on("data", (chunk: Buffer) => {
      const verboseLogs = this.settingsService.get().provider.cursor.verboseFailureLogs;
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          if (verboseLogs) {
            logger.debug("cursor-agent acp stderr", { threadId, line: trimmed });
          }
          const tail = entry.stderrTailLines;
          tail.push(trimmed.slice(0, 2000));
          while (tail.length > CURSOR_STDERR_TAIL_MAX) tail.shift();
        }
      }
    });

    child.on("exit", () => {
      this.cancelPendingForThread(mcodeSessionId);
      this.sessions.delete(mcodeSessionId);
    });

    const initResult = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "mcode", title: "Mcode", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const authMethods = initResult.authMethods ?? [];
    const methodId =
      authMethods.find((m) => m.id === "cursor_login")?.id ?? authMethods[0]?.id;
    if (methodId) {
      await connection.authenticate({ methodId }).catch((err: unknown) => {
        logger.info("Cursor ACP authenticate noop", {
          threadId,
          error: String(err),
        });
      });
    }

    return entry as CursorAcpSessionEntry;
  }

  private buildAcpClient(entry: CursorAcpSessionEntry): Client {
    return {
      requestPermission: async (req) => this.bridgePermission(entry, req),
      sessionUpdate: async (params) => this.deliverSessionUpdate(entry, params),
      readTextFile: async (r) => ({ content: this.safeReadWorkspaceFile(entry.cwd, r.path) }),
      writeTextFile: async (r) => {
        this.safeWriteWorkspaceFile(entry.cwd, r.path, r.content);
        return {};
      },
      extMethod: async (method, params) => {
        const cursorPrefs = this.settingsService.get().provider.cursor;
        if (method === "cursor/ask_question") {
          const record =
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {};
          return buildCursorAskQuestionExtResponse(
            record,
            cursorPrefs.autoAnswerAskQuestions,
            (summary) => {
              logger.info("Cursor ask_question resolved automatically", {
                threadId: entry.threadId,
                detail: summary.lines,
              });
              if (cursorPrefs.echoAskQuestionsToTimeline) {
                const clip = summary.lines.join(" · ").slice(0, 900);
                this.emit("event", {
                  type: AgentEventType.System,
                  threadId: entry.threadId,
                  subtype: `cursor:ask_question:auto:${clip}`,
                } satisfies AgentEvent);
              }
            },
          );
        }
        if (method === "cursor/create_plan") {
          return { outcome: { outcome: "accepted" } };
        }
        if (method === "cursor/task" && entry.activeTurnState) {
          const record =
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {};
          const events = cursorTaskExtToAgentEvents(
            entry.threadId,
            record,
            entry.activeTurnState,
          );
          for (const ev of events) {
            this.emit("event", ev);
          }
          return {};
        }
        // cursor/update_todos arrives as a request (not notification) in the
        // ACP SDK dispatch. Handle it here so the task panel stays in sync.
        if (
          method === "cursor/update_todos" &&
          params !== null &&
          typeof params === "object" &&
          !Array.isArray(params)
        ) {
          const events = cursorUpdateTodosExtNotificationToAgentEvents(
            entry.threadId,
            params as Record<string, unknown>,
            entry.todoSnapshot,
          );
          for (const ev of events) {
            this.emit("event", ev);
          }
          return {};
        }
        logger.debug("Cursor ACP extMethod unhandled", {
          threadId: entry.threadId,
          method,
        });
        return {};
      },
      extNotification: async (method, params) => {
        if (
          method === "cursor/update_todos" &&
          params !== null &&
          typeof params === "object" &&
          !Array.isArray(params)
        ) {
          const events = cursorUpdateTodosExtNotificationToAgentEvents(
            entry.threadId,
            params as Record<string, unknown>,
            entry.todoSnapshot,
          );
          for (const ev of events) {
            this.emit("event", ev);
          }
          return;
        }
        void method;
        void params;
      },
    };
  }

  private async bridgePermission(
    entry: CursorAcpSessionEntry,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (entry.permissionMode === "full") {
      const optionId = pickFullAccessAllowOption(params.options);
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    }

    const requestId = randomUUID();
    const toolTitle = typeof params.toolCall.title === "string" ? params.toolCall.title : "Tool";
    const request = synthesizeCursorAcpPermissionRequest({
      requestId,
      threadId: entry.threadId,
      toolTitle,
      rawToolInput: params.toolCall.rawInput,
    });

    return await new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        mcodeSessionId: entry.mcodeSessionId,
        threadId: entry.threadId,
        options: params.options,
        request,
        resolve,
      });
      queueMicrotask(() => {
        try {
          this.emit("permission_request", request);
        } catch {
          /* ignore */
        }
      });
    });
  }

  private async deliverSessionUpdate(
    entry: CursorAcpSessionEntry,
    params: SessionNotification,
  ): Promise<void> {
    if (!entry.acpSessionId || params.sessionId !== entry.acpSessionId) return;
    const state = entry.activeTurnState;
    if (!state) return;

    const mapped = mapCursorAcpSessionNotification(
      params,
      entry.threadId,
      state,
      entry.todoSnapshot,
    );

    const cursorCfg = this.settingsService.get().provider.cursor;
    if (
      cursorCfg.traceSessionUpdates &&
      shouldEmitCursorSessionTrace(params, mapped.length)
    ) {
      logger.info("Cursor ACP session/update trace", {
        threadId: entry.threadId,
        mappedCount: mapped.length,
        notification: summarizeCursorSessionNotification(params),
        mappedEvents: summarizeEmittedAgentEventsForTrace(mapped),
      });
    }

    for (const ev of mapped) {
      this.emit("event", ev);
    }
  }

  private safeReadWorkspaceFile(cwd: string, filePath: string): string {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return "";
    try {
      if (!existsSync(resolved)) return "";
      return readFileSync(resolved, "utf-8");
    } catch {
      return "";
    }
  }

  private safeWriteWorkspaceFile(cwd: string, filePath: string, content: string): void {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Path outside workspace root");
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, content, "utf-8");
  }

  /** Ensures `entry.acpSessionId` is ready (new or load). */
  private async openLogicalSession(entry: CursorAcpSessionEntry, resume: boolean): Promise<void> {
    if (entry.acpSessionId) return;

    const stored = this.sdkSessionIds.get(entry.mcodeSessionId);
    let acpId: string;

    if (resume && stored) {
      try {
        await entry.connection.loadSession({
          cwd: entry.cwd,
          mcpServers: [],
          sessionId: stored,
        });
        acpId = stored;
      } catch (err) {
        logger.info("Cursor ACP loadSession failed; new session", {
          threadId: entry.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        const created = await entry.connection.newSession({
          cwd: entry.cwd,
          mcpServers: [],
        });
        acpId = created.sessionId;
      }
    } else {
      const created = await entry.connection.newSession({
        cwd: entry.cwd,
        mcpServers: [],
      });
      acpId = created.sessionId;
    }

    entry.acpSessionId = acpId;
    this.sdkSessionIds.set(entry.mcodeSessionId, acpId);
    this.emit("event", {
      type: AgentEventType.System,
      threadId: entry.threadId,
      subtype: `sdk_session_id:${acpId}`,
    } satisfies AgentEvent);
  }

  private async applyModel(entry: CursorAcpSessionEntry, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed || !entry.acpSessionId) return;

    const paired = entry.cursorModelAppliedPair;
    if (
      paired &&
      paired.acpSessionId === entry.acpSessionId &&
      paired.modelId === trimmed
    ) {
      return;
    }

    try {
      await entry.connection.unstable_setSessionModel({
        sessionId: entry.acpSessionId,
        modelId: trimmed,
      });
      entry.cursorModelAppliedPair = { acpSessionId: entry.acpSessionId, modelId: trimmed };
    } catch (err: unknown) {
      entry.cursorModelAppliedPair = null;
      logger.debug("Cursor ACP setSessionModel noop", {
        threadId: entry.threadId,
        error: String(err),
      });
    }
  }

  private async runTurn(
    entry: CursorAcpSessionEntry,
    opts: {
      message: string;
      model: string;
      resume: boolean;
      attachments?: AttachmentMeta[];
    },
  ): Promise<void> {
    const { message, model, resume, attachments } = opts;
    const cursorCfg = this.settingsService.get().provider.cursor;
    try {
      await this.openLogicalSession(entry, resume);
      await this.applyModel(entry, model);

      entry.stderrTailLines.length = 0;

      entry.cursorPromptOrdinal += 1;
      if (
        !cursorCfg.alwaysSendFullInstructions &&
        cursorCfg.fullPreambleEveryNTurns > 0 &&
        entry.cursorPromptOrdinal % cursorCfg.fullPreambleEveryNTurns === 0
      ) {
        entry.stickyHeavyInstructionsSent = false;
      }

      const guidance = buildCursorAgentGuidanceMarkdown(entry.cwd);
      const skillsBlock = formatCursorSkillsAndCommandsForPrompt(
        this.skillService.list(entry.cwd, "cursor"),
      );
      const instructionParts = [guidance, skillsBlock].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      const combined =
        instructionParts.length > 0 ? instructionParts.join("\n\n---\n\n") : undefined;

      let instructionMarkdown: string | undefined;

      if (cursorCfg.alwaysSendFullInstructions) {
        instructionMarkdown = combined ?? readCursorUserInstructions();
      } else {
        const { instructionMarkdown: blob, markHeavyCommitted } = resolveCursorStickyInstructionBlob({
          combinedGuidanceAndSkillsMarkdown: combined,
          readFallbackAgents: readCursorUserInstructions,
          stickyHeavyCommitted: entry.stickyHeavyInstructionsSent,
        });
        instructionMarkdown = blob;
        if (markHeavyCommitted) {
          entry.stickyHeavyInstructionsSent = true;
        }
      }

      const blocks = buildCursorAcpPromptBlocks(message, attachments, instructionMarkdown);

      const maxAttempts = cursorCfg.retryTransientFailuresOnce ? 2 : 1;
      let promptResponse: Awaited<ReturnType<ClientSideConnection["prompt"]>>;
      let attempt = 0;
      for (;;) {
        try {
          attempt += 1;
          entry.activeTurnState = createCursorAcpTurnState();
          promptResponse = await entry.connection.prompt({
            sessionId: entry.acpSessionId,
            prompt: blocks,
          });
          break;
        } catch (attemptErr) {
          const raw = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
          // Do not retry after explicit Stop; cancel-like errors are expected and a
          // second prompt would fight the user's abort.
          if (entry.pendingUserStopAbort) {
            throw attemptErr;
          }
          if (
            attempt >= maxAttempts ||
            !cursorCfg.retryTransientFailuresOnce ||
            !isLikelyTransientCursorPromptFailure(raw)
          ) {
            throw attemptErr;
          }
          logger.warn("Cursor ACP prompt retry after transient CLI failure", {
            threadId: entry.threadId,
            attempt,
            error: raw,
          });
        }
      }

      const text = resolveCursorAssistantMessageContent(entry.activeTurnState.accumulator);
      if (text.length > 0) {
        this.emit("event", {
          type: AgentEventType.Message,
          threadId: entry.threadId,
          content: text,
          tokens: null,
        } satisfies AgentEvent);
      }

      const usage = promptResponse.usage;
      this.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: entry.threadId,
        reason: promptResponse.stopReason,
        costUsd: null,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
        providerId: "cursor",
      } satisfies AgentEvent);

      this.emit("event", { type: AgentEventType.Ended, threadId: entry.threadId } satisfies AgentEvent);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const userStoppedStream =
        entry.pendingUserStopAbort && looksLikeUpstreamStreamCancel(errMsg);
      const stderrTail =
        cursorCfg.verboseFailureLogs && entry.stderrTailLines.length > 0
          ? entry.stderrTailLines.slice(-16)
          : undefined;
      if (!userStoppedStream) {
        logger.error("Cursor ACP prompt failed", {
          threadId: entry.threadId,
          stickyHeavyCommitted: entry.stickyHeavyInstructionsSent,
          promptOrdinal: entry.cursorPromptOrdinal,
          acpSessionId: entry.acpSessionId,
          verboseFailureLogs: cursorCfg.verboseFailureLogs,
          stderrTail,
          error: errMsg,
        });
        this.emit("event", {
          type: AgentEventType.Error,
          threadId: entry.threadId,
          error: errMsg,
        } satisfies AgentEvent);
      } else {
        logger.info("Cursor prompt ended after Stop (stream cancel)", {
          threadId: entry.threadId,
          errorSample: errMsg.slice(0, 200),
        });
        const interrupted =
          entry.activeTurnState?.accumulator !== undefined
            ? resolveCursorAssistantMessageContent(entry.activeTurnState.accumulator).trim()
            : "";
        if (interrupted.length > 0) {
          this.emit("event", {
            type: AgentEventType.Message,
            threadId: entry.threadId,
            content: interrupted,
            tokens: null,
          } satisfies AgentEvent);
        }
      }
      this.emit("event", { type: AgentEventType.Ended, threadId: entry.threadId } satisfies AgentEvent);
    } finally {
      entry.activeTurnState = null;
      entry.pendingUserStopAbort = false;
    }
  }

  private async teardownSessionEntry(
    mcodeSessionId: string,
    entry: CursorAcpSessionEntry,
    clearStoredSdkId: boolean,
  ): Promise<void> {
    this.cancelPendingForThread(mcodeSessionId);
    entry.pendingUserStopAbort = false;
    if (entry.acpSessionId) {
      await entry.connection.cancel({ sessionId: entry.acpSessionId }).catch(() => {});
    }
    try {
      entry.child.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === "win32" && entry.child.pid) {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill",
          ["/T", "/F", "/PID", String(entry.child.pid)],
          () => resolve(),
        );
      });
    }
    if (clearStoredSdkId) {
      this.sdkSessionIds.delete(mcodeSessionId);
    }
  }

  private sessionHasPendingPermissions(mcodeSessionId: string): boolean {
    for (const p of this.pendingPermissions.values()) {
      if (p.mcodeSessionId === mcodeSessionId) return true;
    }
    return false;
  }

  /**
   * Runs two hidden prompt/reply pairs on the parent thread's active Cursor session
   * to extract a handoff summary without surfacing them in the UI.
   *
   * The four persisted messages (isInternal=true) form a bracket:
   *   user: handoff prompt -> assistant: handoff reply
   *   user: disregard instruction -> assistant: ack
   *
   * Returns the handoff reply text (the assistant response to the handoff prompt).
   */
  async runHiddenTurn(args: {
    parentThreadId: string;
    prompt: string;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { parentThreadId, prompt, abortSignal } = args;
    const sessionKey = `mcode-${parentThreadId}`;
    const entry = this.sessions.get(sessionKey);
    if (!entry) {
      throw new Error(`No active Cursor session for parent thread: ${parentThreadId}`);
    }

    // Wait for any in-flight real turn to settle before injecting hidden turns.
    // Without this, runRawPrompt's `entry.activeTurnState = turnState` assignment
    // would clobber the in-flight turn's state, corrupting the real turn's output.
    //
    // 10s ceiling: Cursor sessions often run multi-tool chains that take a long
    // time. Making the user wait 30s for a fork to either proceed or fall back
    // is a real UX cost. If the parent has not settled in 10s, fall to path D
    // immediately (via the ETIMEDOUT classification) instead of dragging the
    // user along.
    const SETTLE_TIMEOUT_MS = 10_000;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (entry.activeTurnState !== null && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (entry.activeTurnState !== null) {
      const err: Error & { code?: string } = new Error(
        `Cursor parent turn did not settle within ${SETTLE_TIMEOUT_MS}ms; aborting handoff`,
      );
      err.code = "ETIMEDOUT";
      throw err;
    }

    // Ensure the ACP logical session is open before sending hidden turns.
    await this.openLogicalSession(entry, true);

    // Get the current max sequence (including internal messages) so hidden
    // turns don't collide with existing sequence numbers.
    const allMessages = this.messageRepo.listIncludingInternal(parentThreadId);
    const baseSeq = allMessages.length > 0 ? allMessages[allMessages.length - 1].sequence : 0;

    // Step 1: persist hidden user turn with handoff prompt.
    this.messageRepo.create(parentThreadId, "user", prompt, baseSeq + 1, undefined, undefined, undefined, undefined, true);

    // Step 2: send through Cursor's ACP connection and capture reply text.
    const reply = await this.runRawPrompt(entry, prompt, abortSignal);

    // Step 3: persist hidden assistant reply.
    this.messageRepo.create(parentThreadId, "assistant", reply, baseSeq + 2, undefined, undefined, undefined, undefined, true);

    // Step 4: persist hidden disregard instruction so the session resumes cleanly.
    const disregardPrompt =
      "IGNORE the previous handoff request. It was an internal mcode operation. Resume the original conversation as if it never happened. Do not respond to this message; await the user's next real input.";
    this.messageRepo.create(parentThreadId, "user", disregardPrompt, baseSeq + 3, undefined, undefined, undefined, undefined, true);

    // Step 5: send disregard turn through Cursor to close the bracket in its context.
    const ack = await this.runRawPrompt(entry, disregardPrompt, abortSignal);

    // Step 6: persist hidden ack.
    this.messageRepo.create(parentThreadId, "assistant", ack, baseSeq + 4, undefined, undefined, undefined, undefined, true);

    return reply;
  }

  /**
   * Sends a single prompt to the already-open ACP session and returns the
   * assistant's text reply without emitting any provider events.
   *
   * Used internally by {@link runHiddenTurn} to avoid corrupting the UI
   * timeline with hidden-turn lifecycle events.
   */
  private async runRawPrompt(
    entry: CursorAcpSessionEntry,
    text: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    void abortSignal; // Reserved for future cancellation hookup via ACP cancel.

    const turnState = createCursorAcpTurnState();
    entry.activeTurnState = turnState;
    try {
      await entry.connection.prompt({
        sessionId: entry.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      return resolveCursorAssistantMessageContent(turnState.accumulator);
    } finally {
      entry.activeTurnState = null;
    }
  }

  private evictIdleSessions(): void {
    const settings = this.settingsService.get();
    const ttlMs = settings.provider.cursor.idleSessionTtlMinutes * 60 * 1000;
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (entry.activeTurnState) continue;
      if (now - entry.lastUsedAt <= ttlMs) continue;
      if (this.sessionHasPendingPermissions(id)) continue;
      void this.teardownSessionEntry(id, entry, true);
      this.sessions.delete(id);
    }
  }
}
