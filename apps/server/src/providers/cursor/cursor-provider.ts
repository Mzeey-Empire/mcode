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
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
  synthesizeCursorAcpPermissionRequest,
} from "./cursor-acp-permission-mapper.js";

const IDLE_TTL_MS = 10 * 60 * 1000;
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
}

@injectable()
export class CursorProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "cursor";
  readonly supportsCompletion = false;

  private sessions = new Map<string, CursorAcpSessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingAcpPermission>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject(SkillService) private readonly skillService: SkillService,
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

  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    this.cancelPendingForThread(sessionId);
    if (!entry?.acpSessionId) return;
    void entry.connection.cancel({ sessionId: entry.acpSessionId }).catch(() => {});
  }

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
      env: { ...process.env },
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("Failed to spawn cursor-agent: stdio pipes unavailable");
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
    };

    entry.connection = new ClientSideConnection(
      () => this.buildAcpClient(entry as CursorAcpSessionEntry),
      stream,
    ) as CursorAcpSessionEntry["connection"];

    const connection = entry.connection;

    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) logger.debug("cursor-agent acp stderr", { threadId, line: trimmed });
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
        if (method === "cursor/ask_question") {
          return {
            outcome: {
              outcome: "skipped",
              reason: "Mcode ACP client does not surface interactive questions.",
            },
          };
        }
        if (method === "cursor/create_plan") {
          return { outcome: { outcome: "accepted" } };
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
    for (const ev of mapped) {
      this.emit("event", ev);
    }
  }

  private safeReadWorkspaceFile(cwd: string, filePath: string): string {
    const resolved = path.resolve(filePath);
    const root = path.resolve(cwd);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return "";
    try {
      if (!existsSync(resolved)) return "";
      return readFileSync(resolved, "utf-8");
    } catch {
      return "";
    }
  }

  private safeWriteWorkspaceFile(cwd: string, filePath: string, content: string): void {
    const resolved = path.resolve(filePath);
    const root = path.resolve(cwd);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return;
    try {
      mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, "utf-8");
    } catch {
      /* tool layer records failure */
    }
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
    await entry.connection
      .unstable_setSessionModel({
        sessionId: entry.acpSessionId,
        modelId: trimmed,
      })
      .catch((err: unknown) => {
        logger.debug("Cursor ACP setSessionModel noop", {
          threadId: entry.threadId,
          error: String(err),
        });
      });
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
    entry.activeTurnState = createCursorAcpTurnState();
    try {
      await this.openLogicalSession(entry, resume);
      await this.applyModel(entry, model);

      const guidance = buildCursorAgentGuidanceMarkdown(entry.cwd);
      const skillsBlock = formatCursorSkillsAndCommandsForPrompt(
        this.skillService.list(entry.cwd, "cursor"),
      );
      const instructionParts = [guidance, skillsBlock].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      const instructions =
        instructionParts.length > 0
          ? instructionParts.join("\n\n---\n\n")
          : readCursorUserInstructions();
      const blocks = buildCursorAcpPromptBlocks(message, attachments, instructions);
      const promptResponse = await entry.connection.prompt({
        sessionId: entry.acpSessionId,
        prompt: blocks,
      });

      const text = entry.activeTurnState.accumulator.assistantText.trim();
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
      logger.error("Cursor ACP prompt failed", { threadId: entry.threadId, error: errMsg });
      this.emit("event", {
        type: AgentEventType.Error,
        threadId: entry.threadId,
        error: errMsg,
      } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId: entry.threadId } satisfies AgentEvent);
    } finally {
      entry.activeTurnState = null;
    }
  }

  private async teardownSessionEntry(
    mcodeSessionId: string,
    entry: CursorAcpSessionEntry,
    clearStoredSdkId: boolean,
  ): Promise<void> {
    this.cancelPendingForThread(mcodeSessionId);
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

  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt <= IDLE_TTL_MS) continue;
      if (this.sessionHasPendingPermissions(id)) continue;
      void this.teardownSessionEntry(id, entry, true);
      this.sessions.delete(id);
    }
  }
}
