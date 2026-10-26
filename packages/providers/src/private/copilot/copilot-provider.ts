import { SUBAGENT_REPORTING } from "@mcode/contracts";
import * as NodeEvents from "node:events";
import { approvalReceipt } from "../../approvals/approval-receipt.js";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent, MCPServerConfig, ModelInfo, PermissionRequest as NativePermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import { z } from "zod";
import type { AgentEvent, ChildThreadEvidence, IAgentProvider, ISessionEvictable, ApprovalChoice, ApprovalResponse, ApprovalRespondResult, ApprovalRequestEnvelope, ProviderIdentity, ProviderModelInfo, TurnRequest, CompletionOptions } from "@mcode/contracts";
import { approvalChoice, approvalOutcome } from "../../approval-scope.js";
import { copilotApprovalBody, copilotSessionScope } from "./copilot-approval.js";
import { PLAN_MAX_CONTENT_CHARS, providerRuntimeEvent, type NativePlanFileOutcome } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { buildMcodeInstructionSections, NO_MCODE_TOOLKITS, renderMcodeInstructionSections } from "@mcode/thread-orchestration";
import type { CopilotProviderPorts } from "../../factory-types.js";
import { providerBrowserPermissionCapability, type ProviderBrowserLeaseGrant, type ProviderHostPorts } from "../../host-ports.js";
import { SessionRuntime, type ProtocolAdapter, type SpawnArgs, type SpawnResult } from "../session-runtime.js";
import { CanonicalLiveEventPublisher, type CanonicalLiveEventRouting } from "../canonical-live-event-publisher.js";
import { composeCopilotSystemMessage, inferModelGroup, normalizeQuotaSnapshots, readUserInstructions, userSkillDirectories } from "./copilot-helpers.js";
import { mapCopilotEvent, closeOpenChildren, type CopilotTurnState, type CopilotMappedEvent } from "./copilot-event-mapper.js";
import { describeCopilotAuth } from "../status/provider-auth-checks.js";
import { SessionResumeUnavailableError } from "../../provider-turn-error.js";
import { canWriteNativePlanFile, captureNativePlanFile, rewriteNativePlanFile } from "../../plan/native-plan-file.js";

interface CopilotSessionState {
  sessionId: string;
  session: CopilotSession;
  planRoot: string;
  cwd: string;
  request: TurnRequest<"copilot">;
  browserGrant: ProviderBrowserLeaseGrant | null;
  browserCapability: "observe" | "interact" | "privileged";
  turn?: CopilotTurnState;
  controls?: Promise<void>;
  nativeEventIds: Set<string>;
  utilityBusy?: boolean;
  sessionGrants: Set<string>;
  retireRequested?: boolean;
  clientLost?: boolean;
}

/** Private SDK protocol adapter; SessionRuntime is its sole session lifecycle owner. */
export class CopilotProvider extends NodeEvents.EventEmitter implements IAgentProvider, ISessionEvictable, ProtocolAdapter<CopilotSessionState> {
  readonly id = "copilot" as const;
  readonly subagentReporting = SUBAGENT_REPORTING.copilot;
  readonly descriptor = Object.freeze({ id: this.id, capabilities: [
    ...(["build", "plan", "completion", "permissions", "usage", "session-eviction", "browser-access", "thread-control", "session-resume"] as const).map((name) => ({ name, support: "supported" as const })),
    { name: "turn-steer" as const, support: "unsupported" as const },
  ] });
  readonly supportsCompletion = true;
  readonly maxInputCharactersPerTurn = 16_000;
  private readonly runtime: SessionRuntime<CopilotSessionState>;
  private readonly publisher: CanonicalLiveEventPublisher;
  private readonly admissions = new Map<string, { request: TurnRequest<"copilot">; controller: AbortController; utility?: boolean }>();
  private readonly tasks = new Set<Promise<void>>();
  private client?: CopilotClient;
  private configDir?: string;
  private startingClient?: CopilotClient;
  private clientTask?: Promise<CopilotClient>;
  private transportFailure?: Error;
  private forceStopTask?: Promise<void>;
  private connectionWatch?: ReturnType<typeof setInterval>;
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;
  private modelCache?: { at: number; models: ProviderModelInfo[] };
  private deliveryFailureHandler?: (routing: CanonicalLiveEventRouting, error: Error) => Promise<void>;

