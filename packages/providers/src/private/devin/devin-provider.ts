import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import which from "which";
import type { Provider, ProviderIdentity } from "@mcode/agent-model";
import {
  AgentEventType,
  DEVIN_STATIC_MODEL_FALLBACK,
  getCatalogEntry,
  groupDevinModelFamilies,
  providerRuntimeEvent,
  resolveDevinModelId,
  type AgentEvent,
  type DevinMode,
  type IAgentProvider,
  type ISessionEvictable,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionResponseAnswers,
  type DevinModelFamily,
  type ProviderModelInfo,
  type SessionForker,
  type Settings,
  type TurnRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { ProviderHostPorts } from "../../host-ports.js";
import { SessionRuntime, type SpawnArgs, type SpawnResult } from "../session-runtime.js";
import { AcpSessionRuntime } from "../protocols/acp/acp-session-runtime.js";
import type {
  AcpPermissionRequest,
  AcpPermissionOutcome,
  AcpSessionUpdate,
} from "../protocols/acp/acp-session-types.js";
import { resolveDevinAcpCredentials } from "./devin-credentials.js";
import { DevinCanonicalEventPublisher, type DevinCanonicalEventRouting } from "./devin-canonical-event-publisher.js";
import {
  createDevinAcpTurnState,
  devinPermissionPreview,
  mapDevinAcpSessionNotification,
  observeDevinExtensionNotification,
} from "./devin-acp-event-mapper.js";
import type { DevinAcpSessionEntry } from "./devin-session-state.js";

const STDERR_TAIL_MAX = 48;
const WORKSPACE_FILE_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Server-owned authorities required by the Devin Provider. */
export interface DevinProviderPorts {
  settings: {
    get(): Settings;
  };
}

interface DevinPendingPermission {
  entry: DevinAcpSessionEntry;
  request: PermissionRequest;
  /** Raw ACP options, retained so `optionId` and `kind` survive to the reply. */
  acpOptions: readonly { optionId: string; kind?: string | null }[];
  resolve: (outcome: AcpPermissionOutcome) => void;
}

/** Resolves the native Devin mode for one turn. */
function resolveDevinMode(req: TurnRequest<"devin">): DevinMode {
  if (req.interactionMode === "plan") return "plan";
  return req.providerOptions.mode
    ?? (req.permissionMode === "full" ? "bypass" : "normal");
}

/**
 * Candidate option ids/kinds per generic decision, in preference order.
 * A candidate matches either `optionId` or `kind` on an ACP option.
 */
const DECISION_OPTION_CANDIDATES: Partial<Record<PermissionDecision, readonly string[]>> = {
  deny: ["reject_once", "reject_always"],
  "allow-session": ["allow_session", "allow_always", "allow_once"],
  allow: ["allow_once"],
};

/** Resolves which permission option id a generic decision maps to. */
function resolveOptionIdForDecision(
  options: readonly { optionId: string; kind?: string | null }[],
  decision: PermissionDecision,
): string | undefined {
  for (const candidate of DECISION_OPTION_CANDIDATES[decision] ?? []) {
    const hit = options.find(
      (option) => option.optionId === candidate || option.kind === candidate,
    );
    if (hit) return hit.optionId;
  }
  return decision === "allow" ? options[0]?.optionId : undefined;
}

/**
 * Devin provider over `devin acp` (newline-delimited JSON-RPC, ACP).
 *
 * Owns one long-lived `devin acp` child per Mcode session. Devin's mode axis
 * (normal/accept-edits/smart/bypass/plan) is session-scoped configuration, not
 * a spawn flag, so mode changes never respawn the process. File reads and
 * writes run client-side, scoped to the session worktree.
 */
export class DevinProvider extends NodeEvents.EventEmitter implements IAgentProvider, ISessionEvictable {
  readonly id = "devin" as const;
  readonly descriptor: Provider = {
    id: "devin",
    capabilities: [
      { name: "build", support: "supported" },
      { name: "plan", support: "supported" },
      { name: "permissions", support: "supported" },
      { name: "usage", support: "supported" },
      { name: "session-eviction", support: "supported" },
      { name: "provider-continuation", support: "supported" },
      { name: "orchestration", support: "supported" },
    ],
  };
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "unsupported" as const;
  readonly maxInputCharactersPerTurn = 16_000;
  readonly forker: SessionForker;

  private readonly sessions: SessionRuntime<DevinAcpSessionEntry>;
  private readonly canonicalEvents: DevinCanonicalEventPublisher;
  private readonly pendingTurnRoutings = new Map<string, DevinCanonicalEventRouting>();
  private readonly pendingPermissions = new Map<string, DevinPendingPermission>();
  private modelsCache: Promise<{ models: ProviderModelInfo[]; families: DevinModelFamily[] }> | null = null;
  /** Seeded from the static fallback so `applyModel` never blocks on a probe. */
  private devinFamilies: DevinModelFamily[] =
    groupDevinModelFamilies(DEVIN_STATIC_MODEL_FALLBACK).families;

  constructor(
    private readonly host: ProviderHostPorts,
    private readonly devin: DevinProviderPorts,
    idleSessionTtlMs: number,
  ) {
    super();
    this.canonicalEvents = new DevinCanonicalEventPublisher(host.events);
    this.forker = {
      fork: async (request) => {
        const markdown = await this.runSideChannelQuery({
          prompt: request.prompt,
          conversationHistory: request.conversationHistory,
          cwd: request.cwd,
        });
        return {
          markdown,
          meta: {
            schemaVersion: 1,
            parentThreadId: request.parentThreadId,
            forkedFromMessageId: request.forkedFromMessageId,
            forkAnchorRole: request.forkAnchorRole,
            childThreadId: request.childThreadId,
            generatedBy: "provider",
            provider: request.parentThread.provider,
            ladderStep: "B",
            mode: "full",
            generatedAt: new Date().toISOString(),
            characterCount: markdown.length,
            parentSdkSessionId: request.parentThread.sdk_session_id ?? null,
            providerErrorOnGenerate: null,
            regenerationHistory: [],
            attachments: [],
            ...(request.historyBudget && { historyBudget: request.historyBudget }),
          },
        };
      },
    };
    this.sessions = new SessionRuntime<DevinAcpSessionEntry>(
      {
        spawn: (args) => this.spawnSession(args),
        isBusy: (state) => state.activeTurnState !== null,
        interrupt: async (state) => {
          state.pendingUserStopAbort = true;
          this.cancelPendingPermissionsForSession(state.mcodeSessionId);
          await state.acpRuntime.cancel().catch(() => undefined);
        },
        close: async (state) => {
          this.cancelPendingPermissionsForSession(state.mcodeSessionId);
          await state.acpRuntime.close().catch(() => undefined);
        },
        isStale: (state, args) => state.cwd !== args.cwd,
      },
      {
        jobObject: { isWindowsJob: host.runtime.platform === "win32", assign: () => false, setDescription: () => {} },
        processes: host.processes,
        envService: { getEnv: () => ({ ...host.environment.snapshot() }) },
        idleTtlMs: idleSessionTtlMs,
        logger,
      },
    );
  }

  // ---------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------

  /**
   * Lists Devin's account-scoped model catalog by opening a throwaway ACP
   * session and reading its `configOptions` model select. Falls back to a
   * static list when the probe cannot run.
   */
  async listModels(): Promise<ProviderModelInfo[]> {
    const { models } = await this.modelCatalog();
    return models;
  }

  /**
   * Devin encodes reasoning effort inside the model id (`swe-2-high`), so the
   * catalog is grouped into effort-carrying families before it reaches the UI.
   * The family map is retained for {@link applyModel} to recompose wire ids.
   */
  private modelCatalog(): Promise<{ models: ProviderModelInfo[]; families: DevinModelFamily[] }> {
    this.modelsCache ??= this.probeDevinModels()
      .then((rows) => groupDevinModelFamilies(rows))
      .catch((error: unknown) => {
        logger.warn("Devin model discovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { models: [] as ProviderModelInfo[], families: [] as DevinModelFamily[] };
      })
      .then((grouped) => {
        const resolved = grouped.models.length > 0
          ? grouped
          : groupDevinModelFamilies(DEVIN_STATIC_MODEL_FALLBACK);
        this.devinFamilies = resolved.families;
        return resolved;
      });
    return this.modelsCache;
  }

  private async probeDevinModels(): Promise<ProviderModelInfo[]> {
    const env = this.host.environment.snapshot();
    // child_process.spawn reports a missing binary through an `error` event the
    // ACP runtime never observes, which crashes the host; bail before spawning.
    const cliPath = await which(this.cliPath(), { nothrow: true });
    if (!cliPath) return [];
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: cliPath,
        args: ["acp"],
        cwd: NodeOS.tmpdir(),
        env: { ...env },
        shell: this.host.runtime.platform === "win32",
      },
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async () => {},
      },
      selectAuthMethod: () => undefined,
      processes: this.host.processes,
    });
    try {
      await runtime.initialize();
      await this.authenticate(runtime, env);
      const created = await runtime.state.connection.newSession({
        cwd: NodeOS.tmpdir(),
        mcpServers: [],
      });
      const modelOption = created.configOptions?.find(
        (option: { id: string }) => option.id === "model",
      ) as { type: string; options?: unknown[] } | undefined;
      if (!modelOption || modelOption.type !== "select" || !modelOption.options) return [];
      // ACP select options may be flat values or named groups of values.
      const values = (modelOption.options as Record<string, unknown>[]).flatMap(
        (option) => typeof option.value === "string"
          ? [option]
          : (option.options as Record<string, unknown>[] | undefined) ?? [],
      );
      return values
        .map((option: Record<string, unknown>) => ({
          id: String(option.value ?? ""),
          name: String(option.name ?? option.value ?? ""),
          group: inferDevinModelGroup(String(option.value ?? "")),
        }))
        .filter((model: ProviderModelInfo) => model.id.length > 0);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------
  // Turn dispatch
  // ---------------------------------------------------------------------

  /** Queues an ACP `session/prompt` on the thread's Devin session. */
  async sendTurn(req: TurnRequest<"devin">): Promise<void> {
    const routing: DevinCanonicalEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.pendingTurnRoutings.set(req.sessionId, routing);
    try {
      const entry = await this.sessions.acquire({
        sessionId: req.sessionId,
        threadId: req.threadId,
        cwd: req.cwd,
        permissionMode: req.permissionMode,
        resumeFrom: req.resumeFrom,
      });
      entry.devinMode = resolveDevinMode(req);
      const run = entry.turnChain.then(() => this.executeTurn(entry, req, routing));
      entry.turnChain = run.then(() => undefined, () => undefined);
      await run;
    } finally {
      this.pendingTurnRoutings.delete(req.sessionId);
    }
  }

  private async executeTurn(
    entry: DevinAcpSessionEntry,
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): Promise<void> {
    const resume = req.resumeFrom !== undefined;
    const storedAcpId = resume ? req.resumeFrom : undefined;
    if (resume && storedAcpId && !entry.acpSessionId) {
      entry.acpSessionId = storedAcpId;
      entry.replayTurnState = createDevinAcpTurnState();
    }
    await this.ensureSession(entry, req);
    await this.applyModel(entry, req);
    await this.applyMode(entry, entry.devinMode);

    const turnState = createDevinAcpTurnState();
    entry.activeTurnState = turnState;
    this.emit("turn_started", { sessionId: entry.mcodeSessionId });
    try {
      const response = await entry.acpRuntime.prompt<{ stopReason?: string; usage?: Record<string, number> }>({
        prompt: buildPromptBlocks(req),
      });
      this.emitSuccessfulTurn(entry, response, req, routing);
      this.emit("turn_complete", { sessionId: entry.mcodeSessionId });
    } catch (error) {
      this.emitFailedTurn(entry, error, req, routing);
    } finally {
      entry.activeTurnState = null;
      entry.pendingUserStopAbort = false;
      await this.canonicalEvents.waitForExecution(routing).catch(() => undefined);
    }
  }

  private async ensureSession(entry: DevinAcpSessionEntry, req: TurnRequest<"devin">): Promise<void> {
    if (entry.acpSessionId && entry.acpRuntime.state.sessionId === entry.acpSessionId) return;
    const opened = await entry.acpRuntime.openSession({
      resumeFrom: entry.acpSessionId || req.resumeFrom,
      cwd: entry.cwd,
      mcpServers: [],
    });
    entry.acpSessionId = opened.sessionId;
    // Persists the resume cursor (`threads.sdk_session_id`) so session/load
    // works across app restarts.
    this.publishEntryEvent(entry, this.pendingTurnRoutings.get(entry.mcodeSessionId), {
      type: AgentEventType.System,
      threadId: entry.threadId,
      subtype: `sdk_session_id:${opened.sessionId}`,
    });
  }

  /**
   * Applies the requested model via `session/set_config_option`, deduped per
   * session. The composer stores the family id (`swe-2`) plus a reasoning
   * level; the concrete Devin id (`swe-2-high`) is recomposed here.
   */
  private async applyModel(entry: DevinAcpSessionEntry, req: TurnRequest<"devin">): Promise<void> {
    const model = resolveDevinModelId(this.devinFamilies, req.model, req.reasoningLevel);
    if (!model.trim()) return;
    const pair = entry.modelAppliedPair;
    if (pair && pair.acpSessionId === entry.acpSessionId && pair.modelId === model) return;
    try {
      await entry.acpRuntime.state.connection.setSessionConfigOption({
        sessionId: entry.acpRuntime.state.sessionId,
        configId: "model",
        value: model,
      });
      entry.modelAppliedPair = { acpSessionId: entry.acpSessionId, modelId: model };
    } catch (error) {
      logger.warn("Devin set_config_option model failed", {
        threadId: entry.threadId,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Applies the resolved native Devin mode via `session/set_config_option`.
   * Devin scopes mode to the logical session, so switching modes — including
   * leaving plan mode — never respawns the process.
   */
  private async applyMode(entry: DevinAcpSessionEntry, mode: DevinMode): Promise<void> {
    const pair = entry.modeAppliedPair;
    if (pair && pair.acpSessionId === entry.acpSessionId && pair.mode === mode) return;
    try {
      await entry.acpRuntime.state.connection.setSessionConfigOption({
        sessionId: entry.acpRuntime.state.sessionId,
        configId: "mode",
        value: mode,
      });
      entry.modeAppliedPair = { acpSessionId: entry.acpSessionId, mode };
    } catch (error) {
      logger.warn("Devin set_config_option mode failed", {
        threadId: entry.threadId,
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitSuccessfulTurn(
    entry: DevinAcpSessionEntry,
    response: { stopReason?: string; usage?: Record<string, number> },
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): void {
    const text = resolveAssistantText(entry.activeTurnState);
    if (text.length > 0) {
      this.publishEntryEvent(entry, routing, {
        type: AgentEventType.Message,
        threadId: entry.threadId,
        content: text,
        tokens: null,
      });
    }
    const usage = response.usage ?? {};
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.TurnComplete,
      threadId: entry.threadId,
      reason: response.stopReason ?? "end_turn",
      costUsd: null,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      ...(typeof usage.totalTokens === "number" ? { totalProcessedTokens: usage.totalTokens } : {}),
      ...(typeof usage.cachedReadTokens === "number" ? { cacheReadTokens: usage.cachedReadTokens } : {}),
      providerId: this.id,
    });
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId: req.turnExecutionId,
    });
  }

  private emitFailedTurn(
    entry: DevinAcpSessionEntry,
    error: unknown,
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const interrupted = resolveAssistantText(entry.activeTurnState);
    if (entry.pendingUserStopAbort || /cancel/i.test(errorMessage)) {
      if (interrupted.length > 0) {
        this.publishEntryEvent(entry, routing, {
          type: AgentEventType.Message,
          threadId: entry.threadId,
          content: interrupted,
          tokens: null,
        });
      }
    } else {
      logger.error("Devin ACP prompt failed", {
        threadId: entry.threadId,
        acpSessionId: entry.acpSessionId,
        stderrTail: entry.stderrTailLines.slice(-16),
        error: errorMessage,
      });
      this.publishEntryEvent(entry, routing, {
        type: AgentEventType.Error,
        threadId: entry.threadId,
        error: errorMessage,
      });
    }
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId: req.turnExecutionId,
    });
  }

  // ---------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------

  /** Resolves a pending permission request for the given request id. */
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    _answers?: PermissionResponseAnswers,
    optionId?: string,
  ): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve(this.outcomeForDecision(pending.acpOptions, decision, optionId));
    const selectedKind = optionId
      ? pending.acpOptions.find((option) => option.optionId === optionId)?.kind
      : undefined;
    const resolvedDecision = selectedKind?.startsWith("reject") ? "deny" : decision;
    this.emit("permission_resolved", { requestId, decision: resolvedDecision });
    return true;
  }

  /** Returns all pending permission requests for a given thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    return [...this.pendingPermissions.values()]
      .filter((pending) => pending.request.threadId === threadId)
      .map((pending) => pending.request);
  }

  private outcomeForDecision(
    options: readonly { optionId: string; kind?: string | null }[],
    decision: PermissionDecision,
    optionId?: string,
  ): AcpPermissionOutcome {
    if (decision === "cancelled") return { outcome: { outcome: "cancelled" } };
    const selectedId = optionId && options.some((option) => option.optionId === optionId)
      ? optionId
      : resolveOptionIdForDecision(options, decision);
    if (!selectedId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: selectedId } };
  }

  private async requestPermission(
    entry: DevinAcpSessionEntry,
    params: AcpPermissionRequest,
  ): Promise<AcpPermissionOutcome> {
    const options = params.options ?? [];
    if (entry.devinMode === "bypass") {
      const allow = resolveOptionIdForDecision(options, "allow");
      return allow
        ? { outcome: { outcome: "selected", optionId: allow } }
        : { outcome: { outcome: "cancelled" } };
    }

    const request = this.buildPermissionRequest(entry, params, options);
    const outcomePromise = new Promise<AcpPermissionOutcome>((resolve) => {
      this.pendingPermissions.set(request.requestId, { entry, request, acpOptions: options, resolve });
    });
    this.emit("permission_request", request);
    return outcomePromise;
  }

  private buildPermissionRequest(
    entry: DevinAcpSessionEntry,
    params: AcpPermissionRequest,
    options: readonly { optionId: string; kind?: string | null; name: string }[],
  ): PermissionRequest {
    const snapshot = entry.activeTurnState?.toolCallById.get(params.toolCall.toolCallId);
    const command = devinPermissionPreview(params.toolCall);
    return {
      requestId: crypto.randomUUID(),
      threadId: entry.threadId,
      toolName: snapshot?.toolName ?? "Tool",
      input: {
        ...snapshot?.input,
        ...(command ? { command } : {}),
      },
      ...(snapshot?.title ? { title: snapshot.title } : {}),
      options: options.map((option) => ({
        id: option.optionId,
        label: option.name,
        ...(option.kind ? { kind: option.kind } : {}),
      })),
    };
  }

  private cancelPendingPermissionsForSession(mcodeSessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.entry.mcodeSessionId !== mcodeSessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit("permission_resolved", { requestId, decision: "cancelled" });
    }
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  /** Cancels the in-flight prompt and lets the session stay warm. */
  async stopSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pendingUserStopAbort = true;
    this.cancelPendingPermissionsForSession(sessionId);
    await entry.acpRuntime.cancel().catch(() => undefined);
    await entry.turnChain.catch(() => undefined);
  }

  /** Force-discards the pooled session so the next turn spawns fresh. */
  async discardSession(sessionId: string): Promise<void> {
    await this.sessions.stop(sessionId);
  }

  /** Evicts all non-busy pooled sessions (memory pressure). */
  async evictNonBusy(reason: string): Promise<{ before: number; after: number; evicted: string[] }> {
    return this.sessions.evictNonBusy(reason);
  }

  /** Tears down every Devin session. */
  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }

  /**
   * Runs a throwaway Devin ACP session for handoff generation. A fresh session
   * is used rather than `session/load` because loading the parent resumes it
   * in place; Devin has no fork primitive.
   */
  async runSideChannelQuery(args: {
    prompt: string;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    const env = this.host.environment.snapshot();
    let text = "";
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: this.cliPath(),
        args: ["acp"],
        cwd: args.cwd,
        env: { ...env },
        shell: this.host.runtime.platform === "win32",
      },
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => {
          const u = update.update as Record<string, unknown>;
          if (u.sessionUpdate !== "agent_message_chunk") return;
          const content = u.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") text += content.text;
        },
      },
      selectAuthMethod: () => undefined,
      processes: this.host.processes,
    });
    try {
      await runtime.initialize();
      await this.authenticate(runtime, env);
      await runtime.openSession({ cwd: args.cwd, mcpServers: [] });
      const prompt = args.conversationHistory
        ? `${args.conversationHistory}\n\n${args.prompt}`
        : args.prompt;
      await runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      return text;
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------
  // Spawn + ACP plumbing
  // ---------------------------------------------------------------------

  private cliPath(): string {
    const configured = this.devin.settings.get().provider.cli.devin?.trim();
    return configured || getCatalogEntry("devin").cliBinary;
  }

  private async spawnSession(args: SpawnArgs): Promise<SpawnResult<DevinAcpSessionEntry>> {
    const env = args.env;
    let entry: DevinAcpSessionEntry | undefined;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: this.cliPath(),
        args: ["acp"],
        cwd: args.cwd,
        env: { ...env },
        shell: this.host.runtime.platform === "win32",
      },
      callbacks: {
        onPermissionRequest: async (request) => entry
          ? this.requestPermission(entry, request)
          : { outcome: { outcome: "cancelled" } },
        onSessionUpdate: async (update) => {
          if (entry) await this.deliverSessionUpdate(entry, update);
        },
        readTextFile: async (filePath) => entry
          ? this.readWorkspaceFile(entry.cwd, filePath)
          : "",
        writeTextFile: async (filePath, content) => {
          if (!entry) throw new Error("Devin ACP session is not ready");
          await this.writeWorkspaceFile(entry.cwd, filePath, content);
        },
        onExtensionRequest: async () => ({}),
        onExtensionNotification: async (method, params) => {
          if (!entry) return;
          observeDevinExtensionNotification(
            method,
            params,
            entry.activeTurnState ?? entry.replayTurnState,
          );
        },
      },
      selectAuthMethod: () => undefined,
      ignoreAuthenticationErrors: false,
      recoveryFailurePolicy: "fail-without-replacement",
      processes: this.host.processes,
    });
    const child = runtime.state.child;
    entry = {
      mcodeSessionId: args.sessionId,
      threadId: args.threadId,
      child,
      connection: runtime.state.connection,
      acpRuntime: runtime,
      acpSessionId: "",
      cwd: args.cwd,
      permissionMode: args.permissionMode === "full" ? "full" : "default",
      devinMode: "normal",
      lastUsedAt: Date.now(),
      turnChain: Promise.resolve(),
      activeTurnState: null,
      replayTurnState: null,
      pendingUserStopAbort: false,
      modelAppliedPair: null,
      modeAppliedPair: null,
      toolCallById: new Map(),
      pendingSubagentCallIds: [],
      subagentParentByAgentId: new Map(),
      stoppedModelLabel: null,
      stderrTailLines: [],
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        entry!.stderrTailLines.push(trimmed.slice(0, 2_000));
        while (entry!.stderrTailLines.length > STDERR_TAIL_MAX) entry!.stderrTailLines.shift();
      }
    });
    child.on("exit", () => {
      this.cancelPendingPermissionsForSession(args.sessionId);
    });
    try {
      await runtime.initialize();
      await this.authenticate(runtime, env);
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
    return { state: entry, pids: child.pid !== undefined ? [child.pid] : [] };
  }

  /**
   * Devin ACP requires explicit host authentication: the agent advertises only
   * `devin-browser` (PKCE), but accepts the `windsurf-api-key` method when the
   * key travels in `_meta.api_key`.
   */
  private async authenticate(
    runtime: AcpSessionRuntime,
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    const credentials = resolveDevinAcpCredentials(env, this.host.runtime.platform);
    await runtime.state.connection.authenticate({
      methodId: "windsurf-api-key",
      _meta: {
        headless: true,
        api_key: credentials.apiKey,
        ...(credentials.apiServerUrl ? { api_server_url: credentials.apiServerUrl } : {}),
      },
    });
  }

  private async deliverSessionUpdate(
    entry: DevinAcpSessionEntry,
    update: AcpSessionUpdate,
  ): Promise<void> {
    const params = update as unknown as { sessionId?: string };
    if (params.sessionId !== entry.acpSessionId) return;
    const state = entry.activeTurnState ?? entry.replayTurnState;
    if (!state) return;
    const routing = this.pendingTurnRoutings.get(entry.mcodeSessionId);
    for (const event of mapDevinAcpSessionNotification(update, entry.threadId, state)) {
      this.publishEntryEvent(entry, routing, event);
    }
  }

  private publishEntryEvent(
    entry: DevinAcpSessionEntry,
    routing: DevinCanonicalEventRouting | undefined,
    event: AgentEvent,
  ): void {
    if (!routing) {
      logger.warn("Devin event had no active turn routing", { type: event.type, threadId: event.threadId });
      return;
    }
    this.canonicalEvents.publish(routing, providerRuntimeEvent(event), this.acpSessionIdentities(entry));
  }

  private acpSessionIdentities(entry: DevinAcpSessionEntry): readonly ProviderIdentity[] {
    if (!entry.acpSessionId) return [];
    return [{
      providerId: this.id,
      scope: "session",
      value: entry.acpSessionId,
      provenance: "native",
    }];
  }

  // ---------------------------------------------------------------------
  // Workspace-scoped filesystem
  // ---------------------------------------------------------------------

  /** Reads a UTF-8 file bounded to the session's worktree root. */
  private async readWorkspaceFile(cwd: string, filePath: string): Promise<string> {
    const resolved = NodePath.resolve(cwd, filePath);
    if (!isWithinRoot(cwd, resolved)) {
      throw new Error(`Path outside workspace: ${filePath}`);
    }
    const stat = await NodeFS.promises.stat(resolved);
    if (stat.size > WORKSPACE_FILE_READ_MAX_BYTES) {
      throw new Error(`File too large to read via ACP: ${filePath}`);
    }
    return NodeFS.promises.readFile(resolved, "utf-8");
  }

  /** Writes a UTF-8 file bounded to the session's worktree root. */
  private async writeWorkspaceFile(cwd: string, filePath: string, content: string): Promise<void> {
    const resolved = NodePath.resolve(cwd, filePath);
    if (!isWithinRoot(cwd, resolved)) {
      throw new Error(`Path outside workspace: ${filePath}`);
    }
    await NodeFS.promises.mkdir(NodePath.dirname(resolved), { recursive: true });
    await NodeFS.promises.writeFile(resolved, content, "utf-8");
  }
}

