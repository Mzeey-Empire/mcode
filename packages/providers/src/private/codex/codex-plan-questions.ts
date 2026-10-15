import * as NodeCrypto from "node:crypto";
import { z } from "zod";
import { logger } from "@mcode/shared";
import {
  lazySchema,
  type NativePlanQuestionBatch,
  type PlanAnswer,
  type PlanQuestionHandler,
  type PlanQuestionSettlement,
} from "@mcode/contracts";

const requestSchema = lazySchema(() => z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(z.object({
    id: z.string().min(1),
    header: z.string(),
    question: z.string(),
    isOther: z.boolean(),
    isSecret: z.boolean(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).min(2).max(5),
  })).min(1).max(15),
  isBlocking: z.boolean().optional(),
  autoResolutionMs: z.number().nullable().optional(),
}).refine(value => new Set(value.questions.map(question => question.id)).size === value.questions.length));
const resolvedSchema = lazySchema(() => z.object({ threadId: z.string(), requestId: z.number() }));

/** Response writers belong to one app-server connection, never to a renderer. */
export interface CodexQuestionRequest {
  rpcId: number;
  params: unknown;
  respond(result: { answers: Record<string, { answers: string[] }> }): Promise<void>;
  cancel(): Promise<void>;
}

interface PendingQuestion {
  batch: NativePlanQuestionBatch;
  sessionId: string;
  request: CodexQuestionRequest;
  nativeThreadId: string;
  ready: Promise<void>;
  settling: boolean;
}

/** Holds native responders while durable batches survive renderer reconnects. */
export class CodexPlanQuestions {
  private readonly pending = new Map<string, PendingQuestion>();
  private handler: PlanQuestionHandler | undefined;

  /** Native planning is unavailable until its durable handler is installed. */
  get enabled(): boolean {
    return this.handler !== undefined;
  }

  /** Install the server-owned question persistence callbacks. */
  bind(handler: PlanQuestionHandler): void {
    this.handler = handler;
  }

  /** Validate and publish a request only for the owning native turn. */
  async request(
    sessionId: string,
    threadId: string,
    nativeThreadId: string,
    nativeTurnId: string,
    request: CodexQuestionRequest,
  ): Promise<void> {
    const parsed = requestSchema().safeParse(request.params);
    if (!parsed.success) {
      logger.warn("Codex question request failed validation", { paths: parsed.error.issues.map(issue => issue.path) });
      await request.cancel();
      return;
    }
    if (parsed.data.questions.some(question => question.isSecret)) {
      logger.warn("Codex secret questions are unsupported");
      await request.cancel();
      return;
    }
    if (!this.handler || this.hasPending(sessionId)) {
      await request.cancel();
      return;
    }
    const params = parsed.data;
    if (params.threadId !== nativeThreadId || params.turnId !== nativeTurnId) {
      await request.cancel();
      return;
    }
    const requestId = NodeCrypto.randomUUID();
    const batch: NativePlanQuestionBatch = {
      requestId,
      threadId,
      questions: params.questions.map(question => ({
        id: `${requestId}:${question.id}`,
        category: question.header,
        question: question.question,
        options: question.options.map((option, index) => ({
          id: String(index),
          title: option.label,
          description: option.description,
          recommended: option.label.endsWith("(Recommended)"),
        })),
      })),
    };
    const entry: PendingQuestion = {
      batch, sessionId, request, nativeThreadId, ready: Promise.resolve(), settling: false,
    };
    this.pending.set(batch.requestId, entry);
    entry.ready = this.handler.requested(batch);
    try {
      await entry.ready;
    } catch (error) {
      this.pending.delete(batch.requestId);
      await request.cancel();
      throw error;
    }
  }

  /** Provider-side automatic resolution invalidates the retained responder. */
  async resolved(sessionId: string, input: unknown): Promise<void> {
    const parsed = resolvedSchema().safeParse(input);
    if (!parsed.success) return;
    const entry = [...this.pending.values()].find(candidate =>
      candidate.sessionId === sessionId
      && candidate.nativeThreadId === parsed.data.threadId
      && candidate.request.rpcId === parsed.data.requestId);
    if (!entry || entry.settling) return;
    entry.settling = true;
    await entry.ready;
    await this.settle(entry, "expired");
  }

  /** Deliver selected titles or the user's own answer through the original responder. */
  async answer(threadId: string, requestId: string, answers: PlanAnswer[] | "dismiss"): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.batch.threadId !== threadId) return false;
    if (entry.settling) throw new Error("Questions already settling");
    const response = this.response(entry.batch, answers);
    entry.settling = true;
    await entry.ready;
    try {
      await entry.request.respond(response);
      await this.settle(entry, answers === "dismiss" ? "dismissed" : "answered");
    } catch (error) {
      await this.settle(entry, "expired");
      throw error;
    }
    return true;
  }

  /** Cancel before interrupting; a dead transport expires without attempting a reply. */
  async drain(sessionId: string, status: "dismissed" | "expired"): Promise<boolean> {
    const entries = [...this.pending.values()].filter(entry => entry.sessionId === sessionId);
    for (const entry of entries) {
      if (entry.settling) continue;
      entry.settling = true;
      await entry.ready;
      try {
        if (status === "dismissed") await entry.request.cancel();
      } finally {
        await this.settle(entry, status);
      }
    }
    return entries.length > 0;
  }

  /** Whether a process exit interrupts a turn waiting on the user. */
  hasPending(sessionId: string): boolean {
    return [...this.pending.values()].some(entry => entry.sessionId === sessionId);
  }

  private async settle(entry: PendingQuestion, status: PlanQuestionSettlement): Promise<void> {
    try {
      await this.handler?.settled(entry.batch, status);
    } finally {
      this.pending.delete(entry.batch.requestId);
    }
  }

  private response(batch: NativePlanQuestionBatch, answers: PlanAnswer[] | "dismiss") {
    if (answers !== "dismiss" && (answers.length !== batch.questions.length
      || new Set(answers.map(answer => answer.questionId)).size !== answers.length)) {
      throw new Error("Answer every question exactly once");
    }
    const values = batch.questions.map(question => {
      const nativeId = question.id.slice(batch.requestId.length + 1);
      if (answers === "dismiss") return [nativeId, { answers: [] }] as const;
      const answer = answers.find(candidate => candidate.questionId === question.id);
      const text = answer?.freeText ?? question.options.find(option => option.id === answer?.selectedOptionId)?.title;
      if (text === undefined || !text.trim()) throw new Error("A question has no answer");
      return [nativeId, { answers: [text] }] as const;
    });
    return { answers: Object.fromEntries(values) };
  }
}