  constructor(private readonly host: ProviderHostPorts, private readonly ports: CopilotProviderPorts, idleTtlMs: number) {
    super();
    this.runtime = new SessionRuntime(this, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} },
      envService: { getEnv: () => ({ ...host.environment.snapshot() }) },
      processes: host.processes, idleTtlMs, logger,
    });
    // The worker owns execution failures; a successful Stop fence must not poison later sessions or shutdown.
    this.publisher = new CanonicalLiveEventPublisher(this.id, host.events, (routing, error) => {
      const state = this.runtime.states().find((entry) => entry.request.turnExecutionId === routing.executionId);
      state?.turn?.settle("failed", error);
      if (state?.turn) state.turn.abortTask ??= state.session.abort();
    }, "execution");
  }

  /** Starts a native turn with the current standard controls and exact Mcode routing. */
  async sendTurn(request: TurnRequest<"copilot">): Promise<void> {
    if (this.shuttingDown) throw new Error("Copilot Provider is shutting down");
    const currentState = this.runtime.get(request.sessionId);
    if (this.admissions.has(request.sessionId) || currentState?.turn || currentState?.controls) throw new Error("Copilot session already has an active turn");
    const controller = new AbortController();
    this.admissions.set(request.sessionId, { request, controller });
    try {
      await abortable(this.getClient(), controller.signal);
      controller.signal.throwIfAborted();
      const current = this.runtime.get(request.sessionId);
      const capability = providerBrowserPermissionCapability(request.permissionMode, request.interactionMode);
      let resumeFrom = request.resumeFrom;
      if (current && this.requiresBrowserReplacement(current, request, capability)) {
        resumeFrom = current.session.sessionId;
        await this.runtime.stop(request.sessionId);
      }
      const state = await this.runtime.acquire({ sessionId: request.sessionId, threadId: request.threadId, cwd: request.cwd, permissionMode: request.permissionMode, resumeFrom, signal: controller.signal });
      controller.signal.throwIfAborted();
      const controls = this.applyControls(state, request).finally(() => { if (state.controls === controls) state.controls = undefined; });
      state.controls = controls;
      await abortable(controls, controller.signal);
      controller.signal.throwIfAborted();
      const task = this.runTurn(state).finally(() => { this.tasks.delete(task); });
      this.tasks.add(task);
      void task.catch(async (error: unknown) => {
        logger.error("Copilot turn failed", { executionId: request.turnExecutionId, error: toError(error).message });
        await this.deliveryFailureHandler?.(routingFor(request), toError(error));
      }).catch((error: unknown) => logger.error("Copilot turn failure handler failed", { error: toError(error).message }));
    } finally {
      this.admissions.delete(request.sessionId);
    }
  }

  private requiresBrowserReplacement(state: CopilotSessionState, request: TurnRequest<"copilot">, capability: CopilotSessionState["browserCapability"]): boolean {
    return this.host.browser.isConfigured() && (state.browserCapability !== capability || state.request.workspaceId !== request.workspaceId || (state.browserGrant?.expiresAt ?? Infinity) <= Date.now());
  }

  /** Reconciles the captured session's exact plan file, including after idle eviction. */
  async prepareImplement(input: Parameters<NonNullable<IAgentProvider["prepareImplement"]>>[0]): Promise<NativePlanFileOutcome> {
    if (!input.nativePlanFile) return { outcome: "skipped", reason: "no-file" };
    const { sessionId } = input.nativePlanFile;
    if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId)) return { outcome: "skipped", reason: "unsafe-path" };
    // A sync is an optimisation, so an unresolved launch must not fail Implement.
    const configDir = await this.resolveConfigDirectory().catch((error: unknown) => {
      logger.warn("Copilot plan sync skipped: config directory unresolved", { error: toError(error).message });
      return undefined;
    });
    if (!configDir) return { outcome: "skipped", reason: "unproven" };
    return rewriteNativePlanFile({ ...input, planRoot: NodePath.join(configDir, "session-state", sessionId), sessionId });
  }

  private async resolveConfigDirectory(): Promise<string> {
    if (this.configDir) return this.configDir;
    const launch = await bounded(this.ports.launch.resolve(), 30_000, "Copilot launch resolution");
    this.configDir = copilotConfigDirectory(launch.env);
    return this.configDir;
  }
  private async applyControls(state: CopilotSessionState, request: TurnRequest<"copilot">): Promise<void> {
    if (state.request.model !== request.model || state.request.reasoningLevel !== request.reasoningLevel) {
      await this.awaitNativeResource(state.session.setModel(request.model, { reasoningEffort: await this.reasoningEffort(request) }), 30_000, "Copilot model selection");
      // Native model selection survives a later mode failure; retain its acknowledged value for retries.
      state.request = { ...state.request, model: request.model, reasoningLevel: request.reasoningLevel };
    }
    await this.awaitNativeResource(state.session.rpc.mode.set({ mode: request.interactionMode === "plan" ? "plan" : "interactive" }), 30_000, "Copilot mode selection");
    if (state.request.permissionMode !== request.permissionMode) state.sessionGrants.clear();
    state.request = request;
  }

  private getClient(): Promise<CopilotClient> {
    if (this.shuttingDown) return Promise.reject(new Error("Copilot Provider is shutting down"));
    if (this.transportFailure) return Promise.reject(this.transportFailure);
    if (this.client) return Promise.resolve(this.client);
    this.clientTask ??= this.startClient().catch((error: unknown) => { this.clientTask = undefined; throw error; });
    return this.clientTask;
  }

  private async startClient(): Promise<CopilotClient> {
    const launch = await bounded(this.ports.launch.resolve(), 30_000, "Copilot launch resolution");
    if (this.shuttingDown) throw new Error("Copilot Provider is shutting down");
    this.configDir = copilotConfigDirectory(launch.env);
    const client = new CopilotClient({ ...launch, cliArgs: ["--no-auto-update"] });
    this.startingClient = client;
    try { await bounded(client.start(), 30_000, "Copilot SDK startup"); }
    catch (error) { await bounded(client.forceStop(), 5_000, "Copilot failed startup cleanup"); throw error; }
    finally { this.startingClient = undefined; }
    this.client = client;
    this.watchConnection(client);
    return client;
  }

  // A CLI that exits emits no session event and the SDK has no public close event, so polling is the only way to see it.
  private watchConnection(client: CopilotClient): void {
    this.connectionWatch = setInterval(() => {
      const connection = client.getState();
      if (connection !== "disconnected" && connection !== "error") return;
      void this.retireLostClient(client).catch((error: unknown) => logger.error("Copilot lost client retirement failed", { error: toError(error).message }));
    }, 1_000);
    this.connectionWatch.unref?.();
  }

  // Unlike failTransport this does not fence the provider: the CLI is gone, so a fresh client can resume the native sessions.
  private async retireLostClient(client: CopilotClient): Promise<void> {
    if (this.client !== client || this.shuttingDown) return;
    clearInterval(this.connectionWatch);
    this.connectionWatch = undefined;
    this.client = undefined;
    this.clientTask = undefined;
    const error = new Error("Copilot CLI disconnected");
    for (const admission of this.admissions.values()) admission.controller.abort(error);
    const idle: string[] = [];
    for (const state of this.runtime.states()) {
      state.clientLost = true;
      const turn = state.turn;
      if (!turn) { idle.push(state.sessionId); continue; }
      turn.settle("failed", error);
      this.publishTurnError(state, turn, error.message);
    }
    await Promise.allSettled(idle.map((sessionId) => this.runtime.stop(sessionId)));
    await bounded(client.forceStop(), 5_000, "Copilot lost client cleanup");
  }

  /** Creates one SDK session, preserving discovery and explicit resume failures. */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CopilotSessionState>> {
    const admission = this.admissions.get(args.sessionId);
    if (!admission) throw new Error("Copilot turn admission is missing");
    const request = admission.request;
    if (admission.utility) {
      const session = await this.awaitNativeResource((await this.getClient()).createSession({ onPermissionRequest: approveAll, model: request.model || undefined, workingDirectory: args.cwd, enableConfigDiscovery: true, skillDirectories: userSkillDirectories(), systemMessage: { content: readUserInstructions() ?? "" } }), 30_000, "Copilot session startup");
      return { state: { sessionId: args.sessionId, session, planRoot: "", cwd: args.cwd, request, browserGrant: null, browserCapability: "privileged", nativeEventIds: new Set(), sessionGrants: new Set(), utilityBusy: true }, pids: [] };
    }
    const browserCapability = providerBrowserPermissionCapability(request.permissionMode, request.interactionMode);
    const stage = this.host.browser.stage({ providerId: this.id, providerSessionId: args.resumeFrom ?? args.sessionId, mcodeSessionId: args.sessionId, threadId: args.threadId, workspaceId: request.workspaceId, permissionCapability: browserCapability });
    const browserGrant = this.host.browser.issue(stage);
    try {
      const client = await this.getClient();
      const options = await this.sessionOptions(request, browserGrant, args.sessionId);
      const operation = openCopilotSession(client, options, args.resumeFrom, request.resumeRequired === true);
      const session = await this.awaitNativeResource(operation, 30_000, "Copilot session startup");
      const planRoot = NodePath.join(options.configDir, "session-state", session.sessionId);
      return { state: { sessionId: args.sessionId, session, planRoot, cwd: args.cwd, request, browserGrant, browserCapability, nativeEventIds: new Set(), sessionGrants: new Set() }, pids: [] };
    } catch (error) {
      if (browserGrant) this.host.browser.release(browserGrant.leaseId);
      await bounded(this.host.mcode.close(args.sessionId), 5_000, "Copilot startup mcode close");
      throw error;
    } finally {
      if (!browserGrant) this.host.browser.release(stage.leaseId);
    }
  }

  private async awaitNativeResource<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    // SessionRuntime retains pending spawn/close ownership after caller cancellation.
    // SDK resume cleanup and disconnect both mutate resources by native session ID.
    try { return await bounded(operation, timeoutMs, label); }
    catch (error) {
      if (error instanceof CopilotDeadlineError) await this.failTransport(error);
      throw error;
    }
  }

  private async failTransport(error: Error): Promise<void> {
    // A deadline does not cancel the native RPC. Fence reuse before releasing its runtime slot.
    this.transportFailure ??= error;
    for (const admission of this.admissions.values()) admission.controller.abort(this.transportFailure);
    for (const state of this.runtime.states()) state.turn?.settle("failed", error);
    const client = this.client;
    if (client) {
      this.forceStopTask ??= bounded(client.forceStop(), 5_000, "Copilot failed transport cleanup");
      try { await this.forceStopTask; }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Copilot native transport retirement failed"); }
    }
  }

  /** `sessionId` must be the id the Browser lease was staged under, or the mcode server finds no lease and drops Browser tools. */
  private async sessionOptions(request: TurnRequest<"copilot">, browser: ProviderBrowserLeaseGrant | null, sessionId: string) {
    const mcode = await this.host.mcode.attach({ providerId: this.id, sessionId, threadId: request.threadId, threadControl: true });
    const instructions = renderMcodeInstructionSections(buildMcodeInstructionSections({
      toolkits: { ...(mcode?.toolkits ?? NO_MCODE_TOOLKITS), browser: Boolean(mcode?.toolkits.browser && browser) },
    }));
    const mcpServers: Record<string, MCPServerConfig> = mcode
      ? { [mcode.serverName]: { type: "http", url: mcode.url, headers: { Authorization: `Bearer ${mcode.token}` }, tools: ["*"] } }
      : {};
    return {
      configDir: await this.resolveConfigDirectory(),
      onPermissionRequest: (permission: NativePermissionRequest) => this.requestPermission(request.sessionId, permission),
      model: request.model || undefined,
      reasoningEffort: await this.reasoningEffort(request),
      workingDirectory: request.cwd,
      enableConfigDiscovery: true,
      skillDirectories: userSkillDirectories(),
      systemMessage: composeCopilotSystemMessage(readUserInstructions(), instructions),
      mcpServers,
    };
  }

  private async runTurn(state: CopilotSessionState): Promise<void> {
    const request = state.request;
    const routing = routingFor(request);
    let finish!: () => void;
    let failure: Error | undefined;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const turn: CopilotTurnState = { turnExecutionId: request.turnExecutionId, invocations: new Map(), nativeIdleObserved: false, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, tools: new Map(), pendingPermissions: new Map(), completed, settle: (outcome, error) => {
      turn.outcome ??= outcome;
      failure ??= error;
      finish();
    } };
    state.turn = turn;
    const unsubscribe = state.session.on((event) => this.acceptNativeEvent(state, turn, event));
    this.publish(state, { type: "system", threadId: request.threadId, subtype: `sdk_session_id:${state.session.sessionId}` });
    try {
      const planBaseline = await this.readPlanBaseline(state);
      await bounded(state.session.send({ prompt: request.message, attachments: request.attachments?.map((attachment) => ({ type: "file" as const, path: attachment.sourcePath })) }), 30_000, "Copilot turn dispatch");
      await completed;
      await this.publishPlanTurnMessage(state, turn, planBaseline);
    } catch (error) {
      turn.settle("failed", toError(error));
      this.publishTurnError(state, turn, toError(error).message);
    } finally {
      unsubscribe();
      this.cancelPermissions(state, "turn_ended");
      this.publishOpenChildEndings(state, turn);
      this.publishAssistantTextBoundary(state, turn);
      if (turn.outcome === "completed") this.publish(state, { type: "turnComplete", threadId: request.threadId, reason: "end_turn", costUsd: null, tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, contextWindow: turn.contextWindow, totalProcessedTokens: turn.tokensIn + turn.tokensOut + turn.cacheRead + turn.cacheWrite, cacheReadTokens: turn.cacheRead, cacheWriteTokens: turn.cacheWrite, costMultiplier: turn.cost, providerId: this.id });
      this.publish(state, { type: "ended", threadId: request.threadId, turnExecutionId: request.turnExecutionId, ...(turn.outcome === "completed" ? {} : { outcome: turn.outcome === "cancelled" ? "cancelled" as const : "errored" as const }) });
      try { await this.publisher.waitForExecution(routing); }
      finally {
        try { if (turn.abortTask) await bounded(turn.abortTask, 5_000, "Copilot turn interruption cleanup"); }
        finally {
          if (state.turn === turn) { state.turn = undefined; }
          if (turn.outcome === "failed") await this.runtime.stop(state.sessionId);
        }
      }
    }
    if (failure) throw failure;
  }

  private acceptNativeEvent(state: CopilotSessionState, turn: CopilotTurnState, event: SessionEvent): void {
    if (state.turn !== turn || turn.outcome === "completed" || turn.outcome === "failed") return;
    try {
      if (state.nativeEventIds.has(event.id)) return;
      const events = mapCopilotEvent(event, state.request.threadId, turn);
      rememberNativeEvent(state, event);
      this.runtime.recordUsage(state.sessionId);
      if (event.type === "session.idle" && state.request.interactionMode !== "plan") this.publishCompletedAssistantMessage(state, turn);
      for (const mapped of events) this.publishMapped(state, mapped, event);
    } catch (error) {
      turn.settle("failed", toError(error));
      this.publishTurnError(state, turn, toError(error).message);
      turn.abortTask ??= state.session.abort();
    }
  }

  /**
   * Native capture is best effort because the planning prompt's fence is the fallback, so a failed
   * read is logged and skipped. A deadline already retired the transport and still ends the turn.
   */
  private async readNativePlan(state: CopilotSessionState): Promise<{ content: string; path: string | null; hash: string } | undefined> {
    try {
      const plan = await this.awaitNativeResource(state.session.rpc.plan.read(), 30_000, "Copilot plan capture");
      if (!plan.exists || !plan.content?.trim() || plan.content.length > PLAN_MAX_CONTENT_CHARS) return undefined;
      return { content: plan.content, path: plan.path, hash: NodeCrypto.createHash("sha256").update(plan.content).digest("hex") };
    } catch (error) {
      if (error instanceof CopilotDeadlineError) throw error;
      logger.warn("Copilot native plan read failed; using the fence", { threadId: state.request.threadId, error: toError(error).message });
      return undefined;
    }
  }

  private async readPlanBaseline(state: CopilotSessionState): Promise<string | undefined> {
    return state.request.interactionMode === "plan" ? (await this.readNativePlan(state))?.hash : undefined;
  }

  /** Captures only a plan this turn changed, so an unchanged file cannot supersede a plan the user edited in Mcode. */
  private async captureNativePlan(state: CopilotSessionState, turn: CopilotTurnState, baseline: string | undefined): Promise<void> {
    const plan = await this.readNativePlan(state);
    if (!plan || plan.hash === baseline) return;
    const nativePlanFile = plan.path ? await captureNativePlanFile({ path: plan.path, planRoot: state.planRoot, sessionId: state.session.sessionId, markdown: plan.content })
      .catch((error: unknown) => {
        logger.warn("Copilot native plan file not captured", { threadId: state.request.threadId, error: toError(error).message });
        return null;
      }) : null;
    const capture = { markdown: plan.content, source: "native" as const, ...(nativePlanFile ? { nativePlanFile } : {}) };
    this.publisher.capturePlan(routingFor(state.request), capture);
    this.emit("plan_captured", { threadId: state.request.threadId, ...capture });
    if (!turn.pendingAssistantMessage) this.publish(state, { type: "message", threadId: state.request.threadId, content: plan.content, tokens: null });
  }

  private async publishPlanTurnMessage(state: CopilotSessionState, turn: CopilotTurnState, baseline: string | undefined): Promise<void> {
    if (turn.outcome !== "completed" || state.request.interactionMode !== "plan") return;
    try { await this.captureNativePlan(state, turn, baseline); }
    catch (error) { turn.outcome = "failed"; throw error; }
    this.publishCompletedAssistantMessage(state, turn);
  }

  private publishMapped(state: CopilotSessionState, mapped: CopilotMappedEvent, native?: SessionEvent): void {
    if (mapped.event.type === "error" && !mapped.childThread) this.cancelPermissions(state, "turn_ended");
    this.publish(state, mapped.event, native, mapped.childThread);
  }

  private publishOpenChildEndings(state: CopilotSessionState, turn: CopilotTurnState): void {
    const outcome = turn.outcome === "completed" ? "interrupted" : turn.outcome === "cancelled" ? "cancelled" : "errored";
    for (const mapped of closeOpenChildren(turn, state.request.threadId, outcome)) this.publishMapped(state, mapped);
  }

  /** The error terminal closes the turn server-side, so pending approvals settle ahead of it. */
  private publishTurnError(state: CopilotSessionState, turn: CopilotTurnState, message: string): void {
    this.publishAssistantTextBoundary(state, turn);
    this.cancelPermissions(state, "turn_ended");
    this.publish(state, { type: "error", threadId: state.request.threadId, error: message, failure: { kind: "fatal" } });
  }

  private publishCompletedAssistantMessage(state: CopilotSessionState, turn: CopilotTurnState): void {
    if (!turn.nativeIdleObserved || turn.outcome !== "completed") return;
    const native = turn.pendingAssistantMessage;
    if (!native) return;
    // A native model-loop snapshot becomes the authoritative parent body only at successful idle.
    turn.pendingAssistantMessage = undefined;
    turn.assistantText = undefined;
    this.publish(state, { type: "message", threadId: state.request.threadId,
      content: native.data.content, tokens: native.data.outputTokens ?? null }, native);
  }

  private publishAssistantTextBoundary(state: CopilotSessionState, turn: CopilotTurnState): void {
    const content = turn.assistantText?.content;
    turn.assistantText = undefined;
    if (content) this.publish(state, { type: "assistantMessageBoundary", threadId: state.request.threadId, isFinalResponse: true });
  }

  private publish(state: CopilotSessionState, event: AgentEvent, native?: SessionEvent, childThread?: ChildThreadEvidence): void {
    this.endOpenChildrenBeforeParentError(state, event, childThread);
    this.publisher.publish(routingFor(state.request), providerRuntimeEvent({ ...event, turnExecutionId: state.request.turnExecutionId }, childThread ? { providerId: "copilot", kind: "child-thread", childThread } : undefined), nativeIdentities(state.session.sessionId, native), native ? { id: native.id, timestamp: native.timestamp, predecessorEventId: native.parentId, type: native.type, data: nativeEvidence(native) } : undefined);
  }

  private endOpenChildrenBeforeParentError(state: CopilotSessionState, event: AgentEvent, childThread?: ChildThreadEvidence): void {
    if (event.type === "error" && !childThread && state.turn) this.publishOpenChildEndings(state, state.turn);
  }

  private requestPermission(sessionId: string, native: NativePermissionRequest): Promise<PermissionRequestResult> | PermissionRequestResult {
    const state = this.runtime.get(sessionId);
    const turn = state?.turn;
    if (!state || !turn || turn.outcome) return { kind: "denied-interactively-by-user" };
    const policy = nativeApprovalPolicy(state.request, native, NodePath.join(state.planRoot, "plan.md"));
    if (policy) return policy;
    if (this.consumePermissionGrant(state, native)) return { kind: "approved" };
    const scope = copilotSessionScope(native);
    if (scope?.keys.every((key) => state.sessionGrants.has(key))) return { kind: "approved" };
    if (turn.pendingPermissions.size >= 64) return { kind: "denied-by-rules", rules: [] };
    const requestId = NodeCrypto.randomUUID();
    const body = copilotApprovalBody(native, scope);
    const request = { requestId, threadId: state.request.threadId, body };
    return new Promise((resolve) => {
      turn.pendingPermissions.set(requestId, { request, resolve, sessionGrantKeys: scope?.keys ?? [] });
      this.emit("approval_request", request);
    });
  }
  private consumePermissionGrant(state: CopilotSessionState, native: NativePermissionRequest): boolean {
    const path = typeof native.path === "string" ? native.path : typeof native.fileName === "string" ? native.fileName : undefined;
    return Boolean(path && this.host.grants.consume({ threadId: state.request.threadId, toolName: native.kind === "read" ? "Read" : native.kind, path }));
  }

  /** Resolve the live native handler before publishing the outcome. */
  async resolveApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    for (const state of this.runtime.states()) {
      const turn = state.turn;
      if (!turn) continue;
      const pending = turn.pendingPermissions.get(requestId);
      if (!pending) continue;
      if ("autoDeny" in response) pending.unanswerable = true;
      const choice = approvalChoice(pending.request.body, response);
      if (!choice && !("autoDeny" in response)) return { status: "failed", message: "The approval choice is unavailable" };
      if (choice?.id === "allow-session") {
        for (const key of pending.sessionGrantKeys) state.sessionGrants.add(key);
      }
      pending.resolve(this.nativeApprovalResult(choice, response));
      turn.pendingPermissions.delete(requestId);
      await Promise.resolve();
      this.publish(state, approvalReceipt(pending.request, approvalOutcome(choice, response)));
      this.emit("approval_resolved", { requestId, threadId: pending.request.threadId,
        outcome: approvalOutcome(choice, response) });
      return { status: "resolved" };
    }
    return { status: "not_pending" };
  }

  private nativeApprovalResult(choice: ApprovalChoice | undefined, response: ApprovalResponse): PermissionRequestResult {
    if ("autoDeny" in response) return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
    if (choice?.intent !== "deny") return { kind: "approved" };
    return { kind: "denied-interactively-by-user", ...(response.note ? { feedback: response.note } : {}) };
  }

  /** List stable routing and display bodies from pending native callbacks. */
  listPendingApprovals(threadId?: string): ApprovalRequestEnvelope[] {
    return this.runtime.states().filter((state) => threadId === undefined || state.request.threadId === threadId)
      .flatMap((state) => [...state.turn?.pendingPermissions.values() ?? []].map((pending) => pending.request));
  }

  private cancelPermissions(state: CopilotSessionState, reason: "session_stopped" | "turn_ended" = "session_stopped"): void {
    const turn = state.turn;
    if (!turn) return;
    for (const [requestId, pending] of turn.pendingPermissions) {
      turn.pendingPermissions.delete(requestId);
      pending.resolve({ kind: "denied-interactively-by-user" });
      const outcome = { status: "cancelled", reason: pending.unanswerable ? "unanswerable" : reason } satisfies import("@mcode/contracts").ApprovalOutcome;
      this.publish(state, approvalReceipt(pending.request, outcome));
      this.emit("approval_resolved", { requestId, threadId: pending.request.threadId, outcome });
    }
    turn.pendingPermissions.clear();
  }

  /** Reports the protocol busy guard to SessionRuntime. */
  isBusy(state: CopilotSessionState): boolean { return state.turn !== undefined || state.controls !== undefined || state.utilityBusy === true; }
  /** Rejects reuse when the native working directory would be wrong. */
  isStale(state: CopilotSessionState, args: { cwd: string }): boolean { return state.retireRequested === true || state.cwd !== args.cwd; }
  /** Interrupts a turn through SDK abort without disconnecting the native session. */
  async interrupt(state: CopilotSessionState): Promise<void> {
    await state.controls;
    if (!state.turn) { if (state.utilityBusy) await bounded(state.session.abort(), 5_000, "Copilot utility interruption"); return; }
    if (state.turn.outcome === "completed" || state.turn.outcome === "failed") return;
    this.cancelPermissions(state);
    state.turn.outcome ??= "cancelled";
    const turn = state.turn;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      turn.abortTask ??= state.session.abort();
      await bounded(turn.abortTask, 5_000, "Copilot turn interruption");
      await Promise.race([turn.completed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
    } finally {
      clearTimeout(timer);
      turn.settle("cancelled");
      if (!turn.nativeIdleObserved) state.retireRequested = true;
    }
  }
  /** Closes a native session and all host leases exactly once under the runtime. */
  async close(state: CopilotSessionState): Promise<void> {
    state.turn?.settle("cancelled");
    state.nativeEventIds.clear();
    state.sessionGrants.clear();
    try {
      try { await state.controls; }
      // A session on a lost client rejects every RPC, so disconnect has nothing left to release.
      finally { if (!state.clientLost) await this.awaitNativeResource(state.session.disconnect(), 5_000, "Copilot session close"); }
    }
    finally {
      if (state.browserGrant) this.host.browser.release(state.browserGrant.leaseId);
      await bounded(this.host.mcode.close(state.sessionId), 5_000, "Copilot mcode close");
    }
  }
  /** Cancels an admitted/running turn; preserves its session for an ordinary follow-up. */
  async stopSession(sessionId: string): Promise<void> {
    const admission = this.admissions.get(sessionId);
    admission?.controller.abort();
    const state = this.runtime.get(sessionId);
    if (state?.turn) {
      try { await this.interrupt(state); }
      finally { if (state.retireRequested) await this.runtime.stop(sessionId); }
    }
    else if (admission) await this.runtime.stop(sessionId);
  }
  /** Explicitly discards session context when the server requires replacement. */
  async discardSession(sessionId: string): Promise<void> { await this.runtime.stop(sessionId); }
  /** Routes a failed canonical delivery to the server authority for its exact execution. */
  setCanonicalTurnDeliveryFailureHandler(handler: (routing: CanonicalLiveEventRouting, error: Error) => Promise<void>): void { this.deliveryFailureHandler = handler; }
  /** Evicts only sessions the shared runtime confirms are idle and unprotected. */
  async evictNonBusySessions(reason: string, isProtected?: (sessionId: string) => boolean): Promise<{ before: number; after: number; evicted: string[] }> { return this.runtime.evictNonBusy(reason, isProtected); }

  /** Fetches the native model catalog with a bounded ten-minute cache. */
  async listModels(): Promise<ProviderModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 600_000) return this.modelCache.models;
    const models = (await bounded((await this.getClient()).listModels(), 30_000, "Copilot model catalog")).map(mapModel);
    this.modelCache = { at: Date.now(), models };
    return models;
  }
  private async reasoningEffort(request: TurnRequest<"copilot">): Promise<"low" | "medium" | "high" | "xhigh" | undefined> {
    const model = (await this.listModels()).find((entry) => entry.id === request.model);
    if (!model?.supportsReasoning) return undefined;
    const requested = nativeReasoningEffort(request.reasoningLevel);
    if (requested && model.supportedReasoningEfforts?.includes(requested)) return requested;
    const fallback = nativeReasoningEffort(model.defaultReasoningEffort);
    return fallback && model.supportedReasoningEfforts?.includes(fallback) ? fallback : undefined;
  }
  /** Fetches native account quota without introducing a second session pool. */
  async getUsage() {
    const quota = await (await this.getClient()).rpc.account.getQuota();
    return { providerId: this.id, quotaCategories: normalizeQuotaSnapshots(quota.quotaSnapshots ?? {}) };
  }
  /** Reports sign-in from the SDK's own auth status; a slow or failed SDK reads as unknown. */
  async describeStatus() {
    const auth = await describeCopilotAuth(async () => bounded((await this.getClient()).getAuthStatus(), 5_000, "Copilot auth status"));
    return { ...auth, cli: this.ports.launch.describeCli?.() };
  }
  /** Invalidates server-owned CLI discovery after an update. */
  clearCliVersionCache(): void {
    this.ports.launch.clearCliVersionCache?.();
  }
  /** Runs an isolated utility completion with native configuration discovery. */
  async complete(prompt: string, model: string, cwd: string, _options?: CompletionOptions): Promise<string> {
    return this.runUtility(prompt, cwd, model);
  }
  private async runUtility(prompt: string, cwd: string, model?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.shuttingDown) throw new Error("Copilot Provider is shutting down");
    const sessionId = `copilot-utility-${NodeCrypto.randomUUID()}`;
    const controller = new AbortController();
    const request: TurnRequest<"copilot"> = { sessionId, threadId: sessionId, turnId: NodeCrypto.randomUUID(), turnExecutionId: NodeCrypto.randomUUID(), workspaceId: sessionId, message: prompt, cwd, model: model ?? "", permissionMode: "full", interactionMode: "build", approvalReviewMode: "manual", providerOptions: {} };
    this.admissions.set(sessionId, { request, controller, utility: true });
    const abort = (): void => { controller.abort(); void this.runtime.stop(sessionId).catch((error: unknown) => logger.warn("Copilot utility stop failed", { error: toError(error).message })); };
    signal?.addEventListener("abort", abort, { once: true });
    const operation = this.runUtilitySession(request, controller.signal).finally(() => { this.admissions.delete(sessionId); signal?.removeEventListener("abort", abort); });
    const task = operation.then(() => {}, () => {}).finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
    return operation;
  }
  private async runUtilitySession(request: TurnRequest<"copilot">, signal: AbortSignal): Promise<string> {
    try {
      await abortable(this.getClient(), signal);
      signal.throwIfAborted();
      const state = await this.runtime.acquire({ sessionId: request.sessionId, threadId: request.threadId, cwd: request.cwd, permissionMode: request.permissionMode, signal });
      const response = await abortable(bounded(state.session.sendAndWait({ prompt: request.message }, 120_000), 120_000, "Copilot utility completion"), signal);
      signal.throwIfAborted();
      const text = response?.data.content?.trim();
      if (!text) throw new Error("Copilot returned no text content");
      return text;
    } finally { await this.runtime.stop(request.sessionId); }
  }

  /** Fences admission, awaits native cleanup, and stops the SDK's publicly owned client. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.connectionWatch);
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }
  private async performShutdown(): Promise<void> {
    for (const admission of this.admissions.values()) admission.controller.abort();
    if (this.startingClient) await bounded(this.startingClient.forceStop(), 5_000, "Copilot startup shutdown");
    const results = await Promise.allSettled([this.runtime.shutdown(), this.clientTask]);
    results.push(...await Promise.allSettled(this.tasks));
    results.push(...await Promise.allSettled([this.publisher.stopAdmissionAndDrain()]));
    const client = this.client;
    if (client) {
      const errors = await bounded(client.stop(), 5_000, "Copilot SDK shutdown").catch(async (error: unknown) => { await bounded(client.forceStop(), 5_000, "Copilot SDK forced shutdown"); return [toError(error)]; });
      if (errors.length) { await bounded(client.forceStop(), 5_000, "Copilot SDK stop failure cleanup"); results.push({ status: "rejected", reason: new AggregateError(errors, "Copilot SDK stop failed") }); }
    }
    results.push(...await Promise.allSettled([this.forceStopTask]));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Copilot provider shutdown failed");
  }
}

function routingFor(request: TurnRequest<"copilot">): CanonicalLiveEventRouting { return { threadId: request.threadId, turnId: request.turnId, executionId: request.turnExecutionId, deliveryAttempt: request.deliveryAttempt ?? 1 }; }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
/** A required resume that Copilot rejects tells the server to recover from a seeded session instead. */
async function openCopilotSession(client: CopilotClient, options: Parameters<CopilotClient["resumeSession"]>[1], resumeFrom: string | undefined, resumeRequired: boolean): Promise<CopilotSession> {
  if (!resumeFrom) return client.createSession(options);
  if (!resumeRequired) return client.resumeSession(resumeFrom, options);
  try { return await client.resumeSession(resumeFrom, options); }
  catch (error) { throw new SessionResumeUnavailableError(`Copilot could not resume the saved session: ${toError(error).message}`, { cause: error }); }
}
function nativeEvidence(event: SessionEvent): Record<string, unknown> {
  const evidence: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(event.data)) {
    if (["toolCallId", "parentToolCallId", "agentId", "agentName", "agentDisplayName", "turnId", "aborted"].includes(name)) evidence[name] = value;
  }
  const notification = agentNotificationEvidence(event);
  if (notification) evidence.kind = notification;
  return evidence;
}

