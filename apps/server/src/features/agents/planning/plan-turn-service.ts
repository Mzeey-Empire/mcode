import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  AgentEvent,
  PlanCapture,
  ContextWindowMode,
  InteractionMode,
  IProviderRegistry,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  TurnRequest,
  PlanQuestion,
  NativePlanQuestionBatch,
  PlanQuestionSettlement,
} from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  AGENT_TURN_COMMAND_PORT,
  type AgentTurnCommandPort,
} from "../orchestration/agent-turn-command-port.js";
import { PlanExecutionState, type PlanPersistenceReady } from "./plan-execution-state.js";
import { PlanQuestionService, type PlanAnswerInput } from "./plan-question-service.js";
import { PlanRepo } from "./persistence/plan-repo.js";
import { ProviderIdSchema } from "@mcode/contracts";
import type { PlanFileWriter } from "./plan-file-writer.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";

/** Admission decision shared by the provider request and worker capture setup. */
export type PlanTurnClassification = NonNullable<TurnRequest["planTurn"]> | { kind: "implement" | "none" };

type PlanMessage = Extract<AgentEvent, { type: "message" }>;

type ClaudePlanAnswerModeProvider = {
  setPlanAnswerMode(threadId: string, enabled: boolean): void;
};

/** Owns plan-question turns and durable plan capture materialization. */
@injectable()
export class PlanTurnService {
  private readonly executionByThread = new Map<string, PlanExecutionState>();
  private readonly nativeQuestionThreads = new Set<string>();
  private publishNativeReceipt: ((event: AgentEvent) => void) | undefined;
  private projection: { progress: Pick<CanonicalAcceptedProgress, "reloadPlans" | "waitForTerminalSaves"> | undefined; files: PlanFileWriter } | undefined;

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: IProviderRegistry,
    @inject(PlanQuestionService) private readonly questions: PlanQuestionService,
    @inject(PlanRepo) private readonly planRepo: PlanRepo,
    @inject(AGENT_TURN_COMMAND_PORT) private readonly commands: AgentTurnCommandPort,
  ) {}

  /** Connect the legacy capture path to the same post-commit projections as canonical capture. */
  bindPlanProjection(progress: Pick<CanonicalAcceptedProgress, "reloadPlans" | "waitForTerminalSaves"> | undefined, files: PlanFileWriter): void {
    this.projection = { progress, files };
  }

  /** Install durable callbacks before an adapter can advertise native planning. */
  bindNativeQuestions(publish: (event: AgentEvent) => void): void {
    this.publishNativeReceipt = publish;
    for (const provider of this.providerRegistry.resolveAll()) {
      provider.bindPlanQuestions?.({
        requested: async batch => {
          await this.questions.createNative(batch);
          this.threadRepo.publishPlanPhase(batch.threadId);
          broadcast("plan.questions", { threadId: batch.threadId, questions: batch.questions });
        },
        settled: (batch, status) => this.settleNativeQuestions(batch, status),
      });
    }
  }

  /** Freeze the adapter decision before classification and prompt construction. */
  async prepareNativeQuestions(threadId: string, providerId: ProviderId): Promise<void> {
    const enabled = await this.providerRegistry.resolve(providerId).supportsNativePlanQuestions?.();
    if (enabled) this.nativeQuestionThreads.add(threadId);
    else this.nativeQuestionThreads.delete(threadId);
  }

  /** Whether this admission uses the provider's question and plan protocol. */
  usesNativeQuestions(threadId: string): boolean {
    return this.nativeQuestionThreads.has(threadId);
  }

  /** A server restart cannot recover JSON-RPC responders from persisted batches. */
  async recoverNativeQuestions(): Promise<void> {
    for (const batch of this.questions.pendingNative()) {
      await this.settleNativeQuestions(batch, "expired");
    }
  }

  private async settleNativeQuestions(batch: NativePlanQuestionBatch, status: PlanQuestionSettlement): Promise<void> {
    const receipt = await this.questions.settleNative(batch, status);
    if (!receipt) return;
    broadcast(status === "answered" ? "plan.answered" : "plan.dismissed", {
      threadId: batch.threadId, assistantMessageId: batch.requestId,
    });
    this.threadRepo.publishPlanPhase(batch.threadId);
    this.publishNativeReceipt?.({ type: "system", threadId: batch.threadId, subtype: "plan.questions.settled",
      message: receipt.content, messageId: receipt.id,
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "turn", noticeKey: batch.requestId } });
  }

  /** Refuse admission when the provider would see a stale plan file. */
  async prepareTurn(threadId: string): Promise<void> {
    await this.projection?.progress?.waitForTerminalSaves(threadId);
    await this.projection?.files.write(threadId);
  }

  /** Classify only after the preceding execution releases its worker and capture state. */
  classify(command: Pick<SendMessageCommand, "threadId" | "interactionMode" | "markPlanAnswerForMessageId" | "planImplement" | "planCommentIds" | "providerOriginated" | "provider">): PlanTurnClassification {
    if (command.planImplement) return { kind: "implement" };
    if (command.providerOriginated) return { kind: "none" };
    if (command.markPlanAnswerForMessageId) return this.classifyOutput(command.threadId, "planning", command.provider);
    if (command.planCommentIds?.length) return this.classifyOutput(command.threadId, "revise", command.provider);
    return this.classifyByMode(command.threadId, command.interactionMode, command.provider);
  }

  private classifyByMode(threadId: string, interactionMode: InteractionMode | undefined, providerId?: ProviderId): PlanTurnClassification {
    const mode = interactionMode ?? this.threadRepo.findById(threadId)?.interaction_mode;
    if (mode !== "plan") return { kind: "none" };
    const latest = this.planRepo.getLatestForThread(threadId);
    if (latest && (latest.status === "draft" || latest.status === "ready")) return this.classifyOutput(threadId, "revise", providerId);
    if (this.usesNativeQuestions(threadId)) return this.classifyOutput(threadId, "planning", providerId);
    this.beginQuestionGeneration(threadId);
    return { kind: "questions", planFilePath: null };
  }

  private classifyOutput(threadId: string, kind: "planning" | "revise", providerId?: ProviderId): NonNullable<TurnRequest["planTurn"]> {
    this.beginOutputGeneration(threadId, providerId);
    return { kind, planFilePath: this.projection?.files.path(threadId) ?? null };
  }

  /** Publish durable phase changes only after the parent turn has been admitted. */
  async admitted(threadId: string, classification: PlanTurnClassification): Promise<void> {
    if (classification.kind === "planning" || classification.kind === "revise") {
      await this.threadRepo.updatePlanPhase(threadId, "planning");
    } else if (classification.kind === "implement") {
      this.threadRepo.publishPlanPhase(threadId);
    } else if (classification.kind === "questions") {
      await this.dismissQuestions(threadId);
    }
  }

  /** Read committed notes after admission, while the running turn excludes user edits. */
  sentComments(threadId: string, ids: readonly string[]) {
    const selected = new Set(ids);
    const comments = this.planRepo.listComments(threadId).filter(comment => selected.has(comment.id));
    broadcast("plan.commentsChanged", { threadId, upserted: comments, deletedIds: [] });
    return { comments, versions: this.planRepo.listByThread(threadId) };
  }

  /** Start parsing one plan-question generation turn. */
  beginQuestionGeneration(threadId: string): void {
    this.execution(threadId).beginQuestionGeneration();
  }

  /** Start parsing one structured plan capture turn and arm its native provider mode. */
  beginOutputGeneration(threadId: string, providerId?: ProviderId): void {
    this.execution(threadId).beginOutputGeneration();
    this.armNativeOutputMode(threadId, providerId);
  }

  /** Return the provider prompt used to collect plan questions. */
  buildQuestionPrompt(userMessage: string): string {
    return `[PLAN MODE] You are in planning mode. Your only job right now is to identify 2-5 key architectural decisions that need user input, based solely on the user's message below.

Constraints:
- Do NOT call any tools. Do NOT read files, run commands, or explore the codebase.
- Do NOT use native ask-question or create-plan tools; Mcode renders questions from a fenced block.
- Do NOT write any prose, preamble, or commentary.
- Your entire response MUST be the single fenced plan-questions block shown below, then stop.
- After the user answers, you will receive their selections in a follow-up turn and may then plan freely.

Output format (must be valid JSON inside the fence):

\`\`\`plan-questions
[
  {
    "id": "q1",
    "category": "CATEGORY_NAME",
    "question": "Your question here?",
    "options": [
      { "id": "o1", "title": "Option Title", "description": "Brief description.", "recommended": true },
      { "id": "o2", "title": "Another Option", "description": "Brief description." }
    ]
  }
]
\`\`\`

---

${userMessage}`;
  }

  /** Return instructions that require a structured plan capture block. */
  buildPlanOutputInstructions(): string {
    return this.questions.buildPlanOutputInstructions();
  }

  /** Consume one visible text delta while a plan turn is active. */
  onTextDelta(threadId: string, delta: string): void {
    const ready = this.executionByThread.get(threadId)?.feedText(delta);
    if (ready) this.publishQuestions(threadId, ready.questions);
  }

  /** The broadcast stays synchronous with the parsed delta; the phase write follows and republishes the thread. */
  private publishQuestions(threadId: string, questions: PlanQuestion[]): void {
    broadcast("plan.questions", { threadId, questions });
    this.threadRepo.updatePlanPhase(threadId, "questions").catch((error: unknown) => {
      logger.error("Failed to record the questions plan phase", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Capture native plan markdown until its assistant message receives a durable identity. */
  handlePlanCaptured(capture: PlanCapture): void {
    this.execution(capture.threadId).handlePlanCapture(capture);
  }

  /** Return whether a message needs early durable materialization for a plan record. */
  needsAssistantMaterialization(event: PlanMessage): boolean {
    if (!event.messageId) return false;
    return this.executionByThread.get(event.threadId)?.needsAssistantMaterialization() ?? false;
  }

  /** Persist the one plan record that an assistant message can materialize. */
  async persistAssistantMessage(event: PlanMessage): Promise<void> {
    if (!event.messageId) return;
    const execution = this.executionByThread.get(event.threadId);
    const ready = execution?.consumeAssistantMessage(event.content);
    if (execution && ready) await this.persistPlan(event.threadId, event.messageId, ready, execution);
  }

  /** Submit answers and dispatch the complete answer turn through the command facade. */
  async answerQuestions(
    threadId: string,
    answers: PlanAnswerInput[],
    permissionMode: PermissionMode | "default" = "default",
    reasoningLevel?: ReasoningLevel,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const native = this.questions.pendingNative(threadId)[0];
    if (native) {
      const provider = this.providerRegistry.resolve(ProviderIdSchema.parse(thread.provider));
      if (!await provider.respondToPlanQuestions?.(threadId, native.requestId, answers)) {
        await this.settleNativeQuestions(native, "expired");
        throw new Error("Questions expired");
      }
      return;
    }
    if (answers.some(answer => /^[0-9a-f-]{36}:/.test(answer.questionId))) throw new Error("Questions expired");
    const payload = this.questions.buildAnswerPayload(threadId, answers);
    await this.commands.sendMessage({
      threadId,
      content: payload.content,
      permissionMode,
      model: thread.model ?? "claude-sonnet-4-6",
      attachments: [],
      reasoningLevel,
      provider: (thread.provider as ProviderId) ?? "claude",
      contextWindow,
      thinking,
      markPlanAnswerForMessageId: payload.markPlanAnswerForMessageId,
    });
  }

  /** Settle the latest plan-question batch without sending a provider turn. */
  async dismissQuestions(threadId: string): Promise<void> {
    const native = this.questions.pendingNative(threadId)[0];
    if (native) {
      const thread = this.threadRepo.findById(threadId);
      const provider = this.providerRegistry.resolve(ProviderIdSchema.parse(thread?.provider));
      if (!await provider.respondToPlanQuestions?.(threadId, native.requestId, "dismiss")) {
        await this.settleNativeQuestions(native, "expired");
      }
      return;
    }
    const assistantMessageId = await this.questions.dismiss(threadId);
    if (assistantMessageId) broadcast("plan.dismissed", { threadId, assistantMessageId });
    if (this.threadRepo.findById(threadId)?.plan_phase === "questions") await this.threadRepo.updatePlanPhase(threadId, null);
    this.threadRepo.publishPlanPhase(threadId);
  }

  /** Record a capture already persisted by the execution worker. */
  markPlanPersisted(threadId: string): void {
    this.executionByThread.get(threadId)?.markPlanPersisted();
  }

  /** Clear volatile plan state once a turn reaches its terminal lifecycle. */
  clearTurn(threadId: string): void {
    this.executionByThread.delete(threadId);
  }

  private armNativeOutputMode(threadId: string, requestedProviderId?: ProviderId): void {
    const providerId = requestedProviderId ?? this.threadRepo.findById(threadId)?.provider;
    if (providerId !== "claude") return;
    const provider = this.providerRegistry.resolve(providerId) as Partial<ClaudePlanAnswerModeProvider>;
    provider.setPlanAnswerMode?.(threadId, true);
  }

  private async persistPlan(
    threadId: string,
    messageId: string,
    ready: PlanPersistenceReady,
    execution: PlanExecutionState,
  ): Promise<void> {
    if (execution.hasPersistedPlan()) return;
    try {
      const provider = ProviderIdSchema.safeParse(this.threadRepo.findById(threadId)?.provider);
      await this.planRepo.create(threadId, messageId, ready, provider.success ? provider.data : null);
      execution.markPlanPersisted();
      this.threadRepo.publishPlanPhase(threadId);
      this.projection?.progress?.reloadPlans(threadId);
      for (const version of this.planRepo.listByThread(threadId)) broadcast("plan.versionUpserted", { threadId, version });
      broadcast("plan.commentsChanged", { threadId, upserted: this.planRepo.listComments(threadId), deletedIds: [] });
      await this.projection?.files.writeAfterCommit(threadId);
    } catch (error) {
      logger.error("Failed to persist plan output", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private execution(threadId: string): PlanExecutionState {
    const state = this.executionByThread.get(threadId) ?? new PlanExecutionState();
    this.executionByThread.set(threadId, state);
    return state;
  }
}
