import { SUBAGENT_REPORTING } from "@mcode/contracts";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { z } from "zod";
import { logger } from "@mcode/shared";
import type {
  ProviderStatusFacts,
  AgentEvent,
  ApprovalReviewSupport,
  IAgentProvider,
  IApprovalReviewCapable,
  ISessionEvictable,
  ApprovalResponse,
  ApprovalRespondResult,
  ApprovalOutcome,
  ApprovalOrigin,
  ApprovalRequestBody,
  ApprovalQuestion,
  ApprovalRequestEnvelope,
  ApprovalAnswers,
  ProviderId,
  ProviderModelInfo,
  ProviderIdentity,
  ProviderTurnDiffUpdate,
  TurnRequest,
  TurnFailure,
  NativePlanFileOutcome,
  NativePlanFileRef,
} from "@mcode/contracts";
import { AgentEventType, lazySchema, providerRuntimeEvent } from "@mcode/contracts";
import type { ProviderHostPorts } from "@mcode/providers";
import {
  OpenCodeNativeTurnDiff,
  SessionResumeUnavailableError,
  approvalChoice,
  approvalOutcome,
  approvalReceipt,
  createCliStatusRunner,
  readCliStatusVersion,
  resolveCliStatusBinary,
  describeOpenCodeAuth,
  captureOwnedPlanFile,
  deleteOwnedPlanFile,
} from "@mcode/providers";
import { SettingsService } from "../../../settings/settings-service.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import {
  CanonicalLiveEventPublisher,
  type CanonicalLiveEventRouting,
} from "../../composition/canonical-live-event-publisher.js";
import { OpenCodeServerPool, type OpenCodePoolKey } from "./opencode-server-pool.js";
import {
  defaultOpenCodeHttpClient,
  OpenCodeReplySessionNotFoundError,
  type OpenCodeEndpoint,
  type OpenCodeHttpClient,
  type OpenCodeRequestVersion,
} from "./opencode-http-client.js";
import { classifyOpenCodeFailure, mapOpenCodeEnvelope, normalizeOpenCodeEnvelope, trackOpenCodePartType, type OpenCodeMappedOutput } from "./opencode-event-mapper.js";
import {
  mapApprovalChoiceToReply,
  synthesizeOpenCodeApprovalRequest,
  synthesizeOpenCodeQuestionRequest,
} from "./opencode-permission-mapper.js";
import { formatOpenCodeResumeCursor, parseOpenCodeResumeCursor } from "./opencode-resume-cursor.js";
import { probeOpenCodeCli } from "./opencode-cli.js";

const OPENCODE_SUPPORTED_CAPABILITIES = ["build", "plan", "permissions", "session-eviction", "turn-diff", "session-resume"] as const;

/** Visible notice when a missing upstream session forces a fresh start. */
const OPENCODE_SESSION_INVALIDATED_SUBTYPE = "sdk_session_invalidated";

/** Loopback hostname every pooled serve binds to. Pool keys never vary it. */
const OPENCODE_SERVE_HOSTNAME = "127.0.0.1";

/** Largest retained per-thread notice set before pruning oldest. */
const MAX_SEEN_NOTICES_PER_THREAD = 64;

/** Delay between idle-confirmation status polls. */
const OPENCODE_IDLE_POLL_INTERVAL_MS = 2_000;
/** Consecutive idle polls with no new activity before the turn settles. */
const OPENCODE_IDLE_REQUIRED_POLLS = 3;
/** Longest an idle confirmation runs before settling anyway. */
const OPENCODE_IDLE_CONFIRM_TIMEOUT_MS = 60_000;
/** Consecutive failed status polls before the turn errors visibly. */
const OPENCODE_IDLE_MAX_POLL_ERRORS = 3;

/** Bounded idle-confirmation timings (overridable in tests). */
export interface OpenCodeIdleConfirm {
  intervalMs: number;
  requiredPolls: number;
  timeoutMs: number;
  maxPollErrors: number;
}

/** Mutable progress of one idle-confirmation loop. */
interface IdleConfirmProgress {
  startedActivity: number;
  idlePolls: number;
  pollErrors: number;
  deadline: number;
}

const DEFAULT_IDLE_CONFIRM: OpenCodeIdleConfirm = {
  intervalMs: OPENCODE_IDLE_POLL_INTERVAL_MS,
  requiredPolls: OPENCODE_IDLE_REQUIRED_POLLS,
  timeoutMs: OPENCODE_IDLE_CONFIRM_TIMEOUT_MS,
  maxPollErrors: OPENCODE_IDLE_MAX_POLL_ERRORS,
};

/** One upstream permission or question ask awaiting the user's decision. */
interface OpenCodePendingAsk {
  unanswerable?: boolean;
  request: ApprovalRequestEnvelope & { body: ApprovalRequestBody };
  sessionId: string;
  upstreamSessionId: string;
  endpoint: OpenCodeEndpoint;
  kind: "permission" | "question";
  version: OpenCodeRequestVersion;
  signal: AbortSignal;
  routing: CanonicalLiveEventRouting;
  replying: boolean;
}

/**
 * Where a turn's requests go. A pooled lease borrows a reference on an
 * app-owned serve child; an attached lease points at an external server the
 * app never spawns, releases into idle close, or terminates.
 */
type OpenCodeServeLease =
  | { kind: "pooled"; key: OpenCodePoolKey; endpoint: OpenCodeEndpoint }
  | { kind: "attached"; endpoint: OpenCodeEndpoint };

interface OpenCodeTurnState {
  threadId: string;
  sessionCwd: string | null;
  nativePlanPath: string | null;
  createdPlanPaths: Set<string>;
  /**
   * Session-wide, not per turn: OpenCode replays a still-pending ask in the next
   * turn under the same id, and receipts are keyed by request id, so a second
   * receipt would conflict with the first.
   */
  receiptRequestIds: Set<string>;
  upstreamSessionId: string;
  /** Last lease this session ran on; stop aborts through it. */
  lease: OpenCodeServeLease | null;
  abortController: AbortController;
  active: boolean;
  aborted: boolean;
  chain: Promise<void>;
  /** True while one idle confirmation is polling; prevents poll pileup. */
  idleConfirming: boolean;
  /** A newer idle arrived while confirming; the loop restarts its baseline. */
  idleRestart: boolean;
  /** In-flight idle confirmation; the stream-end fallback awaits it. */
  idleConfirmPromise: Promise<void> | null;
  /** Upstream message id to role, so user parts never become assistant deltas. */
  messageRoles: Map<string, string>;
  childSessionCalls: Map<string, OpenCodeChildTask>;
  /** Text already forwarded per message or reasoning part, for exactly-once streaming. */
  forwardedText: Map<string, string>;
  /** Upstream part id to part type, so reasoning deltas never become answer text. */
  partTypes: Map<string, string>;
  /** Native turn-diff accumulator and its monotonic push cursor for this turn. */
  nativeDiff: OpenCodeNativeTurnDiff;
  nativeDiffRevision: number;
}

