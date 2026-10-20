import type {
  AgentEventRouting,
  CanonicalAgentEvent,
  ProviderIdentity,
} from "@mcode/agent-model";
import { AgentEventType, type AgentEvent, type InteractionMode } from "@mcode/contracts";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

/** Provider event input submitted to the server-owned canonical event sink. */
export interface ProviderEventDraft {
  eventId: string;
  routing: AgentEventRouting;
  sourceProviderId: string;
  sourceIdentities: readonly ProviderIdentity[];
  sourceSequence?: number;
  providerTimestamp?: string;
  ingestClass?: "volatile";
  payload: CanonicalAgentEvent;
}

/**
 * Streamed text and reasoning fragments are superseded by the settled item that follows,
 * so the sink may coalesce or shed them under pressure without losing durable state.
 */
export function volatileIngestClass(event: Pick<AgentEvent, "type">): Pick<ProviderEventDraft, "ingestClass"> {
  return event.type === AgentEventType.TextDelta || event.type === AgentEventType.ReasoningDelta
    ? { ingestClass: "volatile" }
    : {};
}

/** Supplies one server-owned environment snapshot to a Provider session spawn. */
export interface ProviderEnvironmentPort {
  snapshot(): Readonly<Record<string, string>>;
}

/** Supplies immutable facts about the Node runtime that hosts providers. */
export interface ProviderRuntimePort extends HostRuntime {}

/** Attaches and terminates child process trees without exposing the server process service. */
export interface ProviderProcessPort {
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
  /** Whether the thread-control toolkit is listed; Codex passes its per-turn eligibility. */
  threadControl: boolean;
}

/** How a Provider reaches its one `mcode` server and which toolkits it lists. */
export interface ProviderMcodeAttachment {
  serverName: "mcode";
  url: string;
  /** Opaque bearer for this session; never log or persist it. */
  token: string;
  toolkits: { browser: boolean; threadControl: boolean };
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

/** Why the server did not admit a provider-started turn. */
export type ProviderTurnDeclineReason = "busy" | "stopping" | "stopped" | "unavailable";

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
  threadId: string;
  /** Execution of the turn that launched the call, not the turn running now. */
  executionId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  output: string;
}

/** Narrow server services that Provider implementations can use. */
export interface ProviderHostPorts {
  runtime: ProviderRuntimePort;
  environment: ProviderEnvironmentPort;
  processes: ProviderProcessPort;
  browser: ProviderBrowserPort;
  mcode: ProviderMcodePort;
  grants: ProviderGrantPort;
  events: ProviderEventSinkPort;
  turns: ProviderTurnPort;
}
