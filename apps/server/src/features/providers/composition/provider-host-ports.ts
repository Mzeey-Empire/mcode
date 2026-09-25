import type {
  ProviderEventBatch,
  ProviderEventCommitReceipt,
  ProviderHostPorts,
  ProviderEventSubmissionReceipt,
} from "@mcode/providers";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import type { EnvService } from "../../../runtime/environment/env-service.js";
import type { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import type { CanonicalAgentBoundary } from "../../agents/index.js";
import type { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import type { InternalThreadControlMcpRuntime } from "../../thread-control/index.js";
import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";
import type { ProviderEventIngress } from "./provider-event-ingress.js";
import type { ProjectedCommittedProviderEvent } from "../../agents/execution/execution-worker-handler.js";

/** A provider batch with the stable identity required by a worker owner. */
export type WorkerOwnedProviderEventBatch = ProviderEventBatch & {
  batchId: string;
  deliveryAttempt: number;
};

/** One acknowledged worker commit and its projected live events, bound to the batch. */
export interface WorkerOwnedProviderEventResult {
  batchId: string;
  deliveryAttempt: number;
  commit: ProviderEventCommitReceipt;
  providerEvents: readonly ProjectedCommittedProviderEvent[];
}

/** One durable route decision for an execution. Retired executions must resolve to rejected. */
export type ProviderEventOwnershipRoute =
  | { kind: "legacy" }
  | { kind: "rejected" }
  | {
    kind: "worker";
    threadId: string;
    turnId: string;
    executionId: string;
    deliveryAttempt: number;
    submit(batch: WorkerOwnedProviderEventBatch): Promise<WorkerOwnedProviderEventResult>;
  };

/** Selects one commit owner for every batch of an exact execution. */
export interface ProviderEventOwnership {
  resolve(executionId: string): ProviderEventOwnershipRoute;
}

/** Server services used to compose the narrow Provider host-port boundary. */
export interface ProviderHostPortDependencies {
  runtime: HostRuntime;
  envService: EnvService;
  jobObject: JobObject;
  browser: BrowserAutomationSessionLease;
  threadControl: InternalThreadControlMcpRuntime;
  grants: ScopedPreGrantService;
  events: CanonicalAgentBoundary;
  ingress: ProviderEventIngress;
  eventOwnership?: ProviderEventOwnership;
}

/** Adapts server-owned services to the only host operations exposed to Providers. */
export function createProviderHostPorts(
  dependencies: ProviderHostPortDependencies,
): ProviderHostPorts {
  return {
    runtime: dependencies.runtime,
    environment: {
      snapshot: () => dependencies.envService.getEnv(),
    },
    processes: {
      attach: (pid, description) => {
        if (!dependencies.jobObject.isWindowsJob) return;
        dependencies.jobObject.assign(pid);
        dependencies.jobObject.setDescription(pid, description);
      },
      terminateTree: (pid) => killProcessTree(pid, {
        platform: dependencies.runtime.platform,
      }),
    },
    browser: {
      stage: (request) => dependencies.browser.stage(request),
      releaseSession: (providerId, sessionId) =>
        dependencies.browser.releaseSession(providerId, sessionId),
      isConfigured: () => dependencies.browser.isConfigured(),
      issue: (stage) => {
        const grant = dependencies.browser.issue(stage);
        if (!grant) return null;
        return {
          leaseId: grant.leaseId,
          mcpUrl: grant.mcpUrl,
          token: grant.token,
          credentialId: grant.credentialId,
          expiresAt: grant.expiresAt,
          allowedOperations: [...grant.allowedOperations],
        };
      },
      refresh: (leaseId) => dependencies.browser.refresh(leaseId),
      release: (leaseId) => dependencies.browser.release(leaseId),
      revokeCredential: (credentialId) => dependencies.browser.revokeCredential(credentialId),
    },
    threadControl: {
      bootstrap: async (request) => {
        switch (request.protocol) {
          case "claude":
            return dependencies.threadControl.createClaudeServer(request.sessionId) ?? null;
          case "codex":
            return await dependencies.threadControl.createCodexConfiguration(request.sessionId) ?? null;
          case "http":
            return await dependencies.threadControl.createHttpConnection(request.sessionId) ?? null;
          default: {
            const unsupportedProtocol: never = request.protocol;
            throw new Error(`Unsupported Provider thread-control protocol: ${String(unsupportedProtocol)}`);
          }
        }
      },
      close: (sessionId) => dependencies.threadControl.close(sessionId),
    },
    grants: {
      consume: (request) => dependencies.grants.tryConsume(request),
    },
    events: {
      submit: (batch) => submitProviderEvents(dependencies, batch),
    },
  };
}

async function submitProviderEvents(
  dependencies: ProviderHostPortDependencies,
  batch: ProviderEventBatch,
): Promise<ProviderEventSubmissionReceipt> {
  const route: ProviderEventOwnershipRoute = dependencies.eventOwnership?.resolve(batch.executionId)
    ?? { kind: "legacy" };
  if (route.kind === "rejected") throw new Error("Canonical event execution is no longer admitted");
  if (route.kind === "worker") return await submitWorkerEvents(dependencies, route, batch);
  return submitLegacyEvents(dependencies, batch);
}

async function submitWorkerEvents(
  dependencies: ProviderHostPortDependencies,
  route: Extract<ProviderEventOwnershipRoute, { kind: "worker" }>,
  batch: ProviderEventBatch,
): Promise<ProviderEventSubmissionReceipt> {
  const ownedBatch = checkedWorkerBatch(batch, route);
  const result = await route.submit(ownedBatch);
  if (!matchesWorkerReceipt(ownedBatch, result)) {
    throw new Error("Canonical worker receipt does not match submitted batch");
  }
  if (result.commit.outcome === "conflict" || result.commit.outcome === "ingest-overflow") {
    throw new Error(`Canonical worker batch failed: ${result.commit.outcome}`);
  }
  if (result.commit.outcome === "committed" && result.providerEvents.length > 0) {
    dependencies.ingress.acceptProjectedCommitted(result.providerEvents);
  }
  return {
    commit: result.commit,
    delivery: { ingress: result.commit.outcome === "committed" && result.providerEvents.length > 0
      ? "queued" : "not-required" },
  };
}

function submitLegacyEvents(
  dependencies: ProviderHostPortDependencies,
  batch: ProviderEventBatch,
): ProviderEventSubmissionReceipt {
  const result = dependencies.events.commit({
    threadId: batch.threadId,
    turnId: batch.turnId,
    executionId: batch.executionId,
    phase: batch.phase,
    nativeCursor: batch.nativeCursor,
    events: batch.events,
  });
  return deliverCommitted(dependencies.ingress, {
    outcome: providerCommitOutcome(result.outcome),
    conversationRevision: result.conversationRevision,
    rosterRevision: result.rosterRevision,
    acceptedThrough: result.acceptedThrough,
    durableThrough: result.durableThrough,
    eventCount: result.events.length,
  }, result.events);
}

function deliverCommitted(
  ingress: ProviderEventIngress,
  commit: ProviderEventCommitReceipt,
  events: readonly CanonicalAgentEventEnvelope[],
): ProviderEventSubmissionReceipt {
  const handoff = commit.outcome === "committed" && events.length > 0;
  if (handoff) ingress.acceptCommitted(events);
  return { commit, delivery: { ingress: handoff ? "queued" : "not-required" } };
}

function matchesWorkerReceipt(
  batch: WorkerOwnedProviderEventBatch,
  result: WorkerOwnedProviderEventResult,
): boolean {
  if (result.batchId !== batch.batchId || result.deliveryAttempt !== batch.deliveryAttempt) return false;
  if (result.commit.outcome !== "committed") return result.providerEvents.length === 0;
  const submittedIds = new Set(batch.events.map((event) => event.eventId));
  return result.providerEvents.length <= result.commit.eventCount
    && result.providerEvents.every((event) => submittedIds.has(event.canonicalReceipt.eventId));
}

function checkedWorkerBatch(
  batch: ProviderEventBatch,
  route: Extract<ProviderEventOwnershipRoute, { kind: "worker" }>,
): WorkerOwnedProviderEventBatch {
  if (!batch.batchId || !Number.isSafeInteger(batch.deliveryAttempt) || (batch.deliveryAttempt ?? 0) < 1
    || batch.deliveryAttempt !== route.deliveryAttempt
    || !matchesExecution(batch, route)
    || batch.events.length === 0
    || !batch.events.every((event) => matchesExecution(event.routing, route))) {
    throw new Error("Canonical worker batch does not match execution ownership");
  }
  return { ...batch, batchId: batch.batchId, deliveryAttempt: batch.deliveryAttempt };
}

function matchesExecution(
  routing: { threadId: string; turnId?: string; executionId: string },
  route: Pick<ProviderEventBatch, "threadId" | "turnId" | "executionId">,
): boolean {
  return routing.threadId === route.threadId && routing.turnId === route.turnId
    && routing.executionId === route.executionId;
}

function providerCommitOutcome(
  outcome: "committed" | "duplicate" | "conflict" | "terminal-outcome-confirmed" | "ingest-overflow",
): "committed" | "duplicate" | "conflict" | "ingest-overflow" {
  if (outcome === "terminal-outcome-confirmed") return "duplicate";
  return outcome;
}