function nestedSessionId(holder: unknown): string | undefined {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return undefined;
  const sessionID = (holder as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 && sessionID.length <= 512 ? sessionID : undefined;
}

/** Split a `provider/model` slug into the upstream model reference. */
export function toOpenCodeModelRef(model: string | undefined): { providerID: string; modelID: string } | { modelID: string } | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { modelID: trimmed };
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function openCodePromptBody(req: TurnRequest<"opencode">): Record<string, unknown> {
  return { model: toOpenCodeModelRef(req.model), parts: [{ type: "text", text: req.message }],
    ...(req.planTurn ? { agent: "plan" } : {}) };
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trackedMessageRole(info: Record<string, unknown> | null): { id: string; role: "user" | "assistant" } | undefined {
  const id = info?.id;
  const role = info?.role;
  if (typeof id !== "string" || id.length === 0 || id.length > 512) return undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  return { id, role };
}

/** Largest retained upstream message-role map per turn before pruning oldest. */
const MAX_TRACKED_MESSAGE_ROLES = 256;

/** The `task` call that launched one child session, and the label its asks carry. */
interface OpenCodeChildTask {
  callId: string;
  label: string;
}

const childTaskInputSchema = z.object({
  description: z.string().trim().min(1).max(200).optional().catch(undefined),
  subagent_type: z.string().trim().min(1).max(200).optional().catch(undefined),
}).catch({});

const childTaskPartSchema = z.object({
  type: z.literal("tool"), tool: z.literal("task"), callID: z.string().min(1).max(512),
  state: z.object({ metadata: z.object({ sessionId: z.string().min(1).max(512) }), input: childTaskInputSchema.optional() }),
});

const nativePlanToolPartSchema = lazySchema(() => z.object({
  type: z.literal("tool"),
  sessionID: z.string().min(1),
  tool: z.enum(["write", "edit"]),
  state: z.object({
    status: z.literal("completed"),
    input: z.object({ filePath: z.string().min(1).max(32 * 1024) }),
    metadata: z.object({ exists: z.boolean() }).partial().optional(),
  }),
}));

function trackNativePlanFile(req: TurnRequest<"opencode">, state: OpenCodeTurnState,
  normalized: { type: string; properties: Record<string, unknown> }): void {
  const named = completedPlanFileWrite(req, state, normalized);
  // An `edit` is trusted only on a path this session already created.
  if (!named || (!named.created && !state.createdPlanPaths.has(named.path))) return;
  state.createdPlanPaths.add(named.path);
  state.nativePlanPath = named.path;
}

function completedPlanFileWrite(req: TurnRequest<"opencode">, state: OpenCodeTurnState,
  normalized: { type: string; properties: Record<string, unknown> }): { path: string; created: boolean } | null {
  if (!req.planTurn || normalized.type !== "message.part.updated") return null;
  if (sessionIdOfNormalized(normalized) !== state.upstreamSessionId) return null;
  const part = nativePlanToolPartSchema().safeParse(normalized.properties.part);
  if (!part.success || part.data.sessionID !== state.upstreamSessionId) return null;
  const path = NodePath.resolve(req.cwd, part.data.state.input.filePath);
  if (!isInsidePlanRoot(req.cwd, path)) return null;
  // OpenCode's `write` reports `exists: false` only when it created the file, the one ownership
  // proof it gives.
  return { path, created: part.data.tool === "write" && part.data.state.metadata?.exists === false };
}

/** Drop the upstream session and every plan claim made under it, so a replacement session starts unproven. */
function forgetUpstreamSession(state: OpenCodeTurnState): void {
  state.upstreamSessionId = "";
  state.sessionCwd = null;
  state.nativePlanPath = null;
  state.createdPlanPaths.clear();
}

// OpenCode roots plan files at the git root, not the session directory, so a project below the root
// writes outside this folder and claims nothing.
function isInsidePlanRoot(cwd: string, path: string): boolean {
  const relative = NodePath.relative(NodePath.join(cwd, ".opencode", "plans"), path);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative);
}

function trackChildTask(state: OpenCodeTurnState, normalized: { type: string; properties: Record<string, unknown> }): void {
  if (normalized.type !== "message.part.updated" || !sessionIdOfNormalized(normalized)) return;
  const task = childTaskPartSchema.safeParse(normalized.properties.part);
  if (!task.success) return;
  const input = task.data.state.input;
  const label = input?.description ?? input?.subagent_type ?? "Subagent";
  state.childSessionCalls.set(task.data.state.metadata.sessionId, { callId: task.data.callID, label });
  if (state.childSessionCalls.size > MAX_TRACKED_MESSAGE_ROLES) {
    const oldest = state.childSessionCalls.keys().next();
    if (!oldest.done) state.childSessionCalls.delete(oldest.value);
  }
}

const childToolPartSchema = z.object({ type: z.literal("tool") });

function isChildToolPart(normalized: { type: string; properties: Record<string, unknown> }): boolean {
  return normalized.type === "message.part.updated" && childToolPartSchema.safeParse(normalized.properties.part).success;
}

const ASK_EVENT_TYPES: ReadonlySet<string> = new Set(["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"]);

/**
 * A child session blocks on its own asks, and the parent `task` call waits on
 * the child, so dropping a child ask stalls the whole turn.
 */
function isForwardedChildEvent(normalized: { type: string; properties: Record<string, unknown> }): boolean {
  return isChildToolPart(normalized) || ASK_EVENT_TYPES.has(normalized.type);
}

/** The upstream session an ask belongs to and who in Mcode is asking. */
interface OpenCodeAskSource {
  upstreamSessionId: string;
  origin: ApprovalOrigin;
}

function askSourceOf(
  state: OpenCodeTurnState,
  upstreamId: string,
  normalized: { properties: Record<string, unknown> },
): OpenCodeAskSource {
  const owner = sessionIdOfNormalized(normalized);
  const child = owner === undefined || owner === upstreamId ? undefined : state.childSessionCalls.get(owner);
  if (owner === undefined || child === undefined) return { upstreamSessionId: upstreamId, origin: { kind: "agent" } };
  return { upstreamSessionId: owner, origin: { kind: "subagent", label: child.label, parentToolCallId: child.callId } };
}

function sessionIdOfNormalized(normalized: { properties: Record<string, unknown> }): string | undefined {
  return nestedSessionId(normalized.properties)
    ?? nestedSessionId(normalized.properties.info)
    ?? nestedSessionId(normalized.properties.part);
}

/** Canonical notices that can be replayed when the OpenCode SSE reconnects. */
function replayNoticeKey(event: AgentEvent): string | undefined {
  if (event.type === AgentEventType.ModelFallback) {
    return `model-fallback:${event.requestedModel}:${event.actualModel}`;
  }
  if (event.type === AgentEventType.System && event.subtype.startsWith("provider.notice.")) {
    return `notice:${event.subtype}:${event.message ?? ""}`;
  }
  return undefined;
}

function askVersion(type: string): OpenCodeRequestVersion {
  return type.endsWith(".v2.asked") ? "v2" : "legacy";
}

function isValidQuestionResponse(
  questions: ApprovalQuestion[] | undefined,
  decision: "allow" | "deny",
  answers: ApprovalAnswers | undefined,
): boolean {
  if (decision === "deny") return true;
  if (decision !== "allow" || !questions || !answers || answers.length !== questions.length) return false;
  return questions.every((question, index) => {
    const answer = answers[index];
    if (!Array.isArray(answer) || answer.length === 0 || answer.length > 10) return false;
    if (!question.multiple && answer.length !== 1) return false;
    const labels = new Set(question.options.map((option) => option.label));
    return answer.every((label) => (
      typeof label === "string"
      && label.length <= 100
      && label.trim().length > 0
      && (question.custom || labels.has(label))
    ));
  });
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extract the upstream session id an SSE envelope belongs to, if any. */
export function openCodeEnvelopeSessionId(envelope: unknown): string | undefined {
  const normalized = normalizeOpenCodeEnvelope(envelope);
  if (!normalized) return undefined;
  return sessionIdOfNormalized(normalized);
}

/** Resolve the tracked role of the message a part belongs to, if any. */
function partRoleOf(
  roles: ReadonlyMap<string, string>,
  normalized: { type: string; properties: Record<string, unknown> },
): string | undefined {
  if (normalized.type !== "message.part.updated" && normalized.type !== "message.part.delta") return undefined;
  // Deltas carry the message id at the top level; snapshots nest it in the part.
  const direct = typeof normalized.properties.messageID === "string" && normalized.properties.messageID.length <= 512
    ? normalized.properties.messageID
    : undefined;
  if (direct) return roles.get(direct);
  const part = recordOf(normalized.properties.part);
  const nested = typeof part?.messageID === "string" && part.messageID.length <= 512
    ? part.messageID
    : undefined;
  return nested ? roles.get(nested) : undefined;
}

/**
 * OpenCode provider over a pooled `opencode serve` child per working
 * directory. Two threads in one worktree share one serve process; a second
 * worktree gets its own. Turns stream over per-turn SSE into canonical
 * events; stop aborts the upstream session while the server stays warm.
 */
@injectable()
export class OpenCodeProvider extends NodeEvents.EventEmitter implements IAgentProvider, ISessionEvictable, IApprovalReviewCapable {
  readonly id: ProviderId = "opencode";
  readonly subagentReporting = SUBAGENT_REPORTING.opencode;
  readonly descriptor = Object.freeze({
    id: "opencode" as const,
    capabilities: [
      ...OPENCODE_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
      { name: "turn-steer" as const, support: "unsupported" as const },
    ],
  });
  readonly supportsCompletion = false;
  readonly maxInputCharactersPerTurn = 16_000;

  private readonly turns = new Map<string, OpenCodeTurnState>();
  private readonly canonicalRoutings = new Map<string, CanonicalLiveEventRouting>();
  private readonly canonicalEventPublisher: CanonicalLiveEventPublisher | undefined;
  private readonly pendingPermissions = new Map<string, OpenCodePendingAsk>();
  private readonly seenNotices = new Map<string, Set<string>>();
  private readonly turnDiffListeners = new Set<(event: ProviderTurnDiffUpdate) => void>();
  private pool: OpenCodeServerPool;
  private http: OpenCodeHttpClient;
  private probeCli: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;
  private idleConfirm: OpenCodeIdleConfirm = { ...DEFAULT_IDLE_CONFIRM };

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("ProviderHostPorts") private readonly host: ProviderHostPorts,
  ) {
    super();
    this.canonicalEventPublisher = this.host?.events
      ? new CanonicalLiveEventPublisher(this.id, this.host.events)
      : undefined;
    this.pool = OpenCodeServerPool.withDefaults({
      platform: this.host.runtime.platform,
      terminateTree: (pid) => this.host.processes.terminateTree(pid),
      env: () => ({ ...this.envService.getEnv() }),
    });
    this.http = defaultOpenCodeHttpClient;
    this.probeCli = probeOpenCodeCli;
  }

  /** Test seam: replace the pool, HTTP client, CLI probe, and idle timings without DI tokens. */
  configureTestSeams(seams: {
    pool?: OpenCodeServerPool;
    http?: OpenCodeHttpClient;
    probeCli?: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;
    idleConfirm?: Partial<OpenCodeIdleConfirm>;
  }): void {
    if (seams.pool) this.pool = seams.pool;
    if (seams.http) this.http = seams.http;
    if (seams.probeCli) this.probeCli = seams.probeCli;
    if (seams.idleConfirm) this.idleConfirm = { ...DEFAULT_IDLE_CONFIRM, ...seams.idleConfirm };
  }

  /**
   * Upstream OpenCode exposes only per-tool permission asks; no native
   * turn-review verdict exists, so automatic approval review is honestly
   * unavailable for every input. Side-effect-free: no probing, no I/O.
   */
  async getApprovalReviewSupport(_input: {
    permissionMode: "full" | "supervised";
    interactionMode: "plan" | "build";
    requestedMode: "manual" | "automatic";
    model: string;
  }): Promise<ApprovalReviewSupport> {
    return {
      status: "unavailable",
      supportedModes: ["manual"],
      reason: "opencode-lacks-native-approval-review",
      liveChangeScope: "none",
    };
  }

  /**
   * Reports sign-in from `opencode auth list`. An attached serve URL may hold
   * credentials this machine cannot see, so it reads as unknown.
   */
  async describeStatus(): Promise<ProviderStatusFacts> {
    if (this.settingsService.get().provider.opencode.serveUrl) return { auth: { state: "unknown" } };
    const run = createCliStatusRunner({ platform: this.host.runtime.platform, env: this.envService.getEnv() });
    const cliPath = this.cliPath();
    return { ...await describeOpenCodeAuth(run, cliPath), cli: {
      installed: await readCliStatusVersion(run, cliPath),
      managedBy: "user",
      resolvedPath: await resolveCliStatusBinary(cliPath, this.envService.getEnv()),
      npmPackage: "opencode-ai",
    } };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const lease = await this.acquireServeLease(process.cwd()).catch((error: unknown) => {
      logger.debug("OpenCode listModels serve acquire failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!lease) return [];
    try {
      return await this.http.listModels(lease.endpoint);
    } catch (error) {
      logger.warn("OpenCode listModels failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    } finally {
      this.releaseServeLease(lease);
    }
  }

  async sendTurn(req: TurnRequest<"opencode">): Promise<void> {
    const routing: CanonicalLiveEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.canonicalRoutings.set(routing.executionId, routing);
    const state = this.turnStateFor(req.sessionId, req.threadId);
    const scheduled = state.chain.then(() => this.runTurn(req, routing, state));
    state.chain = scheduled.then(() => {}, () => {});
    await scheduled;
  }

  /** Reconcile only a plan file proved by this thread's still-known upstream session. */
  async prepareImplement(input: {
    threadId: string; markdown: string; nativePlanFile: NativePlanFileRef | null;
  }): Promise<NativePlanFileOutcome> {
    if (!input.nativePlanFile) return { outcome: "skipped", reason: "no-file" };
    const sessions = [...this.turns.values()].filter((state) => state.threadId === input.threadId);
    const state = sessions.length === 1 ? sessions[0] : undefined;
    if (!state?.sessionCwd || state.upstreamSessionId !== input.nativePlanFile.sessionId) {
      return { outcome: "skipped", reason: "unproven" };
    }
    const outcome = await deleteOwnedPlanFile({ nativePlanFile: input.nativePlanFile,
      sessionId: state.upstreamSessionId, planRoot: NodePath.join(state.sessionCwd, ".opencode", "plans") });
    // A recreated file under the same name is a different file and must not inherit this session's claim.
    if (outcome.outcome === "deleted") state.createdPlanPaths.delete(input.nativePlanFile.path);
    return outcome;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.turns.get(sessionId);
    if (!state) return;
    state.aborted = true;
    this.drainPendingForSession(sessionId);
    state.abortController.abort();
    if (state.upstreamSessionId && state.lease) {
      await this.http.abortSession(state.lease.endpoint, state.upstreamSessionId).catch((error: unknown) => {
        logger.debug("OpenCode abort failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  async discardSession(sessionId: string): Promise<void> {
    const state = this.turns.get(sessionId);
    if (!state) return;
    await this.stopSession(sessionId);
    // Force the next sendTurn onto a fresh upstream session instead of
    // re-adopting the discarded one.
    this.turns.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    const pendingTurns = [...this.turns.values()].map((state) => state.chain);
    for (const [sessionId, state] of this.turns) {
      state.aborted = true;
      this.drainPendingForSession(sessionId);
      state.abortController.abort();
    }
    this.drainAllPending();
    const results = await Promise.allSettled([this.pool.shutdown()]);
    results.push(...await Promise.allSettled(pendingTurns));
    results.push(...await Promise.allSettled([this.canonicalEventPublisher?.stopAdmissionAndDrain()]));
    this.turns.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "OpenCode provider shutdown failed");
  }

  /** A failed native relay stays answerable and is reported to the caller. */
  async resolveApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return { status: "not_pending" };
    if ("autoDeny" in response) entry.unanswerable = true;
    if (entry.replying) return { status: "failed", message: "An answer is already being sent" };
    const choice = approvalChoice(entry.request.body, response);
    if (!choice && !("autoDeny" in response)) return { status: "failed", message: "The approval choice is unavailable" };
    if (!this.validQuestionResponse(entry, response)) {
      return { status: "failed", message: "The question answers are invalid" };
    }
    entry.replying = true;
    try {
      await this.relayDecision(entry, response);
      if (!this.ownsPendingAsk(entry)) return { status: "not_pending" };
      const outcome: ApprovalOutcome = approvalOutcome(choice, response);
      this.resolvePendingAsk(entry, outcome);
      return { status: "resolved" };
    } catch (error) {
      entry.replying = false;
      if (error instanceof OpenCodeReplySessionNotFoundError) this.invalidateReplySession(entry);
      logger.error("OpenCode approval reply failed", { requestId });
      return { status: "failed", message: "The answer did not reach OpenCode" };
    }
  }

  /** List original adapter envelopes, optionally filtered by owning thread. */
  listPendingApprovals(threadId?: string): ApprovalRequestEnvelope[] {
    return [...this.pendingPermissions.values()].filter((entry) => threadId === undefined || entry.request.threadId === threadId)
      .map((entry) => entry.request);
  }

  private validQuestionResponse(entry: OpenCodePendingAsk, response: ApprovalResponse): boolean {
    if ("autoDeny" in response || entry.request.body.subject.kind !== "question") return true;
    const choice = approvalChoice(entry.request.body, response);
    return isValidQuestionResponse(entry.request.body.subject.questions, choice?.intent === "deny" ? "deny" : "allow", response.answers);
  }

  private async relayDecision(entry: OpenCodePendingAsk, response: ApprovalResponse): Promise<void> {
    if (entry.kind === "permission") {
      await this.http.replyPermission(entry.endpoint, entry.upstreamSessionId, entry.request.requestId,
        "autoDeny" in response ? "reject" : mapApprovalChoiceToReply(response.choiceId), entry.version, { signal: entry.signal });
    } else if (!("autoDeny" in response) && response.choiceId === "answer" && response.answers) {
      await this.http.replyQuestion(entry.endpoint, entry.upstreamSessionId, entry.request.requestId,
        response.answers, entry.version, { signal: entry.signal });
    } else {
      await this.http.rejectQuestion(entry.endpoint, entry.upstreamSessionId, entry.request.requestId, entry.version, { signal: entry.signal });
    }
  }

  /** Clear pending cards for one session without upstream calls (abort covers it). */
  private drainPendingForSession(sessionId: string, reason: "session_stopped" | "turn_ended" = "session_stopped"): void {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId !== sessionId) continue;
      this.resolvePendingAsk(entry, { status: "cancelled", reason: entry.unanswerable ? "unanswerable" : reason });
    }
  }

  /** Clear every unresolved ask while the owning provider is shutting down. */
  private drainAllPending(): void {
    for (const entry of this.pendingPermissions.values()) this.resolvePendingAsk(entry, { status: "cancelled", reason: entry.unanswerable ? "unanswerable" : "session_stopped" });
  }

  /** True only while this turn still exclusively owns the upstream ask. */
  private ownsPendingAsk(entry: OpenCodePendingAsk): boolean {
    return this.pendingPermissions.get(entry.request.requestId) === entry && !entry.signal.aborted;
  }

  /** Remove one owned ask and publish its local outcome exactly once. */
  private resolvePendingAsk(entry: OpenCodePendingAsk, outcome: ApprovalOutcome): boolean {
    if (this.pendingPermissions.get(entry.request.requestId) !== entry) return false;
    this.pendingPermissions.delete(entry.request.requestId);
    const receipts = this.turnStateFor(entry.sessionId, entry.request.threadId).receiptRequestIds;
    if (!receipts.has(entry.request.requestId)) {
      receipts.add(entry.request.requestId);
      this.publishTurnEvent(entry.routing, entry.sessionId, approvalReceipt(entry.request, outcome));
    }
    this.emit("approval_resolved", { requestId: entry.request.requestId, threadId: entry.request.threadId, outcome });
    return true;
  }

  /** Surface a typed missing reply-session through the canonical invalidation path. */
  private invalidateReplySession(entry: OpenCodePendingAsk): void {
    const state = this.turns.get(entry.sessionId);
    if (!state || state.abortController.signal !== entry.signal) return;
    const goneId = state.upstreamSessionId;
    forgetUpstreamSession(state);
    this.emitSessionInvalidatedNotice(
      (event) => this.publishTurnEvent(entry.routing, entry.sessionId, event),
      entry.routing.threadId,
      goneId,
    );
    state.aborted = true;
    this.drainPendingForSession(entry.sessionId);
    state.abortController.abort();
  }

  /**
   * Record one notice key per thread; true when first seen. Notices replayed
   * after a reconnect or retry share their key, so each renders once.
   */
  private markNoticeSeen(threadId: string, key: string): boolean {
    let seen = this.seenNotices.get(threadId);
    if (!seen) {
      seen = new Set();
      this.seenNotices.set(threadId, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > MAX_SEEN_NOTICES_PER_THREAD) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  /**
 * Emit the provider-neutral session-reset notice once per missing upstream session.
   * Keyed by the gone session id so a verify-404 and a later prompt-404 for
   * different sessions each stay visible, while exact replays collapse.
   */
  private emitSessionInvalidatedNotice(emit: (event: AgentEvent) => void, threadId: string, goneId: string): void {
    if (!this.markNoticeSeen(threadId, `${OPENCODE_SESSION_INVALIDATED_SUBTYPE}:${goneId}`)) return;
    emit({ type: AgentEventType.System, threadId, subtype: OPENCODE_SESSION_INVALIDATED_SUBTYPE } satisfies AgentEvent);
  }

  private cliPath(): string {
    return this.settingsService.get().provider.cli.opencode?.trim() || "opencode";
  }

  /**
   * Resolve where requests for one working directory go. A configured serve
   * URL attaches without probing the CLI or touching the pool; otherwise the
   * pool spawns or reuses the serve child keyed by this directory.
   */
  private async acquireServeLease(cwd: string): Promise<OpenCodeServeLease> {
    const serveUrl = this.settingsService.get().provider.opencode.serveUrl;
    if (serveUrl) return { kind: "attached", endpoint: { baseUrl: serveUrl, directory: cwd } };
    const probe = await this.probeCli(this.cliPath(), this.host.runtime.platform);
    const key: OpenCodePoolKey = { binaryPath: probe.binaryPath, cwd, hostname: OPENCODE_SERVE_HOSTNAME };
    const entry = await this.pool.acquire(key);
    return { kind: "pooled", key, endpoint: { baseUrl: entry.baseUrl, directory: cwd } };
  }

  /** Return a pooled reference; an attached server has no app-owned lifetime to release. */
  private releaseServeLease(lease: OpenCodeServeLease): void {
    if (lease.kind === "pooled") this.pool.release(lease.key);
  }

  private threadIdFor(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  private turnStateFor(sessionId: string, threadId: string): OpenCodeTurnState {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    const created: OpenCodeTurnState = {
      threadId,
      sessionCwd: null,
      nativePlanPath: null,
      createdPlanPaths: new Set(),
      receiptRequestIds: new Set(),
      upstreamSessionId: "",
      lease: null,
      abortController: new AbortController(),
      active: false,
      aborted: false,
      chain: Promise.resolve(),
      idleConfirming: false,
      idleRestart: false,
      idleConfirmPromise: null,
      messageRoles: new Map<string, string>(),
      childSessionCalls: new Map<string, OpenCodeChildTask>(),
      forwardedText: new Map<string, string>(),
      partTypes: new Map<string, string>(),
      nativeDiff: new OpenCodeNativeTurnDiff(),
      nativeDiffRevision: 0,
    };
    this.turns.set(sessionId, created);
    return created;
  }

  private publishTurnEvent(routing: CanonicalLiveEventRouting, sessionId: string, event: AgentEvent): void {
    const runtimeEvent = providerRuntimeEvent({ ...event, turnExecutionId: routing.executionId });
    if (!this.canonicalEventPublisher) {
      this.emit("event", runtimeEvent);
      return;
    }
    this.canonicalEventPublisher.publish(routing, runtimeEvent, this.sessionIdentities(sessionId));
  }

  private sessionIdentities(sessionId: string): ProviderIdentity[] {
    const state = this.turns.get(sessionId);
    if (!state?.upstreamSessionId) return [];
    return [{
      providerId: this.id,
      scope: "session",
      value: state.upstreamSessionId,
      provenance: "native",
    }];
  }

  private async waitForCanonicalExecution(executionId: string): Promise<void> {
    const routing = this.canonicalRoutings.get(executionId);
    if (!routing || !this.canonicalEventPublisher) return;
    try {
      await this.canonicalEventPublisher.waitForExecution(routing);
    } catch (error) {
      logger.error("OpenCode canonical event delivery failed", {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.canonicalRoutings.delete(executionId);
    }
  }

  private async runTurn(req: TurnRequest<"opencode">, routing: CanonicalLiveEventRouting, state: OpenCodeTurnState): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    const emit = (event: AgentEvent): void => {
      if (event.type === "turnComplete" || event.type === "ended" || event.type === "error") this.drainPendingForSession(req.sessionId, "turn_ended");
      this.publishTurnEvent(routing, req.sessionId, event);
    };
    state.aborted = false;
    state.nativePlanPath = null;
    state.abortController = new AbortController();
    state.messageRoles.clear();
    state.childSessionCalls.clear();
    state.forwardedText.clear();
    state.partTypes.clear();
    state.nativeDiff = new OpenCodeNativeTurnDiff();
    state.nativeDiffRevision = 0;
    emit({ type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);
    const lease = await this.acquireTurnLease(req, routing, state, emit);
    if (!lease) {
      this.drainPendingForSession(req.sessionId);
      return;
    }
    const settler = new OpenCodeTurnSettler(emit, threadId, req.turnExecutionId, state);
    state.abortController.signal.addEventListener("abort", settler.onAbort, { once: true });
    try {
      await this.streamTurn(req, state, lease.endpoint, settler);
    } finally {
      this.drainPendingForSession(req.sessionId);
      state.abortController.signal.removeEventListener("abort", settler.onAbort);
      state.active = false;
      this.releaseServeLease(lease);
      await this.waitForCanonicalExecution(routing.executionId);
    }
  }

  private async acquireTurnLease(
    req: TurnRequest<"opencode">,
    routing: CanonicalLiveEventRouting,
    state: OpenCodeTurnState,
    emit: (event: AgentEvent) => void,
  ): Promise<OpenCodeServeLease | null> {
    const threadId = this.threadIdFor(req.sessionId);
    try {
      state.lease = await this.acquireServeLease(req.cwd);
      return state.lease;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: AgentEventType.Error, threadId, error: message, failure: { kind: "fatal" } } satisfies AgentEvent);
      emit({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId, outcome: "errored" } satisfies AgentEvent);
      await this.waitForCanonicalExecution(routing.executionId);
      return null;
    }
  }

  private async streamTurn(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    state.active = true;
    try {
      await this.promptUpstream(req, state, endpoint, settler, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("OpenCodeProvider turn error", { sessionId: req.sessionId, error: message });
      settler.settle(state.aborted ? "cancelled" : "errored", state.aborted ? undefined : message, classifyOpenCodeFailure(error));
    }
  }

  /**
   * Create (or re-adopt) the upstream session, subscribe, and send one async
   * prompt. Only a confirmed missing session (404) starts fresh, and only
   * once; any other failure propagates so a live thread never resets to
   * empty.
   */
  private async promptUpstream(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    settler: OpenCodeTurnSettler,
    retried: boolean,
  ): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    const emit = (event: AgentEvent): void => this.publishTurnEvent(
      { threadId: req.threadId, turnId: req.turnId, executionId: req.turnExecutionId, deliveryAttempt: req.deliveryAttempt ?? 1 },
      req.sessionId,
      event,
    );
    await this.ensureUpstreamSession(req, state, endpoint, emit, retried);
    const upstreamId = state.upstreamSessionId;
    const subscribe = this.http.subscribeEvents(endpoint, state.abortController.signal, (envelope) => {
      this.handleTurnEnvelope(envelope, req, state, endpoint, upstreamId, settler);
    }).catch((error: unknown) => {
      logger.debug("OpenCode event subscription ended", {
        sessionId: req.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await this.http.promptAsync(endpoint, upstreamId, openCodePromptBody(req));
      await subscribe;
      // The stream ended. An in-flight idle confirmation owns settling now;
      // otherwise settle only if nothing did: an abort cancels, while a dead
      // stream without terminal proof is an interruption, never a success.
      // (Settled turns no-op below.)
      if (state.idleConfirmPromise) await state.idleConfirmPromise.catch(() => {});
      if (!settler.isSettled()) {
        settler.settle(state.aborted ? "cancelled" : "errored", state.aborted ? undefined : "OpenCode event stream ended before the turn completed");
      }
    } catch (error) {
      if (!retried && !state.aborted && isMissingSessionError(error)) {
        if (req.resumeRequired) throw new SessionResumeUnavailableError("OpenCode could not resume the saved session", { cause: error });
        logger.info("OpenCode upstream session missing; starting fresh", { sessionId: req.sessionId });
        this.emitSessionInvalidatedNotice(emit, threadId, upstreamId);
        forgetUpstreamSession(state);
        await this.promptUpstream(req, state, endpoint, settler, true);
        return;
      }
      throw error;
    }
  }

  /**
   * Resolve the upstream session for one turn. Warm in-memory state wins;
   * otherwise the durable resume cursor (`resumeFrom`) is re-adopted behind
   * the versioned parser and verified with one bounded history page. Only a
   * confirmed 404 starts fresh (with a visible notice); any other failure
   * propagates so a live thread never resets to empty.
   */
  private async ensureUpstreamSession(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    emit: (event: AgentEvent) => void,
    skipResume: boolean,
  ): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    if (state.upstreamSessionId) return;
    // A retried turn already proved the cursor missing; go straight to fresh
    // so the recreated notice fires exactly once.
    const resumed = skipResume ? undefined : parseOpenCodeResumeCursor(req.resumeFrom);
    if (resumed) {
      try {
        await this.http.listSessionMessages(endpoint, resumed, {
          limit: 1,
          signal: state.abortController.signal,
        });
        state.upstreamSessionId = resumed;
        state.sessionCwd = req.cwd;
        emit({ type: AgentEventType.System, threadId, subtype: `sdk_session_id:${resumed}` } satisfies AgentEvent);
        return;
      } catch (error) {
        if (!isMissingSessionError(error)) throw error;
        if (req.resumeRequired) throw new SessionResumeUnavailableError("OpenCode could not resume the saved session", { cause: error });
        logger.info("OpenCode upstream session missing; starting fresh", { sessionId: req.sessionId });
        this.emitSessionInvalidatedNotice(emit, threadId, resumed);
      }
    }
    // A required resume never replaces the saved session; the server recovers from a seeded session instead.
    if (req.resumeRequired) throw new SessionResumeUnavailableError("OpenCode has no saved session to resume");
    const created = await this.http.createSession(endpoint, req.threadId);
    // Validate the upstream id before it becomes the durable resume cursor.
    state.upstreamSessionId = formatOpenCodeResumeCursor(created.id);
    state.sessionCwd = req.cwd;
    emit({ type: AgentEventType.System, threadId, subtype: `sdk_session_id:${created.id}` } satisfies AgentEvent);
  }

  /** Subscribe to complete native turn diffs without routing their bytes through renderer events. */
  onTurnDiff(handler: (event: ProviderTurnDiffUpdate) => void): () => void {
    this.turnDiffListeners.add(handler);
    return () => this.turnDiffListeners.delete(handler);
  }

  /**
   * Fold one upstream `session.diff` event into the turn's native aggregate
   * and push the complete result. Upstream diffs are computed between its own
   * step snapshots, so they carry agent-attributed evidence; the event mapper
   * keeps classifying these envelopes as noise for the narrative timeline.
   */
  private publishNativeTurnDiff(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    properties: Record<string, unknown>,
  ): void {
    const result = state.nativeDiff.observe(Array.isArray(properties.diff) ? properties.diff : []);
    if (result === null) return;
    const identity = {
      turnId: req.turnId,
      turnExecutionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
      revision: ++state.nativeDiffRevision,
    };
    const event: ProviderTurnDiffUpdate = result.state === "snapshot"
      ? { ...identity, ...result, nativeFidelity: "agent" }
      : { ...identity, ...result };
    for (const listener of this.turnDiffListeners) listener(event);
  }

  private handleTurnEnvelope(
    envelope: unknown,
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): void {
    if (state.aborted) return;
    const threadId = this.threadIdFor(req.sessionId);
    const normalized = normalizeOpenCodeEnvelope(envelope);
    let parentToolCallId: string | undefined;
    let partType: string | undefined;
    if (normalized) {
      const owner = sessionIdOfNormalized(normalized);
      if (owner && owner !== upstreamId) {
        parentToolCallId = state.childSessionCalls.get(owner)?.callId;
        if (!parentToolCallId || !isForwardedChildEvent(normalized)) return;
      }
      this.trackMessageRole(state, normalized);
      partType = trackOpenCodePartType(state.partTypes, normalized);
      trackChildTask(state, normalized);
      trackNativePlanFile(req, state, normalized);
      if (normalized.type === "session.diff") {
        this.publishNativeTurnDiff(req, state, normalized.properties);
      }
    }
    const mapped = mapOpenCodeEnvelope(envelope, {
      threadId,
      turnExecutionId: req.turnExecutionId,
      requestedModel: req.model,
      partRole: normalized ? partRoleOf(state.messageRoles, normalized) : undefined,
      partType,
      forwardedText: state.forwardedText,
      parentToolCallId,
    });
    this.dispatchMappedEnvelope(req, state, endpoint, upstreamId, threadId, mapped, normalized, settler);
  }

  /** Route one mapped envelope to cards, canonical events, and settlement. */
  private dispatchMappedEnvelope(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    threadId: string,
    mapped: OpenCodeMappedOutput,
    normalized: { type: string; properties: Record<string, unknown> } | null,
    settler: OpenCodeTurnSettler,
  ): void {
    if (mapped.disposition === "diagnostic") {
      logger.warn("OpenCode notification disposition", { threadId, reason: mapped.reason });
    }
    if (mapped.reason === "permission-request" || mapped.reason === "question-request") {
      this.maybeEmitAsk(req, endpoint, upstreamId, normalized, mapped.reason);
    }
    this.forwardTurnEvents(mapped.events, req, threadId, settler);
    const error = mapped.events.find((event) => event.type === AgentEventType.Error);
    if (error) {
      settler.settle("errored", error.error, error.failure);
    } else if (mapped.events.some((e) => e.type === AgentEventType.TurnComplete)) {
      void this.confirmIdleCompleted(req, state, endpoint, upstreamId, settler);
    } else if (mapped.disposition === "mapped") {
      settler.noteActivity();
    }
  }

  /**
   * Settle a turn only after its idle persists. Upstream emits `session.idle`
   * between steps of a multi-step turn, so the first idle is never terminal
   * proof: poll live session status until idle persists across consecutive
   * polls with no new mapped activity, a pending ask appears (the user's
   * decision drives the turn from here), the session leaves idle, or the
   * bound lapses. A newer idle restarts the running loop instead of piling up
   * another one. Exactly one terminal outcome still wins via the settler.
   */
  private async confirmIdleCompleted(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    if (state.idleConfirming) {
      state.idleRestart = true;
      return;
    }
    state.idleConfirming = true;
    const confirmation = this.pollIdleConfirmation(req, state, endpoint, upstreamId, settler);
    state.idleConfirmPromise = confirmation;
    try {
      await confirmation;
    } finally {
      state.idleConfirming = false;
      if (state.idleConfirmPromise === confirmation) state.idleConfirmPromise = null;
    }
  }

  private async pollIdleConfirmation(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    const confirm: IdleConfirmProgress = {
      startedActivity: settler.activityCount,
      idlePolls: 0,
      pollErrors: 0,
      deadline: Date.now() + this.idleConfirm.timeoutMs,
    };
    for (;;) {
      const gate = this.idleConfirmGate(req, state, settler, confirm);
      if (gate === "stop") return;
      if (gate === "restart") continue;
      await waitForAbortableDelay(this.idleConfirm.intervalMs, state.abortController.signal);
      const poll = await this.pollIdleStep(
        endpoint,
        upstreamId,
        state.abortController.signal,
        Math.max(1, confirm.deadline - Date.now()),
      );
      const after = this.idleConfirmGate(req, state, settler, confirm);
      if (after === "restart") continue;
      if (after === "stop") return;
      const noted = this.noteIdlePoll(confirm, settler, poll);
      if (noted === "next") continue;
      if (noted === "stop") return;
      if (await this.completeIdleTurn(req, state, settler, confirm) === "restart") continue;
      return;
    }
  }

  private async completeIdleTurn(req: TurnRequest<"opencode">, state: OpenCodeTurnState,
    settler: OpenCodeTurnSettler, confirm: IdleConfirmProgress): Promise<"restart" | "stop"> {
    const capture = await this.readNativePlan(state);
    const gate = this.idleConfirmGate(req, state, settler, confirm, false);
    if (gate !== "go") return gate;
    const routing = this.canonicalRoutings.get(req.turnExecutionId);
    if (routing && capture?.outcome === "captured") {
      this.canonicalEventPublisher?.capturePlan(routing, {
        markdown: capture.markdown, source: "native", nativePlanFile: capture.nativePlanFile,
      });
    }
    settler.settle("completed");
    return "stop";
  }

  private async readNativePlan(state: OpenCodeTurnState) {
    if (!state.nativePlanPath || !state.sessionCwd) return null;
    return captureOwnedPlanFile({ path: state.nativePlanPath, sessionId: state.upstreamSessionId,
      planRoot: NodePath.join(state.sessionCwd, ".opencode", "plans") });
  }

  /**
   * Account one status poll: failed polls accumulate toward a visible error,
   * an active session abandons the loop, and enough consecutive quiet polls
   * (or the bound lapsing) settle the turn.
   */
  private noteIdlePoll(
    confirm: IdleConfirmProgress,
    settler: OpenCodeTurnSettler,
    poll: { kind: "error" } | { kind: "quiet" } | { kind: "active" },
  ): "settle" | "stop" | "next" {
    if (poll.kind === "error") {
      confirm.pollErrors += 1;
      if (confirm.pollErrors >= this.idleConfirm.maxPollErrors || Date.now() >= confirm.deadline) {
        settler.settle("errored", "OpenCode session status unavailable");
        return "settle";
      }
      return "next";
    }
    if (poll.kind === "active") return "stop";
    confirm.pollErrors = 0;
    confirm.idlePolls += 1;
    if (confirm.idlePolls >= this.idleConfirm.requiredPolls) return "settle";
    if (Date.now() >= confirm.deadline) return "settle";
    return "next";
  }

  /**
   * One idle-confirmation gate: restart re-baselines a newer idle, stop ends
   * the loop without settling (abort, settlement, new activity, pending ask),
   * and go advances it.
   */
  private idleConfirmGate(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    settler: OpenCodeTurnSettler,
    confirm: IdleConfirmProgress,
    checkDeadline = true,
  ): "restart" | "stop" | "go" {
    if (state.aborted || settler.isSettled()) return "stop";
    if (state.idleRestart) {
      state.idleRestart = false;
      confirm.startedActivity = settler.activityCount;
      confirm.idlePolls = 0;
      confirm.pollErrors = 0;
      return "restart";
    }
    if (settler.activityCount !== confirm.startedActivity) return "stop";
    if (this.hasPendingAskForSession(req.sessionId)) return "stop";
    if (checkDeadline && Date.now() >= confirm.deadline) {
      settler.settle("errored", "OpenCode session status confirmation timed out");
      return "stop";
    }
    return "go";
  }

  /** One live status read: quiet (idle or drained), active (busy work), or error. */
  private async pollIdleStep(
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ kind: "error" } | { kind: "quiet" } | { kind: "active" }> {
    try {
      const type = (await this.http.getSessionStatus(endpoint, { signal, timeoutMs }))[upstreamId]?.type;
      // Drained sessions leave the status map: after an idle event, a missing
      // entry means the session stayed quiet, not that polling broke.
      if (type === undefined) return { kind: "quiet" };
      return type === "idle" ? { kind: "quiet" } : { kind: "active" };
    } catch {
      return { kind: "error" };
    }
  }

  /** True when a permission or question card still awaits the user for one session. */
  private hasPendingAskForSession(sessionId: string): boolean {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Synthesize one inline card for an upstream ask and emit it through the
   * existing permission flow. A replayed envelope shares its upstream id, so
   * it never cards twice; an unusable ask becomes one bounded diagnostic
   * instead of stalling the turn silently.
   */
  private maybeEmitAsk(
    req: TurnRequest<"opencode">,
    endpoint: OpenCodeEndpoint,
    upstreamId: string,
    normalized: { type: string; properties: Record<string, unknown> } | null,
    reason: "permission-request" | "question-request",
  ): void {
    if (!normalized) return;
    const threadId = this.threadIdFor(req.sessionId);
    const state = this.turns.get(req.sessionId);
    if (!state || state.abortController.signal.aborted) return;
    const routing: CanonicalLiveEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    const source = askSourceOf(state, upstreamId, normalized);
    if (reason === "permission-request") {
      this.maybeEmitPermissionAsk(req, endpoint, source, normalized, state, routing);
      return;
    }
    const synthesized = synthesizeOpenCodeQuestionRequest({ threadId, properties: normalized.properties, origin: source.origin });
    if (!synthesized) return this.emitAskDiagnostic(req, threadId);
    if (this.pendingPermissions.has(synthesized.requestId)) return;
    this.pendingPermissions.set(synthesized.requestId, {
      request: synthesized, sessionId: req.sessionId, upstreamSessionId: source.upstreamSessionId, endpoint,
      kind: "question", version: askVersion(normalized.type),
      signal: state.abortController.signal, routing, replying: false,
    });
    this.emit("approval_request", synthesized);
  }

  /**
   * Register one upstream permission ask, then either card it for the user
   * (supervised) or auto-answer it "always" (full access — the serve API has
   * no session-wide bypass, so the gate is adapter-side). The entry stays in
   * the pending map either way so dedupe, draining, and session-invalidation
   * bookkeeping stay identical.
   */
  private maybeEmitPermissionAsk(
    req: TurnRequest<"opencode">,
    endpoint: OpenCodeEndpoint,
    source: OpenCodeAskSource,
    normalized: { type: string; properties: Record<string, unknown> },
    state: OpenCodeTurnState,
    routing: CanonicalLiveEventRouting,
  ): void {
    const threadId = this.threadIdFor(req.sessionId);
    const request = synthesizeOpenCodeApprovalRequest({ threadId, properties: normalized.properties, origin: source.origin });
    if (!request) {
      const requestId = NodeCrypto.randomUUID();
      this.pendingPermissions.set(requestId, {
        request: { requestId, threadId, body: {
          requestedAt: new Date().toISOString(), subject: { kind: "tool", toolName: "Unreadable request" },
          choices: [{ id: "deny", intent: "deny", label: "Deny" }], origin: source.origin,
        } },
        sessionId: req.sessionId, upstreamSessionId: source.upstreamSessionId, endpoint, kind: "permission",
        version: askVersion(normalized.type), signal: state.abortController.signal, routing, replying: false, unanswerable: true,
      });
      void this.stopSession(req.sessionId).catch(() => {
        logger.error("Failed to stop OpenCode session for an unroutable approval", { providerId: this.id, sessionId: req.sessionId, threadId });
      }).finally(() => this.drainPendingForSession(req.sessionId));
      return;
    }
    if (this.pendingPermissions.has(request.requestId)) return;
    const entry: OpenCodePendingAsk = {
      request, sessionId: req.sessionId, upstreamSessionId: source.upstreamSessionId, endpoint,
      kind: "permission", version: askVersion(normalized.type),
      signal: state.abortController.signal, routing, replying: false,
    };
    this.pendingPermissions.set(request.requestId, entry);
    if (req.permissionMode === "full") {
      entry.replying = true;
      void this.relayDecision(entry, { choiceId: "always" }).then(() => {
        this.resolvePendingAsk(entry, { status: "allowed", intent: "allow_scoped", choiceLabel: "Full access" });
      }, () => { entry.replying = false; this.emit("approval_request", request); });
      return;
    }
    this.emit("approval_request", request);
  }

  private emitAskDiagnostic(
    req: TurnRequest<"opencode">,
    threadId: string,
  ): void {
    if (!this.markNoticeSeen(threadId, "notice:provider.notice.malformed-request")) return;
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.publishTurnEvent(routing, req.sessionId, {
      type: AgentEventType.System,
      threadId,
      subtype: "provider.notice.malformed-request",
      message: "A provider request could not be shown safely.",
    } satisfies AgentEvent);
  }

  /** Remember upstream message roles so user parts stay out of assistant text. */
  private trackMessageRole(
    state: OpenCodeTurnState,
    normalized: { type: string; properties: Record<string, unknown> },
  ): void {
    if (normalized.type !== "message.updated") return;
    const tracked = trackedMessageRole(recordOf(normalized.properties.info));
    if (tracked === undefined) return;
    state.messageRoles.set(tracked.id, tracked.role);
    if (state.messageRoles.size > MAX_TRACKED_MESSAGE_ROLES) {
      const oldest = state.messageRoles.keys().next();
      if (!oldest.done) state.messageRoles.delete(oldest.value);
    }
  }

  private forwardTurnEvents(
    events: AgentEvent[],
    req: TurnRequest<"opencode">,
    threadId: string,
    settler: OpenCodeTurnSettler,
  ): void {
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    for (const event of events) {
      if (event.type === AgentEventType.TurnComplete || event.type === AgentEventType.Error) continue;
      const noticeKey = replayNoticeKey(event);
      if (noticeKey && !this.markNoticeSeen(threadId, noticeKey)) continue;
      if (event.type === AgentEventType.TextDelta) settler.appendText(event.delta);
      this.publishTurnEvent(routing, req.sessionId, { ...event, threadId } as AgentEvent);
    }
  }
}

/** Owns one turn's terminal settlement so abort, completion, and error settle once. */
class OpenCodeTurnSettler {
  private settled = false;
  private assistantText = "";
  private activities = 0;

  readonly onAbort = (): void => {
    this.settle("cancelled");
  };

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly threadId: string,
    private readonly turnExecutionId: string,
    private readonly state: OpenCodeTurnState,
  ) {}

  appendText(delta: string): void {
    this.assistantText += delta;
  }

  /** Record one mapped (non-terminal) envelope so idle confirmation sees it. */
  noteActivity(): void {
    this.activities += 1;
  }

  /** Mapped envelopes seen since the turn started (drives idle confirmation). */
  get activityCount(): number {
    return this.activities;
  }

  /** True once a terminal outcome has been emitted. */
  isSettled(): boolean {
    return this.settled;
  }

  settle(outcome: "completed" | "cancelled" | "errored", error?: string, failure: TurnFailure = { kind: "fatal" }): void {
    if (this.settled) return;
    this.settled = true;
    if (error !== undefined) this.emit({ type: AgentEventType.Error, threadId: this.threadId, error: error.trim() ? error : "OpenCode session error", failure } satisfies AgentEvent);
    if (this.assistantText.trim().length > 0 && outcome !== "cancelled") {
      this.emit({ type: AgentEventType.Message, threadId: this.threadId, content: this.assistantText, tokens: null } satisfies AgentEvent);
    }
    if (outcome === "completed") {
      this.emit({
        type: AgentEventType.TurnComplete, threadId: this.threadId, reason: "end_turn",
        costUsd: null, tokensIn: 0, tokensOut: 0,
      } satisfies AgentEvent);
    }
    this.emit({ type: AgentEventType.Ended, threadId: this.threadId, turnExecutionId: this.turnExecutionId, outcome } satisfies AgentEvent);
    this.state.abortController.abort();
  }
}
