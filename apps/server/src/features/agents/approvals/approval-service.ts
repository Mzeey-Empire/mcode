import {
  ApprovalRequestBodySchema, ApprovalRequestSchema, ApprovalResponseSchema,
  type ApprovalOutcome, type ApprovalRequest, type ApprovalRequestEnvelope,
  type ApprovalRespondResult, type ApprovalResponse, type IAgentProvider, type ProviderId, type TurnStopCause,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { inject, injectable } from "tsyringe";
import { ApprovalNoteAlreadyDeliveredError, ApprovalNoteRepo, type ApprovalNoteRow } from "./approval-note-repo.js";

type ApprovalProvider = Pick<IAgentProvider, "id" | "on" | "resolveApproval" | "listPendingApprovals">;
type ApprovalOwner = Pick<IAgentProvider, "resolveApproval" | "listPendingApprovals"> & { id: ProviderId | null };
const REMEMBERED_RESPONSES = 1_000;
type Resolution ={ requestId: string; threadId: string; outcome: ApprovalOutcome };
type ThreadApprovalSource = {
  listPendingApprovals(threadId?: string): ApprovalRequest[];
  respondToApproval(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult>;
};

function answeredWithOtherNote(note: string | undefined, saved: { note: string | undefined } | undefined, row: ApprovalNoteRow | null): boolean {
  if (saved && saved.note !== note) return true;
  return row !== null && row.note !== note;
}

/** Runtime effects shared by provider and thread-operation approvals. */
export interface ApprovalPublication {
  publishApprovalRequest(request: ApprovalRequest): void;
  publishApprovalResolved(payload: Resolution): void;
  stopSession(threadId: string, stop: TurnStopCause): Promise<unknown>;
}

/** Validates all approval ingress, routes answers, and stops unanswerable turns. */
@injectable()
export class ApprovalService {
  private publication?: ApprovalPublication;
  private threadControl?: ThreadApprovalSource;
  private readonly inFlight = new Map<string, Promise<ApprovalRespondResult>>();
  private readonly automatic = new Set<string>();
  private readonly responses = new Map<string, { note: string | undefined; result: ApprovalRespondResult }>();
  private readonly noteAdmissions = new Map<string, Promise<void>>();
  private ready: Promise<void> = Promise.resolve();
  private newResponsesBlocked = false;

  constructor(
    @inject("IProviderRegistry") private readonly providers: { resolveAll(): ApprovalProvider[] },
    @inject(ApprovalNoteRepo) private readonly notes: ApprovalNoteRepo,
  ) {}

  /** Connect the publication effects and subscribe once during server startup. */
  start(publication: ApprovalPublication, threadControl?: ThreadApprovalSource): Promise<void> {
    this.publication = publication;
    this.threadControl = threadControl;
    this.ready = this.notes.recoverPending();
    for (const provider of this.providers.resolveAll()) {
      provider.on("approval_request", (envelope) => this.publish(envelope, provider));
      provider.on("approval_resolved", (payload) => this.resolved(payload));
    }
    return this.ready;
  }

  /**
   * Refuse responds that have not started, at shutdown. A respond already waiting on its
   * adapter still records the result, so an acknowledged note is never retried as unknown.
   */
  blockNewResponses(): void {
    this.newResponsesBlocked = true;
  }

  /** Restore retained notes after startup reconciliation. */
  async listNotes() {
    await this.ready;
    return this.notes.listNotes();
  }

  /** Edit a note only while it is held. */
  async updateNote(requestId: string, note: string): Promise<{ status: "updated" | "closed" }> {
    await this.ready;
    return { status: await this.notes.updateNote(requestId, note) ? "updated" : "closed" };
  }

  /** Explicitly queue an uncertain note; admission still claims it once. */
  async resendNote(requestId: string): Promise<{ status: "queued" | "closed" }> {
    await this.ready;
    return { status: await this.notes.resendNote(requestId) ? "queued" : "closed" };
  }

  /** Remove a held note durably. */
  async removeNote(requestId: string): Promise<{ status: "removed" | "closed" }> {
    await this.ready;
    return { status: await this.notes.removeNote(requestId) ? "removed" : "closed" };
  }

  /**
   * Let a competing send finish admission before checking its claim, even while its turn still runs.
   * `admit` receives the stored note, which is the text the user last saved, not a client's copy.
   */
  async admitNote(requestId: string, threadId: string, admit: (note: string) => Promise<void>): Promise<void> {
    const previous = this.noteAdmissions.get(requestId);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.noteAdmissions.set(requestId, released);
    try {
      await previous;
      await this.ready;
      const row = this.notes.find(requestId);
      if (row?.state !== "queued" || row.threadId !== threadId) throw new ApprovalNoteAlreadyDeliveredError();
      await admit(row.note);
    } finally {
      release();
      if (this.noteAdmissions.get(requestId) === released) this.noteAdmissions.delete(requestId);
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
    if (!("autoDeny" in response)) {
      const parsed = ApprovalResponseSchema().safeParse(response);
      if (!parsed.success) return Promise.resolve({ status: "failed", message: "This approval response is not supported" });
      response = parsed.data;
    }
    const pending = this.inFlight.get(requestId);
    if (pending) return pending.then((result) => {
      const replay = this.replay(requestId, response);
      return replay?.status === "failed" ? replay : result;
    });
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
    await this.ready;
    if (this.newResponsesBlocked) throw new Error("ApprovalService is shutting down");
    const replay = this.replay(requestId, response);
    if (replay) return replay;
    const threadResult = await this.respondToThreadControl(requestId, response);
    if (threadResult && threadResult.status !== "not_pending") return threadResult;
    const holder = this.providerHolder(requestId);
    if (holder) return this.respondToProvider(holder.envelope, holder.owner, response);
    return this.endedNote(requestId);
  }

  private providerHolder(requestId: string): { envelope: ApprovalRequestEnvelope; owner: ApprovalOwner } | undefined {
    for (const owner of this.providers.resolveAll()) {
      const envelope = owner.listPendingApprovals?.().find((item) => item.requestId === requestId);
      if (envelope) return { envelope, owner };
    }
    return undefined;
  }

  private async respondToThreadControl(requestId: string, response: ApprovalResponse): Promise<ApprovalRespondResult | undefined> {
    const request = this.threadControl?.listPendingApprovals().find((item) => item.requestId === requestId);
    if (request && !("autoDeny" in response)) {
      const error = this.responseError(request, response);
      if (error) return { status: "failed", message: error };
    }
    return this.threadControl?.respondToApproval(requestId, response);
  }

  private replay(requestId: string, response: ApprovalResponse): ApprovalRespondResult | undefined {
    const saved = this.responses.get(requestId);
    const row = this.notes.find(requestId);
    if (!saved && this.isUndeliveredAttempt(row)) return undefined;
    const note = "autoDeny" in response ? undefined : response.note?.trim();
    if (answeredWithOtherNote(note, saved, row)) return { status: "failed", message: "This request was already answered" };
    if (row && row.state !== "pending") return this.storedResult(row);
    return saved?.result;
  }

  private isUndeliveredAttempt(row: ApprovalNoteRow | null): boolean {
    if (row?.state !== "pending") return false;
    return this.providerHolder(row.requestId) !== undefined;
  }

  private storedResult(row: ApprovalNoteRow): ApprovalRespondResult {
    if (row.state === "delivered" || row.state === "queued") return { status: "resolved", noteDelivery: row.delivery };
    if (row.state === "delivery_unknown") return this.responses.get(row.requestId)?.result ?? { status: "not_pending", note: "delivery_unknown" };
    return { status: "not_pending" };
  }

  private async endedNote(requestId: string): Promise<ApprovalRespondResult> {
    const row = this.notes.find(requestId);
    if (!row) return { status: "not_pending" };
    if (row.state !== "pending") return this.storedResult(row);
    await this.notes.recoverPending(requestId);
    return { status: "not_pending", note: row.delivery === "next_turn" ? "queued" : "delivery_unknown" };
  }

  private async respondToProvider(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner, response: ApprovalResponse): Promise<ApprovalRespondResult> {
    const refused = await this.prepareResponse(envelope, owner, response);
    if (refused) return refused;
    const result = await this.deliver(envelope.requestId, owner, response);
    if (result.status === "not_pending") return this.endedNote(envelope.requestId);
    if (result.status === "resolved") {
      const note = "autoDeny" in response ? undefined : response.note;
      if (note) await this.notes.settle(envelope.requestId, result.noteDelivery ?? "unknown");
      this.rememberResponse(envelope.requestId, { note, result });
    }
    return result;
  }

  private rememberResponse(requestId: string, entry: { note: string | undefined; result: ApprovalRespondResult }): void {
    this.responses.set(requestId, entry);
    if (this.responses.size <= REMEMBERED_RESPONSES) return;
    const oldest = this.responses.keys().next();
    if (!oldest.done) this.responses.delete(oldest.value);
  }

  private async prepareResponse(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner, response: ApprovalResponse): Promise<ApprovalRespondResult | undefined> {
    if (!("autoDeny" in response)) {
      const request = this.toApprovalRequest(envelope, owner);
      if (!request) {
        const parsed = ApprovalRequestBodySchema().safeParse(envelope.body);
        const reason = !parsed.success && parsed.error.issues.some((issue) => issue.code === "too_big") ? "too_large" : "unreadable";
        return this.failClosed(envelope, owner, reason);
      }
      const error = this.responseError(request, response);
      if (error) return { status: "failed", message: error };
      if (response.note && request.noteDelivery !== "none") {
        await this.notes.insertPending({ requestId: request.requestId, threadId: request.threadId, note: response.note, delivery: request.noteDelivery });
      } else if (this.notes.find(request.requestId)?.state === "pending") {
        await this.notes.discardPending(request.requestId);
      }
    }
    return undefined;
  }

  private responseError(request: ApprovalRequest, response: Exclude<ApprovalResponse, { autoDeny: string }>): string | undefined {
    const choice = request.choices.find((choice) => choice.id === response.choiceId);
    if (!choice) return "The approval choice is unavailable";
    if (response.answers && request.subject.kind !== "question") return "This approval does not accept question answers";
    if (response.note && (choice.intent !== "deny" || request.noteDelivery === "none")) return "This approval does not accept a note";
    return undefined;
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

  private async failClosed(envelope: ApprovalRequestEnvelope, owner: ApprovalOwner, reason: "unreadable" | "too_large"): Promise<ApprovalRespondResult> {
    this.automatic.add(envelope.requestId);
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
      await this.effects().stopSession(envelope.threadId, { by: "mcode", reason: "approval_unanswerable" });
    } catch {
      logger.error("Could not stop unanswerable approval turn", { providerId: owner.id, requestId: envelope.requestId, threadId: envelope.threadId });
    } finally {
      this.effects().publishApprovalResolved({ requestId: envelope.requestId, threadId: envelope.threadId, outcome: { status: "cancelled", reason: "unanswerable" } });
      this.automatic.delete(envelope.requestId);
    }
    return { status: "failed", message: "The approval could not be answered" };
  }
}
