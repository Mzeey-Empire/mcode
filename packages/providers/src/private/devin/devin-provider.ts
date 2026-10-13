import { SUBAGENT_REPORTING } from "@mcode/contracts";
import * as NodeEvents from "node:events";
import { approvalReceipt } from "../../approvals/approval-receipt.js";
import type { ApprovalOutcome } from "@mcode/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import which from "which";
import type { Provider, ProviderIdentity } from "@mcode/agent-model";
import {
  AgentEventType,
  DEVIN_STATIC_MODEL_FALLBACK,
  DevinModeSchema,
  getCatalogEntry,
  groupDevinModelFamilies,
  providerRuntimeEvent,
  resolveDevinModelId,
  type AgentEvent,
  type DevinMode,
  type IAgentProvider,
  type ISessionEvictable,
  type ApprovalResponse,
  type ApprovalRespondResult,
  type ApprovalRequestEnvelope,
  type ApprovalRequestBody,
  type DevinModelFamily,
  type ProviderModelInfo,
  type SessionForker,
  type Settings,
  type TurnFailure,
  type TurnRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { acpApprovalChoices, approvalChoice, approvalOutcome } from "../../approval-scope.js";
import type { ProviderHostPorts } from "../../host-ports.js";
import { SessionRuntime, type SpawnArgs, type SpawnResult } from "../session-runtime.js";
import { AcpSessionRuntime } from "../protocols/acp/acp-session-runtime.js";
import {
  ACP_AUTH_REQUIRED_CODE,
  acpRequestErrorCode,
  describeAcpError,
} from "../protocols/acp/acp-request-error.js";
import { ProviderTurnError } from "../../provider-turn-error.js";
import type {
  AcpPermissionRequest,
  AcpPermissionOutcome,
  AcpSessionUpdate,
} from "../protocols/acp/acp-session-types.js";
import { describeDevinAuth, resolveDevinAcpCredentials } from "./devin-credentials.js";
import { DevinCanonicalEventPublisher, type DevinCanonicalEventRouting } from "./devin-canonical-event-publisher.js";
import {
  createDevinAcpTurnState,
  devinPermissionPreview,
  mapDevinAcpSessionNotification,
  observeDevinExtensionNotification,
} from "./devin-acp-event-mapper.js";
import type { DevinAcpSessionEntry } from "./devin-session-state.js";

const STDERR_TAIL_MAX = 48;

/** Thrown when a spawn site cannot resolve an executable Devin CLI. */
class DevinCliMissingError extends Error {
  constructor(cliPath: string) {
    super(`Devin CLI not found (${cliPath}). Install devin or set provider.cli.devin in Settings.`);
    this.name = "DevinCliMissingError";
  }
}
const WORKSPACE_FILE_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Server-owned authorities required by the Devin Provider. */
export interface DevinProviderPorts {
  settings: {
    get(): Settings;
  };
}

interface DevinPendingPermission {
  routing?: DevinCanonicalEventRouting;
  unanswerable?: boolean;
  entry: DevinAcpSessionEntry;
  request: ApprovalRequestEnvelope & { body: ApprovalRequestBody };
  /** Raw ACP options, retained so `optionId` and `kind` survive to the reply. */
  acpOptions: readonly { optionId: string; name: string; kind?: string | null }[];
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
const DECISION_OPTION_CANDIDATES = {
  deny: ["reject_once", "reject_always"],
  "allow-session": ["allow_session", "allow_always", "allow_once"],
  allow: ["allow_once"],
};

/** Resolves which permission option id a generic decision maps to. */
function resolveOptionIdForDecision(
  options: readonly { optionId: string; kind?: string | null }[],
  decision: keyof typeof DECISION_OPTION_CANDIDATES,
): string | undefined {
  for (const candidate of DECISION_OPTION_CANDIDATES[decision] ?? []) {
    const hit = options.find(
      (option) => option.optionId === candidate || option.kind === candidate,
    );
    if (hit) return hit.optionId;
  }
  return undefined;
}

/** Stop reasons a bare "continue" prompt can push through, per Devin's own continue flow. */
const AUTO_CONTINUABLE_REASONS = new Set(["max_turn_requests", "max_tokens", "output_truncated"]);
const MAX_AUTO_CONTINUES = 8;

/**
 * How long `session/cancel` gets to settle a turn before the child is killed.
 * Devin ignores cancel while a turn is blocked inside a tool call, so an
 * unbounded wait would leave Stop itself hanging forever.
 */
const CANCEL_SETTLE_TIMEOUT_MS = 10_000;

/** Bound on a follow-up send's wait for a user-stop drain before it respawns instead. */
const STOP_DRAIN_REUSE_TIMEOUT_MS = 3_000;

/** How a stop reason that cut the turn short ends it; an errored ending carries its failure. */
type DevinStopEnding =
  | { outcome: "cancelled" | "interrupted" }
  | { outcome: "errored"; message: string; failure: TurnFailure };

/** Endings for stop reasons that cut the turn short; others stay a normal completion. */
const STOP_ENDINGS: Readonly<Record<string, DevinStopEnding>> = {
  cancelled: { outcome: "cancelled" },
  interrupted: { outcome: "interrupted" },
  tool_rejected: { outcome: "interrupted" },
  shutdown: { outcome: "interrupted" },
  restart: { outcome: "interrupted" },
  quota_exhausted: {
    outcome: "errored",
    message: "Devin usage quota is exhausted.",
    failure: { kind: "usage_limit", code: "quota_exhausted" },
  },
  auth_required: {
    outcome: "errored",
    message: "Devin is signed out. Run `devin auth login`, then retry.",
    failure: { kind: "auth", code: "auth_required" },
  },
  content_filter: {
    outcome: "errored",
    message: "Devin stopped because a content filter blocked the response.",
    failure: { kind: "fatal", code: "content_filter" },
  },
  error: {
    outcome: "errored",
    message: "Devin stopped with an error.",
    failure: { kind: "fatal", code: "error" },
  },
};

/**
 * `_cognition.ai/agent_stopped.cause` is authoritative and more specific than
 * the prompt `stopReason` (e.g. `end_turn` + cause `quota_exhausted`).
 */
function effectiveStopReason(stopReason: string | undefined, stopCause: string | null): string {
  if (stopCause && stopCause !== "complete") return stopCause;
  return stopReason ?? "end_turn";
}

/** Maps the effective stop reason to its ending; a user stop always wins. */
function stopEndingFor(reason: string, pendingUserStopAbort: boolean): DevinStopEnding | undefined {
  if (pendingUserStopAbort) return { outcome: "cancelled" };
  return STOP_ENDINGS[reason];
}

/** Classifies a thrown Devin turn failure into the provider-neutral failure shape. */
function classifyDevinFailure(error: unknown): TurnFailure {
  if (error instanceof ProviderTurnError) return error.failure;
  const code = acpRequestErrorCode(error);
  if (code === ACP_AUTH_REQUIRED_CODE) return { kind: "auth", code: String(code) };
  return code === undefined ? { kind: "fatal" } : { kind: "fatal", code: String(code) };
}

/** Wraps a dispatch failure so the server receives the adapter's classification. */
function toProviderTurnError(error: unknown): ProviderTurnError {
  if (error instanceof ProviderTurnError) return error;
  return new ProviderTurnError(describeAcpError(error), classifyDevinFailure(error), { cause: error });
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
  readonly subagentReporting = SUBAGENT_REPORTING.devin;
  readonly descriptor: Provider = {
    id: "devin",
    capabilities: [
      { name: "build", support: "supported" },
      { name: "plan", support: "supported" },
      { name: "permissions", support: "supported" },
      { name: "session-eviction", support: "supported" },
      { name: "clean-fork", support: "supported" },
      { name: "session-resume", support: "supported" },
      { name: "turn-steer", support: "unsupported" },
    ],
  };
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "unsupported" as const;
  readonly maxInputCharactersPerTurn = 16_000;
  readonly forker: SessionForker;

  private readonly sessions: SessionRuntime<DevinAcpSessionEntry>;
  private readonly canonicalEvents: DevinCanonicalEventPublisher;
  private readonly pendingTurns = new Map<string, { routing: DevinCanonicalEventRouting; controller: AbortController }>();
  private readonly pendingPermissions = new Map<string, DevinPendingPermission>();
  private modelsCache: Promise<{ models: ProviderModelInfo[]; families: DevinModelFamily[] }> | null = null;
  /** Seeded from the static fallback so `applyModel` never blocks on a probe. */
  private devinFamilies: DevinModelFamily[] =
    groupDevinModelFamilies(DEVIN_STATIC_MODEL_FALLBACK).families;
  /** Access modes last advertised by any session's `mode` select; `null` until probed. */
  private advertisedModes: string[] | null = null;

  constructor(
    private readonly host: ProviderHostPorts,
    private readonly devin: DevinProviderPorts,
    idleSessionTtlMs: number,
    private readonly cancelSettleTimeoutMs: number = CANCEL_SETTLE_TIMEOUT_MS,
    private readonly stopDrainReuseTimeoutMs: number = STOP_DRAIN_REUSE_TIMEOUT_MS,
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
        isStale: (state, args) => state.child.exitCode !== null ||
          state.child.signalCode !== null || state.cwd !== args.cwd,
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

  /** Reports sign-in from the same credential lookup ACP authentication uses. */
  async describeStatus() {
    return describeDevinAuth(this.host.environment.snapshot(), this.host.runtime.platform);
  }

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
   * Lists the native access modes Devin advertises for this account, learned
   * from the model probe's `mode` select and refreshed by live
   * `config_option_update` notifications. `null` when nothing has been
   * advertised yet, so callers keep the full static list.
   */
  async listModes(): Promise<string[] | null> {
    if (!this.advertisedModes) await this.modelCatalog();
    return this.advertisedModes;
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
    const cliPath = await this.resolveCliPath();
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
      this.observeProbedModes(created.configOptions);
      if (!modelOption || modelOption.type !== "select" || !modelOption.options) return [];
      return flattenSelectOptions(modelOption.options)
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

  private readonly turnTasks = new Set<Promise<void>>();

  /** Queues an ACP `session/prompt` on the thread's Devin session. */
  sendTurn(req: TurnRequest<"devin">): Promise<void> {
    const task = this.dispatchTurnRequest(req);
    this.turnTasks.add(task);
    void task.then(() => { this.turnTasks.delete(task); }, () => { this.turnTasks.delete(task); });
    return task;
  }

  private async dispatchTurnRequest(req: TurnRequest<"devin">): Promise<void> {
    const routing: DevinCanonicalEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    const pending = { routing, controller: new AbortController() };
    const signal = pending.controller.signal;
    this.pendingTurns.set(req.sessionId, pending);
    try {
      let entry = await this.sessions.acquire({
        sessionId: req.sessionId,
        threadId: req.threadId,
        cwd: req.cwd,
        permissionMode: req.permissionMode,
        resumeFrom: req.resumeFrom,
        signal,
      });
      entry = await this.resolveStopDrain(req, entry, signal);
      signal.throwIfAborted();
      entry.devinMode = resolveDevinMode(req);
      const run = entry.turnChain.then(() => this.executeTurn(entry, req, routing, signal));
      entry.turnChain = run.then(() => undefined, () => undefined);
      await run;
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) throw toProviderTurnError(error);
      this.canonicalEvents.publish(routing, providerRuntimeEvent({ type: AgentEventType.Ended,
        threadId: req.threadId, turnExecutionId: req.turnExecutionId, outcome: "cancelled" }), []);
      await this.canonicalEvents.waitForExecution(routing);
    } finally {
      if (this.pendingTurns.get(req.sessionId) === pending) this.pendingTurns.delete(req.sessionId);
    }
  }

  /**
   * Wait briefly for an in-flight user-stop cancel to drain before reusing the
   * warm entry. Queueing the prompt behind a turn that is ignoring cancel would
   * stall the send until the kill timer, so a wedged drain falls back to an
   * early stop plus respawn (which joins the already-warming replacement).
   */
  private async resolveStopDrain(
    req: TurnRequest<"devin">,
    entry: DevinAcpSessionEntry,
    signal: AbortSignal,
  ): Promise<DevinAcpSessionEntry> {
    if (entry.pendingUserStopAbort) {
      const settled = await Promise.race([
        entry.turnChain.then(() => true, () => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), this.stopDrainReuseTimeoutMs);
          timer.unref?.();
        }),
      ]);
      signal.throwIfAborted();
      if (settled && this.sessions.get(req.sessionId) === entry) return entry;
      // Stop only when the pool still holds this entry — a concurrent send may
      // have already spawned a replacement under the same sessionId.
      if (!settled && this.sessions.get(req.sessionId) === entry) {
        await this.sessions.stop(req.sessionId).catch(() => undefined);
      }
    } else if (this.sessions.get(req.sessionId) === entry) {
      return entry;
    }
    // An evicted entry cannot take a prompt; reacquire joins a pending spawn.
    return this.sessions.acquire({
      sessionId: req.sessionId,
      threadId: req.threadId,
      cwd: req.cwd,
      permissionMode: req.permissionMode,
      resumeFrom: req.resumeFrom,
      signal,
    });
  }

  private async executeTurn(
    entry: DevinAcpSessionEntry,
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const resume = req.resumeFrom !== undefined;
    const storedAcpId = resume ? req.resumeFrom : undefined;
    if (resume && storedAcpId && !entry.acpSessionId) {
      entry.acpSessionId = storedAcpId;
      entry.replayTurnState = createDevinAcpTurnState();
    }
    await this.ensureSession(entry, req, routing);
    signal.throwIfAborted();
    entry.replayTurnState = null;
    await this.applyModel(entry, req);
    signal.throwIfAborted();
    await this.applyMode(entry, entry.devinMode);
    signal.throwIfAborted();

    const turnState = createDevinAcpTurnState();
    entry.activeTurnState = turnState;
    this.emit("turn_started", { sessionId: entry.mcodeSessionId });
    try {
      const response = await this.promptWithAutoContinue(entry, req, routing);
      this.emitPromptResponse(entry, response, req, routing);
      this.emit("turn_complete", { sessionId: entry.mcodeSessionId });
    } catch (error) {
      this.emitFailedTurn(entry, error, req, routing);
    } finally {
      entry.activeTurnState = null;
      entry.pendingUserStopAbort = false;
      await this.canonicalEvents.waitForExecution(routing);
    }
  }

  private async ensureSession(entry: DevinAcpSessionEntry, req: TurnRequest<"devin">, routing: DevinCanonicalEventRouting): Promise<void> {
    if (entry.acpSessionId && entry.acpRuntime.state.sessionId === entry.acpSessionId) return;
    const opened = await entry.acpRuntime.openSession({
      resumeFrom: entry.acpSessionId || req.resumeFrom,
      cwd: entry.cwd,
      mcpServers: [],
    });
    entry.acpSessionId = opened.sessionId;
    // Persists the resume cursor (`threads.sdk_session_id`) so session/load
    // works across app restarts.
    this.publishEntryEvent(entry, routing, {
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
    // `plan` rides the interaction-mode axis, not the access-mode select, so
    // it is applied optimistically; the guard only gates access modes Devin
    // did not advertise for this session.
    if (mode !== "plan" && entry.advertisedModes && !entry.advertisedModes.has(mode)) {
      logger.warn("Devin mode not advertised by this session; skipping set_config_option", {
        threadId: entry.threadId,
        mode,
      });
      return;
    }
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

  /**
   * Records a mode Devin changed on its own side (a `current_mode_update`
   * notification or a `switch_bypass` permission pick) so `applyMode` does not
   * re-apply a mode Devin has already left.
   */
  private applyObservedDevinMode(entry: DevinAcpSessionEntry, modeId: unknown): void {
    const parsed = DevinModeSchema.safeParse(modeId);
    if (!parsed.success || parsed.data === "plan") return;
    entry.devinMode = parsed.data;
    entry.modeAppliedPair = entry.acpSessionId
      ? { acpSessionId: entry.acpSessionId, mode: parsed.data }
      : null;
  }

  /**
   * Records the access modes a session advertises through `config_option_update`
   * so {@link applyMode} never sends a value Devin cannot accept.
   */
  private observeAdvertisedModes(entry: DevinAcpSessionEntry, update: Record<string, unknown>): void {
    const modes = parseAdvertisedModes(update.configOptions);
    if (modes.size === 0) return;
    entry.advertisedModes = modes;
    this.advertisedModes = [...modes];
  }

  /** Records the mode select advertised in a probe session's `session/new` result. */
  private observeProbedModes(configOptions: unknown): void {
    const modes = parseAdvertisedModes(configOptions);
    if (modes.size > 0) this.advertisedModes = [...modes];
  }

  /**
   * Retains `usage_update.cost` on the session so {@link emitPromptResponse}
   * can report it as `costUsd`. Devin has not been observed emitting this
   * field; only a numeric USD amount is accepted when it does.
   */
  private observeUsageCost(entry: DevinAcpSessionEntry, update: Record<string, unknown>): void {
    const cost = update.cost as { amount?: unknown; currency?: unknown } | undefined;
    if (typeof cost?.amount !== "number" || cost.currency !== "USD") return;
    entry.lastCostUsd = cost.amount;
  }

  /**
   * Prompts Devin and, like Devin's own `autoContinue` setting, sends a
   * "continue" prompt when the turn stops on a limit (`max_turn_requests`,
   * `max_tokens`/`output_truncated`). Bounded by {@link MAX_AUTO_CONTINUES};
   * the final stop reason is reported so the user can continue manually.
   */
  private async promptWithAutoContinue(
    entry: DevinAcpSessionEntry,
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): Promise<{ stopReason?: string; usage?: Record<string, number> }> {
    let prompt = buildPromptBlocks(req);
    for (let continues = 0;; continues += 1) {
      if (entry.activeTurnState) entry.activeTurnState.stopCause = null;
      const response = await entry.acpRuntime.prompt<{ stopReason?: string; usage?: Record<string, number> }>({ prompt });
      const reason = effectiveStopReason(response.stopReason, entry.activeTurnState?.stopCause ?? null);
      if (entry.pendingUserStopAbort || !AUTO_CONTINUABLE_REASONS.has(reason) || continues >= MAX_AUTO_CONTINUES) {
        return response;
      }
      this.publishEntryEvent(entry, routing, {
        type: AgentEventType.System,
        threadId: entry.threadId,
        subtype: "devin_auto_continue",
        message: "Request limit reached; continuing automatically.",
      });
      prompt = [{ type: "text", text: "continue" }];
    }
  }

  private emitPromptResponse(
    entry: DevinAcpSessionEntry,
    response: { stopReason?: string; usage?: Record<string, number> },
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): void {
    this.emitAssistantText(entry, routing);
    const reason = effectiveStopReason(response.stopReason, entry.activeTurnState?.stopCause ?? null);
    const ending = stopEndingFor(reason, entry.pendingUserStopAbort);
    if (ending?.outcome === "errored") {
      // TurnComplete settles the turn as completed, so an errored stop must not send it.
      this.publishEntryEvent(entry, routing, {
        type: AgentEventType.Error,
        threadId: entry.threadId,
        error: ending.message,
        failure: ending.failure,
      });
    } else {
      this.emitTurnComplete(entry, response, reason, routing);
    }
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId: req.turnExecutionId,
      ...(ending ? { outcome: ending.outcome } : {}),
    });
  }

  private emitAssistantText(entry: DevinAcpSessionEntry, routing: DevinCanonicalEventRouting): void {
    const text = resolveAssistantText(entry.activeTurnState);
    if (text.length === 0) return;
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.Message,
      threadId: entry.threadId,
      content: text,
      tokens: null,
    });
  }

  private emitTurnComplete(
    entry: DevinAcpSessionEntry,
    response: { stopReason?: string; usage?: Record<string, number> },
    reason: string,
    routing: DevinCanonicalEventRouting,
  ): void {
    const usage = response.usage ?? {};
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.TurnComplete,
      threadId: entry.threadId,
      reason,
      costUsd: entry.lastCostUsd,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      ...(typeof usage.cachedReadTokens === "number" ? { cacheReadTokens: usage.cachedReadTokens } : {}),
      providerId: this.id,
    });
  }

  private emitFailedTurn(
    entry: DevinAcpSessionEntry,
    error: unknown,
    req: TurnRequest<"devin">,
    routing: DevinCanonicalEventRouting,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const cancelled = entry.pendingUserStopAbort || /cancel/i.test(errorMessage);
    if (cancelled) {
      this.emitAssistantText(entry, routing);
    } else {
      const description = describeAcpError(error);
      logger.error("Devin ACP prompt failed", {
        threadId: entry.threadId,
        acpSessionId: entry.acpSessionId,
        stderrTail: entry.stderrTailLines.slice(-16),
        error: description,
      });
      this.publishEntryEvent(entry, routing, {
        type: AgentEventType.Error,
        threadId: entry.threadId,
        error: description,
        failure: classifyDevinFailure(error),
      });
    }
    this.publishEntryEvent(entry, routing, {
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId: req.turnExecutionId,
      outcome: cancelled ? "cancelled" : "errored",
    });
  }

  // ---------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------

  /** Acknowledge the exact native option before publishing its outcome. */
  async resolveApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { status: "not_pending" };
    if ("autoDeny" in response) pending.unanswerable = true;
    if (pending.entry.connection.signal.aborted || pending.entry.child.exitCode !== null) {
      return { status: "failed", message: "The ACP connection is closed" };
    }
    const choice = approvalChoice(pending.request.body, response);
    if (!choice && !("autoDeny" in response)) return { status: "failed", message: "The approval choice is unavailable" };
    const selected = "autoDeny" in response
      ? pending.acpOptions.find((option) => option.kind === "reject_once")
      : pending.acpOptions.find((option) => option.optionId === response.choiceId);
    pending.resolve({ outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } });
    this.pendingPermissions.delete(requestId);
    await Promise.resolve();
    this.applyApprovalMode(pending.entry, selected);
    this.publishApprovalDecision(pending, approvalOutcome(choice, response));
    return { status: "resolved" };
  }

  private applyApprovalMode(entry: DevinAcpSessionEntry, selected: { optionId: string } | undefined): void {
    if (selected?.optionId === "switch_bypass") this.applyObservedDevinMode(entry, "bypass");
  }

  /** Return routing envelopes without trusting their display bodies. */
  listPendingApprovals(threadId?: string): ApprovalRequestEnvelope[] {
    return [...this.pendingPermissions.values()]
      .filter((pending) => threadId === undefined || pending.request.threadId === threadId)
      .map((pending) => pending.request);
  }

  private async requestPermission(entry: DevinAcpSessionEntry, params: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const options = params.options ?? [];
    if (entry.devinMode === "bypass") {
      const allow = resolveOptionIdForDecision(options, "allow");
      return { outcome: allow ? { outcome: "selected", optionId: allow } : { outcome: "cancelled" } };
    }
    const request = this.buildApprovalRequest(entry, params, options);
    const outcome = new Promise<AcpPermissionOutcome>((resolve) => {
      this.pendingPermissions.set(request.requestId, { entry, request, acpOptions: options, resolve, routing: this.pendingTurns.get(entry.mcodeSessionId)?.routing });
    });
    this.emit("approval_request", request);
    return outcome;
  }

  private buildApprovalRequest(
    entry: DevinAcpSessionEntry,
    params: AcpPermissionRequest,
    options: readonly { optionId: string; kind?: string | null; name: string }[],
  ): ApprovalRequestEnvelope & { body: ApprovalRequestBody } {
    const snapshot = entry.activeTurnState?.toolCallById.get(params.toolCall.toolCallId);
    const command = devinPermissionPreview(params.toolCall);
    const choices = acpApprovalChoices(options);
    return {
      requestId: crypto.randomUUID(), threadId: entry.threadId,
      body: {
        toolCallId: params.toolCall.toolCallId, requestedAt: new Date().toISOString(),
        subject: command ? { kind: "command", command } : { kind: "tool", toolName: snapshot?.toolName || params.toolCall.title || "Tool", preview: JSON.stringify(snapshot?.input ?? params.toolCall.rawInput ?? {}) },
        choices, noteDelivery: "none", origin: { kind: "agent" },
      },
    };
  }

  private cancelPendingPermissionsForSession(mcodeSessionId: string, reason: "session_stopped" | "turn_ended" = "session_stopped"): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.entry.mcodeSessionId !== mcodeSessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.publishApprovalDecision(pending, { status: "cancelled", reason: pending.unanswerable ? "unanswerable" : reason });
    }
  }

  private publishApprovalDecision(pending: DevinPendingPermission, outcome: ApprovalOutcome): void {
    this.publishEntryEvent(pending.entry, pending.routing, approvalReceipt(pending.request, outcome));
    this.emit("approval_resolved", { requestId: pending.request.requestId, threadId: pending.request.threadId, outcome });
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  /**
   * Cancels the in-flight prompt and lets the session stay warm. Devin ignores
   * `session/cancel` while a turn is blocked inside a tool call, so when the
   * prompt has not settled within {@link cancelSettleTimeoutMs} the child is
   * killed and a replacement ACP process is warmed in the background. The next
   * turn reuses it and reloads the Devin session via `session/load`, so Stop
   * is a guaranteed escape even for a wedged child.
   */
  async stopSession(sessionId: string): Promise<void> {
    this.pendingTurns.get(sessionId)?.controller.abort();
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pendingUserStopAbort = true;
    this.cancelPendingPermissionsForSession(sessionId);
    await entry.acpRuntime.cancel().catch(() => undefined);
    const settled = await Promise.race([
      entry.turnChain.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.cancelSettleTimeoutMs);
        timer.unref?.();
      }),
    ]);
    // Identity check: a follow-up send may have already replaced the entry.
    if (settled || this.sessions.get(sessionId) !== entry) return;
    logger.warn("Devin turn ignored session/cancel; killing ACP child and warming a replacement", {
      sessionId,
      threadId: entry.threadId,
      acpSessionId: entry.acpSessionId,
    });
    await this.sessions.stop(sessionId).catch((error: unknown) => {
      logger.warn("Devin ACP session teardown failed after ignored cancel", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void this.sessions.acquire({
      sessionId,
      threadId: entry.threadId,
      cwd: entry.cwd,
      permissionMode: entry.permissionMode,
    }).catch((error: unknown) => {
      logger.warn("Devin ACP warm respawn failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
    const results = await Promise.allSettled([this.sessions.shutdown()]);
    results.push(...await Promise.allSettled(this.turnTasks));
    results.push(...await Promise.allSettled([this.canonicalEvents.stopAdmissionAndDrain()]));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Devin provider shutdown failed");
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
    const cliPath = await this.resolveCliPath();
    if (!cliPath) throw new DevinCliMissingError(this.cliPath());
    let text = "";
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: cliPath,
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

  /**
   * Resolves the Devin CLI binary, or undefined when it cannot execute.
   * `child_process.spawn` reports a missing binary through an `error` event on
   * the child that the ACP runtime never observes; without this guard it
   * escapes as an uncaught exception and crashes the host.
   */
  private async resolveCliPath(): Promise<string | undefined> {
    return (await which(this.cliPath(), { nothrow: true })) ?? undefined;
  }

  private async spawnSession(args: SpawnArgs): Promise<SpawnResult<DevinAcpSessionEntry>> {
    const env = args.env;
    const cliPath = await this.resolveCliPath();
    if (!cliPath) throw new DevinCliMissingError(this.cliPath());
    let entry: DevinAcpSessionEntry | undefined;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: cliPath,
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
      advertisedModes: null,
      stoppedModelLabel: null,
      lastCostUsd: null,
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
    try {
      await runtime.state.connection.authenticate({
        methodId: "windsurf-api-key",
        _meta: {
          headless: true,
          api_key: credentials.apiKey,
          ...(credentials.apiServerUrl ? { api_server_url: credentials.apiServerUrl } : {}),
        },
      });
    } catch (error) {
      // Devin rejects a bad key with a generic -32603 ("Authentication failed:
      // ... invalid api key"), so the ACP code alone would read as fatal.
      const code = acpRequestErrorCode(error);
      if (code === undefined) throw error;
      throw new ProviderTurnError(describeAcpError(error), { kind: "auth", code: String(code) }, { cause: error });
    }
  }

  private async deliverSessionUpdate(
    entry: DevinAcpSessionEntry,
    update: AcpSessionUpdate,
  ): Promise<void> {
    const params = update as unknown as { sessionId?: string };
    if (params.sessionId !== entry.acpSessionId) return;
    const raw = update.update as Record<string, unknown>;
    if (raw.sessionUpdate === "current_mode_update") this.applyObservedDevinMode(entry, raw.currentModeId);
    if (raw.sessionUpdate === "config_option_update") this.observeAdvertisedModes(entry, raw);
    const state = entry.activeTurnState ?? entry.replayTurnState;
    if (!state) return;
    if (!entry.acpRuntime.state.sessionId) {
      // session/load replays the full history before it resolves; absorb it
      // into the replay state without republishing it as live turn output.
      mapDevinAcpSessionNotification(update, entry.threadId, state);
      return;
    }
    if (raw.sessionUpdate === "usage_update") this.observeUsageCost(entry, raw);
    const routing = this.pendingTurns.get(entry.mcodeSessionId)?.routing;
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
    if (event.type === "turnComplete" || event.type === "ended" || event.type === "error") this.cancelPendingPermissionsForSession(entry.mcodeSessionId, "turn_ended");
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

/** ACP select options arrive as flat `{value}` entries or named groups of entries. */
function flattenSelectOptions(options: unknown): Record<string, unknown>[] {
  if (!Array.isArray(options)) return [];
  return (options as Record<string, unknown>[]).flatMap(
    (option) => typeof option?.value === "string"
      ? [option]
      : (option?.options as Record<string, unknown>[] | undefined) ?? [],
  );
}

/** Extracts the advertised `mode` select values from a configOptions array. */
function parseAdvertisedModes(configOptions: unknown): Set<DevinMode> {
  const modes = new Set<DevinMode>();
  if (!Array.isArray(configOptions)) return modes;
  const modeOption = configOptions.find(
    (option) => typeof option === "object" && option !== null
      && (option as Record<string, unknown>).id === "mode",
  ) as { options?: unknown } | undefined;
  for (const option of flattenSelectOptions(modeOption?.options)) {
    const parsed = DevinModeSchema.safeParse(option.value);
    if (parsed.success) modes.add(parsed.data);
  }
  return modes;
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
