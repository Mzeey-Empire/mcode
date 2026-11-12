import type {
  AgentEventRouting,
  CanonicalAgentEvent,
  ProviderIdentity,
} from "@mcode/agent-model";
import { type InteractionMode } from "@mcode/contracts/models/enums";
import type { TurnAdmissionFailureReason } from "@mcode/contracts/models/turn-admission";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import type { McodeAttachedToolkits } from "@mcode/thread-orchestration";

/** Provider event input submitted to the server-owned canonical event sink. */
export interface ProviderEventDraft {
  /** Set by the publisher on fragments the server may show without saving; absent means save as published. */
  delivery?: "live";
  eventId: string;
  routing: AgentEventRouting;
  sourceProviderId: string;
  sourceIdentities: readonly ProviderIdentity[];
  sourceSequence?: number;
  providerTimestamp?: string;
  payload: CanonicalAgentEvent;
}

/** Supplies one server-owned environment snapshot to a Provider session spawn. */
export interface ProviderEnvironmentPort {
  snapshot(): Readonly<Record<string, string>>;
}

/** Supplies immutable facts about the Node runtime that hosts providers. */
export interface ProviderRuntimePort extends HostRuntime {}

/**
 * Runs buffered UTF-8 probes, rejecting with execFile's code, signal, killed, stdout, and stderr fields.
 * The server starts these processes off the thread that answers requests because Windows process creation blocks it.
 */
export type ProviderProcessRunner = (request: {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer?: number;
}) => Promise<{ stdout: string; stderr: string }>;

/** Opens an interactive process off the request thread because Windows process creation blocks that thread. */
export type ProviderProcessOpener = (request: Parameters<ProviderProcessRunner>[0], observer: {
  readonly onStdout?: (chunk: string) => void;
  readonly onStdinError?: (message: string) => void;
}) => {
  write(text: string): void;
  stop(): void;
  readonly exited: Promise<void>;
};

/** Runs probes, attaches and terminates child process trees without exposing the server process service. */
export interface ProviderProcessPort {
  run: ProviderProcessRunner;
  open: ProviderProcessOpener;
  attach(pid: number, description: string): void;
  terminateTree(pid: number): Promise<void>;
}

/** Non-secret metadata retained for one browser credential. */
export interface ProviderBrowserCredentialMetadata {
  credentialId: string;
  expiresAt: number;
}

/** Minimal browser lease request passed to the server-owned browser authority. */
export interface ProviderBrowserLeaseRequest {
  providerId: string;
  providerSessionId: string;
  mcodeSessionId: string;
  threadId: string;
  workspaceId: string;
  permissionCapability: "observe" | "interact" | "privileged";
}

/** Opaque browser lease handle returned by the server. */
export interface ProviderBrowserLeaseHandle {
  leaseId: string;
  expiresAt: number;
}

/** Browser credential issued for one staged Provider lease. */
export interface ProviderBrowserLeaseGrant extends ProviderBrowserCredentialMetadata {
  leaseId: string;
  allowedOperations: readonly string[];
}

/** Result of rotating credentials for an active browser lease. */
export type ProviderBrowserLeaseRefreshResult =
  | { ok: true; grant: ProviderBrowserLeaseGrant }
  | { ok: false; leaseId: string; reason: "not-found" | "unconfigured" | "issuance-failed" };

/** Gives a Provider scoped access to server-owned browser leases. */
export interface ProviderBrowserPort {
  stage(request: ProviderBrowserLeaseRequest): ProviderBrowserLeaseHandle;
  releaseSession(providerId: string, mcodeSessionId: string): number;
  isConfigured(): boolean;
  issue(stage: ProviderBrowserLeaseHandle): ProviderBrowserLeaseGrant | null;
  refresh(leaseId: string): ProviderBrowserLeaseRefreshResult;
  release(leaseId: string): { leaseId: string; released: boolean; credentialId?: string };
  revokeCredential(credentialId: string): boolean;
}

/** Identity of the Provider session the per-session `mcode` MCP server attaches to. */
export interface ProviderMcodeAttachRequest {
  providerId: string;
  /** Must equal the Browser lease `mcodeSessionId` for this session. */
  sessionId: string;
  threadId: string;
  /** Whether the Delegation toolkit is listed; every adapter that supports it passes true. */
  threadControl: boolean;
}

/** How a Provider reaches its one `mcode` server and which toolkits it lists. */
export interface ProviderMcodeAttachment {
  serverName: "mcode";
  url: string;
  /** Opaque bearer for this session; never log or persist it. */
  token: string;
  toolkits: McodeAttachedToolkits;
}

/** Gives a Provider its per-session `mcode` MCP server connection. */
export interface ProviderMcodePort {
  /** Returns null when the server is not listening or no toolkit applies to the session. */
  attach(request: ProviderMcodeAttachRequest): Promise<ProviderMcodeAttachment | null>;
  /** Rotates the token while a turn lease is active, otherwise closes the session. */
  close(sessionId: string): Promise<void>;
}

