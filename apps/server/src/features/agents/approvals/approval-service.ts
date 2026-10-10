import {
  ApprovalRequestBodySchema, ApprovalRequestSchema, ApprovalResponseSchema,
  type ApprovalOutcome, type ApprovalRequest, type ApprovalRequestEnvelope,
  type ApprovalRespondResult, type ApprovalResponse, type IAgentProvider, type ProviderId,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { inject, injectable } from "tsyringe";

type ApprovalProvider = Pick<IAgentProvider, "id" | "on" | "resolveApproval" | "listPendingApprovals">;
type ApprovalOwner = Pick<IAgentProvider, "resolveApproval" | "listPendingApprovals"> & { id: ProviderId | null };
type Resolution = { requestId: string; threadId: string; outcome: ApprovalOutcome };
type ThreadApprovalSource = {
  listPendingApprovals(threadId?: string): ApprovalRequest[];
  respondToApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult>;
};

/** Safe temporary card retained until durable approval receipts ship. */
export const UNREADABLE_APPROVAL_TITLE = "Mcode couldn't read this request";

/** Runtime effects shared by provider and thread-operation approvals. */
export interface ApprovalPublication {
  publishApprovalRequest(request: ApprovalRequest): void;
  publishApprovalResolved(payload: Resolution): void;
  stopSession(threadId: string): Promise<unknown>;
}

/** Validates all approval ingress, routes answers, and stops unanswerable turns. */
@injectable()
export class ApprovalService {
  private publication?: ApprovalPublication;
  private threadControl?: ThreadApprovalSource;
  private readonly inFlight = new Map<string, Promise<ApprovalRespondResult>>();
  private readonly automatic = new Set<string>();

  constructor(@inject("IProviderRegistry") private readonly providers: { resolveAll(): ApprovalProvider[] }) {}

  /** Connect the publication effects and subscribe once during server startup. */
  start(publication: ApprovalPublication, threadControl?: ThreadApprovalSource): void {
    this.publication = publication;
    this.threadControl = threadControl;
    for (const provider of this.providers.resolveAll()) {
      provider.on("approval_request", (envelope) => this.publish(envelope, provider));
      provider.on("approval_resolved", (payload) => this.resolved(payload));
    }
  }

  /** Publish only bodies accepted by the same validator used for listing. */
  publish(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner): void {
    const request = this.toApprovalRequest(envelope, owner);
    if (request) this.effects().publishApprovalRequest(request);
  }

  /** Publish an acknowledged native outcome unless an automatic answer owns it. */
  resolved(payload: Resolution): void {
    if (!this.automatic.has(payload.requestId)) this.effects().publishApprovalResolved(payload);
  }

  /** Coalesce concurrent answers and return the adapter's acknowledged result. */
  respondToApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    const pending = this.inFlight.get(requestId);
    if (pending) return pending;
    return this.track(requestId, () => this.respond(requestId, response));
  }

  /** An invalid provider item cannot hide valid approvals from other providers. */
  listPendingApprovals(threadId?: string): ApprovalRequest[] {
    const threadItems = (this.threadControl?.listPendingApprovals(threadId) ?? []).flatMap((request) => {
      const { requestId, threadId: ownerThreadId, providerId, ...body } = request;
      const validated = this.toApprovalRequest({ requestId, threadId: ownerThreadId, body }, {
        id: providerId, resolveApproval: (id, response) => this.threadControl?.respondToApproval(id, response) ?? Promise.resolve({ status: "not_pending" }),
      });
      return validated ? [validated] : [];
    });
    return [...threadItems, ...this.providers.resolveAll().flatMap((owner) => (owner.listPendingApprovals?.(threadId) ?? []).flatMap((envelope) => {
      const request = this.toApprovalRequest(envelope, owner);
      return request ? [request] : [];
    }))];
  }

  private effects(): ApprovalPublication {
    if (!this.publication) throw new Error("ApprovalService has not started");
    return this.publication;
  }

  private toApprovalRequest(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner): ApprovalRequest | undefined {
    const body = ApprovalRequestBodySchema().safeParse(envelope.body);
    const parsed = body.success
      ? ApprovalRequestSchema().safeParse({ ...body.data, requestId: envelope.requestId, threadId: envelope.threadId, providerId: owner.id })
      : body;
    if (parsed.success && "requestId" in parsed.data) return parsed.data;
    if (parsed.success) return undefined;
    logger.warn("Provider approval violated its contract", {
      providerId: owner.id, requestId: envelope.requestId,
      issues: parsed.error.issues.map(({ path, code }) => ({ path, code })),
    });
    if (!this.inFlight.has(envelope.requestId)) {
      const reason = parsed.error.issues.some((issue) => issue.code === "too_big") ? "too_large" : "unreadable";
      void this.track(envelope.requestId, () => this.failClosed(envelope, owner, reason));
    }
    return undefined;
  }

  private async respond(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    if (!("autoDeny" in response)) {
      const parsed = ApprovalResponseSchema().safeParse(response);
      if (!parsed.success || parsed.data.note) return { status: "failed", message: "This approval response is not supported" };
    }
    const threadResult = await this.threadControl?.respondToApproval(requestId, response);
    if (threadResult && threadResult.status !== "not_pending") return threadResult;
    for (const owner of this.providers.resolveAll()) {
      const envelope = owner.listPendingApprovals?.().find((item) => item.requestId === requestId);
      if (envelope) return this.respondToProvider(envelope, owner, response);
    }
    return { status: "not_pending" };
  }

  private async respondToProvider(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    if (!("autoDeny" in response)) {
      const request = this.toApprovalRequest(envelope, owner);
      if (!request) {
        const parsed = ApprovalRequestBodySchema().safeParse(envelope.body);
        const reason = !parsed.success && parsed.error.issues.some((issue) => issue.code === "too_big") ? "too_large" : "unreadable";
        return this.failClosed(envelope, owner, reason);
      }
      if (!request.choices.some((choice) => choice.id === response.choiceId)) return { status: "failed", message: "The approval choice is unavailable" };
      if (response.answers && request.subject.kind !== "question") return { status: "failed", message: "This approval does not accept question answers" };
    }
    return this.deliver(envelope.requestId, owner, response);
  }

  private async deliver(requestId: string, owner: ApprovalOwner, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    try {
      return await owner.resolveApproval?.(requestId, response) ?? { status: "not_pending" };
    } catch {
      return { status: "failed", message: "The answer did not reach the provider" };
    }
  }

  private track(requestId: string, run: () => Promise<ApprovalRespondResult>): Promise<ApprovalRespondResult> {
    const task = Promise.resolve().then(run).finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, task);
    return task;
  }

  private publishUnreadableStandIn(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner): void {
    this.effects().publishApprovalRequest({
      requestId: envelope.requestId, threadId: envelope.threadId, providerId: owner.id,
      requestedAt: new Date().toISOString(), subject: { kind: "tool", toolName: UNREADABLE_APPROVAL_TITLE },
      choices: [{ id: "deny", intent: "deny", label: "Deny" }], noteDelivery: "none",
      origin: owner.id === null ? { kind: "integration", label: "Integration" } : { kind: "agent" },
    });
  }

  private async failClosed(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner, reason: "unreadable" | "too_large"): Promise<ApprovalRespondResult> {
    this.automatic.add(envelope.requestId);
    this.publishUnreadableStandIn(envelope, owner);
    try {
      const result = await owner.resolveApproval?.(envelope.requestId, { autoDeny: reason });
      if (result?.status === "resolved") {
        this.effects().publishApprovalResolved({ requestId: envelope.requestId, threadId: envelope.threadId, outcome: { status: "auto_denied", reason } });
        this.automatic.delete(envelope.requestId);
        return result;
      }
    } catch {
      logger.error("Provider could not deny unreadable approval", { providerId: owner.id, requestId: envelope.requestId });
    }
    try {
      await this.effects().stopSession(envelope.threadId);
    } catch {
      logger.error("Could not stop unanswerable approval turn", { providerId: owner.id, requestId: envelope.requestId, threadId: envelope.threadId });
    } finally {
      this.effects().publishApprovalResolved({ requestId: envelope.requestId, threadId: envelope.threadId, outcome: { status: "cancelled", reason: "unanswerable" } });
      this.automatic.delete(envelope.requestId);
    }
    return { status: "failed", message: "The approval could not be answered" };
  }
}