/** Builds ACP prompt content blocks for one turn. */
function buildPromptBlocks(req: TurnRequest<"devin">): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: "text", text: req.message }];
  for (const attachment of req.attachments ?? []) {
    if (!attachment.sourcePath) continue;
    if (attachment.mimeType.startsWith("image/")) {
      try {
        const data = NodeFS.readFileSync(attachment.sourcePath).toString("base64");
        blocks.push({ type: "image", data, mimeType: attachment.mimeType });
        continue;
      } catch {
        // fall through to the resource link when the file is unreadable
      }
    }
    blocks.push({
      type: "resource_link",
      uri: `file://${attachment.sourcePath}`,
      name: attachment.name,
      mimeType: attachment.mimeType,
    });
  }
  return blocks;
}

function resolveAssistantText(state: ReturnType<typeof createDevinAcpTurnState> | null): string {
  if (!state) return "";
  const { assistantText, assistantFinalText } = state.accumulator;
  return (assistantFinalText || assistantText).trim();
}

function inferDevinModelGroup(modelId: string): string {
  if (modelId.startsWith("swe-")) return "Cognition";
  if (modelId.startsWith("claude-")) return "Anthropic";
  if (modelId.startsWith("gpt-")) return "OpenAI";
  if (modelId.startsWith("gemini-")) return "Google";
  if (modelId.startsWith("grok-")) return "xAI";
  if (modelId.startsWith("kimi-")) return "Moonshot";
  if (modelId.startsWith("deepseek-")) return "DeepSeek";
  if (modelId.startsWith("glm-")) return "Zhipu";
  return "Other";
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return relative === ""
    || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}