const agentNotificationSchema = z.object({ type: z.string(), agentId: z.string(), agentType: z.string().optional(), status: z.string().optional() });
function agentNotificationEvidence(event: SessionEvent): z.infer<typeof agentNotificationSchema> | undefined {
  if (event.type !== "system.notification") return undefined;
  const parsed = agentNotificationSchema.safeParse(event.data.kind);
  return parsed.success ? parsed.data : undefined;
}

function rememberNativeEvent(state: CopilotSessionState, event: SessionEvent): void {
  if (state.nativeEventIds.size >= 8_192) state.nativeEventIds.delete(state.nativeEventIds.values().next().value ?? "");
  state.nativeEventIds.add(event.id);
}
function nativeIdentities(sessionId: string, event?: SessionEvent): ProviderIdentity[] {
  const identities: ProviderIdentity[] = [{ providerId: "copilot", scope: "session", value: sessionId, provenance: "native" }];
  if (!event) return identities;
  const data = new Map(Object.entries(event.data));
  const fields = [{ name: "toolCallId", scope: "item" }, { name: "parentToolCallId", scope: "parentItem" }, { name: "turnId", scope: "turn" }] as const;
  for (const { name, scope } of fields) {
    const value = data.get(name);
    if (typeof value === "string") identities.push({ providerId: "copilot", scope, value, provenance: "native" });
  }
  const notification = agentNotificationEvidence(event);
  if (notification) identities.push({ providerId: "copilot", scope: "agent", value: notification.agentId, provenance: "native" });
  return identities;
}
function copilotConfigDirectory(env: Record<string, string>): string {
  return env.COPILOT_HOME || NodePath.join(NodeOS.homedir(), ".copilot");
}