/** Maps Mcode turn controls to the browser gateway capability. */
export function providerBrowserPermissionCapability(
  permissionMode: string,
  interactionMode: InteractionMode,
): "observe" | "interact" | "privileged" {
  if (interactionMode === "plan") return "observe";
  return permissionMode === "full" ? "privileged" : "interact";
}

/** Consumes a server-authorized, path-scoped grant. */
export interface ProviderGrantPort {
  consume(request: { threadId: string; toolName: string; path: string }): boolean;
}

/** Submits bounded semantic drafts to the server-owned canonical event sink. */
export interface ProviderEventSinkPort {
  submit(batch: ProviderEventBatch): Promise<ProviderEventSubmissionReceipt>;
}

/** One bounded provider batch submitted through the canonical server sink. */
export interface ProviderEventBatch {
  threadId: string;
  turnId: string;
  executionId: string;
  /** Stable across retries of this submission when an execution has a worker owner. */
  batchId?: string;
  /** Provider delivery attempt that produced this batch. */
  deliveryAttempt?: number;
  phase: string;
  nativeCursor?: unknown;
  events: readonly ProviderEventDraft[];
}

/** Durable result for one provider event submission. */
export type ProviderEventCommitReceipt = ProviderEventDurableReceipt | {
  outcome: "dropped";
  reason: string;
} | {
  outcome: "accepted";
  acceptedThrough: number;
  eventCount: number;
  progressPosition: { epoch: string; sequence: number };
};

/** A storage receipt is issued only after the real transaction commits. */
export interface ProviderEventDurableReceipt {
  outcome: "committed" | "duplicate" | "conflict" | "ingest-overflow";
  conversationRevision: number;
  rosterRevision: number;
  acceptedThrough: number;
  durableThrough: number;
  eventCount: number;
}

/** Delivery state for canonical runtime events after a durable submission. */
export type ProviderEventDeliveryStatus = "queued" | "not-required";

/** Separates durable commit state from the subsequent ingress handoff. */
export interface ProviderEventSubmissionReceipt {
  commit: ProviderEventCommitReceipt;
  delivery: {
    ingress: ProviderEventDeliveryStatus;
  };
}

/** Server-issued routing for a turn the provider started without a user prompt. */
export interface ProviderTurnRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

/**
 * Why the server did not admit a provider-started turn. A pending mutation is
 * reported as busy; stopping comes from the reservation state, not an admission error.
 */
export type ProviderTurnDeclineReason = Exclude<TurnAdmissionFailureReason, "pending_mutation"> | "stopping";

/** Server decision for a provider-started turn. */
export type ProviderTurnOpening =
  | { kind: "opened"; routing: ProviderTurnRouting }
  | { kind: "declined"; reason: ProviderTurnDeclineReason };

/**
 * Admits a turn the provider started on its own, such as a reply to a finished
 * background task. The server mints the identity and records `notice` as the
 * turn's opening line; a declined turn's output must not be published.
 */
export interface ProviderTurnPort {
  open(request: { threadId: string; notice: string }): Promise<ProviderTurnOpening>;
  /**
   * Settles a tool call that kept running after its turn ended. Its turn's
   * event route is already retired, so the result cannot use `events.submit`.
   */
  settleBackgroundTool(settlement: ProviderBackgroundToolSettlement): Promise<void>;
}

/** The final outcome of a background tool call whose launching turn has ended. */
export interface ProviderBackgroundToolSettlement {
  providerId: string;
  threadId: string;
  /** Execution of the turn that launched the call, not the turn running now. */
  executionId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  output: string;
}

/** Narrow server services that Provider implementations can use. */
export interface ProviderHostPorts {
  occupancy: ProviderSessionOccupancyPort;
  runtime: ProviderRuntimePort;
  environment: ProviderEnvironmentPort;
  processes: ProviderProcessPort;
  browser: ProviderBrowserPort;
  mcode: ProviderMcodePort;
  grants: ProviderGrantPort;
  events: ProviderEventSinkPort;
  turns: ProviderTurnPort;
}

/** Identity of one provider's pooled thread session. */
export interface ProviderSessionKey { providerId: string; threadId: string }
/** Server-owned activity and declared protection. */
export interface ProviderSessionOccupancy { held: boolean; lastActivityAt: number | null; lastUserTurnAt: number | null }
/** Lifecycle and activity boundary shared by all providers. */
export interface ProviderSessionOccupancyPort {
  read(key: ProviderSessionKey, now: number): ProviderSessionOccupancy;
  /** Called once the session is pooled; returns the epoch its later close must name. */
  openSession(key: ProviderSessionKey): number;
  /** A stale epoch is ignored, so an old session's late teardown cannot close its replacement. */
  closeSession(key: ProviderSessionKey, epoch: number): void;
  /** The provider's native background task list changed; restarts the idle clock. */
  nativeChanged(key: ProviderSessionKey): void;
}