function nativeApprovalPolicy(request: TurnRequest<"copilot">, permission: NativePermissionRequest, planPath: string): PermissionRequestResult | Promise<PermissionRequestResult> | undefined {
  if (!["read", "write", "shell", "mcp", "url", "custom-tool"].includes(permission.kind)) return { kind: "denied-by-rules", rules: [] };
  if (request.interactionMode === "plan") {
    if (permission.kind === "read") return { kind: "approved" };
    if (permission.kind === "write" && typeof permission.fileName === "string") {
      return canWriteNativePlanFile({ path: permission.fileName, expectedPath: planPath }).then((allowed): PermissionRequestResult => allowed ? { kind: "approved" } : { kind: "denied-by-rules", rules: [] });
    }
    return { kind: "denied-by-rules", rules: [] };
  }
  return request.permissionMode === "full" ? { kind: "approved" } : undefined;
}
function mapModel(model: ModelInfo): ProviderModelInfo {
  return { id: model.id, name: model.name, group: inferModelGroup(model.id), ...modelCapabilities(model), supportedReasoningEfforts: model.supportedReasoningEfforts?.filter(isReasoningEffort), defaultReasoningEffort: isReasoningEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined, policy: model.policy && isPolicyState(model.policy.state) ? { state: model.policy.state } : undefined, multiplier: model.billing?.multiplier };
}
function modelCapabilities(model: ModelInfo): Pick<ProviderModelInfo, "contextWindow" | "supportsVision" | "supportsReasoning"> {
  return { contextWindow: model.capabilities?.limits?.max_context_window_tokens, supportsVision: model.capabilities?.supports?.vision, supportsReasoning: model.capabilities?.supports?.reasoningEffort };
}

function isReasoningEffort(value: unknown): value is NonNullable<ProviderModelInfo["defaultReasoningEffort"]> { return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value); }
function isPolicyState(value: unknown): value is "enabled" | "disabled" | "unconfigured" { return typeof value === "string" && ["enabled", "disabled", "unconfigured"].includes(value); }

function nativeReasoningEffort(value: TurnRequest<"copilot">["reasoningLevel"]): "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === "max") return "xhigh";
  if (value === "none" || value === "minimal") return "low";
  return value;
}
class CopilotDeadlineError extends Error {}
async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CopilotDeadlineError(`${label} timed out`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); })]);
  } finally { signal.removeEventListener("abort", abort); }
}
