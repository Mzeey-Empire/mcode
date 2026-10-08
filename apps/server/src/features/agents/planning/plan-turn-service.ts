import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  AgentEvent,
  PlanCaptured,
  ContextWindowMode,
  IProviderRegistry,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
} from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  AGENT_TURN_COMMAND_PORT,
  type AgentTurnCommandPort,
} from "../orchestration/agent-turn-command-port.js";
import { PlanExecutionState, type PlanPersistenceReady } from "./plan-execution-state.js";
import { PlanQuestionService, type PlanAnswerInput } from "./plan-question-service.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { PlanRepo } from "./persistence/plan-repo.js";

type PlanMessage = Extract<AgentEvent, { type: "message" }>;

type ClaudePlanAnswerModeProvider = {
  setPlanAnswerMode(threadId: string, enabled: boolean): void;
};

/** Owns plan-question turns and durable mcode-plan materialization. */
@injectable()
export class PlanTurnService {
  private acceptedProgress: Pick<CanonicalAcceptedProgress, "recordSavedPlan" | "beforeDurableCommand" | "cancelDurableCommand"> | undefined;
  private readonly assistantByThread = new Map<string, PlanMessage>();
  private readonly executionByThread = new Map<string, PlanExecutionState>();

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: IProviderRegistry,
    @inject(PlanQuestionService) private readonly questions: PlanQuestionService,
    @inject(PlanRepo) private readonly planRepo: PlanRepo,
    @inject(AGENT_TURN_COMMAND_PORT) private readonly commands: AgentTurnCommandPort,
  ) {}

  /** Keep canonical plan reads current after the turn's captured plan is saved. */
  bindAcceptedProgress(progress: Pick<CanonicalAcceptedProgress, "recordSavedPlan" | "beforeDurableCommand" | "cancelDurableCommand">): void {
    this.acceptedProgress = progress;
  }

  /** Start parsing one plan-question generation turn. */
  beginQuestionGeneration(threadId: string): void {
    this.execution(threadId).beginQuestionGeneration();
  }

  /** Start parsing one structured mcode-plan turn and arm its native provider mode. */
  beginOutputGeneration(threadId: string): void {
    this.execution(threadId).beginOutputGeneration();
    this.armNativeOutputMode(threadId);
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

  /** Return instructions that require a structured mcode-plan block. */
  buildPlanOutputInstructions(): string {
    return this.questions.buildPlanOutputInstructions();
  }

  /** Consume one visible text delta while a plan turn is active. */
  onTextDelta(threadId: string, delta: string): void {
    const ready = this.executionByThread.get(threadId)?.feedText(delta);
    if (ready) broadcast("plan.questions", { threadId, questions: ready.questions });
  }

  /** Observe accepted text; the canonical owner already publishes its parsed questions. */
  observeAcceptedText(threadId: string, delta: string): void {
    this.executionByThread.get(threadId)?.feedText(delta);
  }

  /** Capture native plan markdown until its assistant message receives a durable identity. */
  handlePlanCaptured(capture: PlanCaptured): void {
    this.execution(capture.threadId).handleCapture(capture);
  }

  /** Return whether a message needs early durable materialization for a plan record. */
  needsAssistantMaterialization(event: PlanMessage): boolean {
    if (!event.messageId) return false;
    return this.executionByThread.get(event.threadId)?.needsAssistantMaterialization() ?? false;
  }

  /** Retain the accepted assistant identity until native and fenced captures have settled. */
  observeAssistantMessage(event: PlanMessage): void {
    if (!event.messageId || !this.executionByThread.has(event.threadId)) return;
    this.executionByThread.get(event.threadId)?.observeAssistantMessage(event.content);
    this.assistantByThread.set(event.threadId, event);
  }

  /** Retain a durably materialized compatibility message for terminal plan persistence. */
  async persistAssistantMessage(event: PlanMessage): Promise<void> {
    this.observeAssistantMessage(event);
  }

  /** Wait for all native captures before choosing the turn's one plan version. */
  async finishTurn(threadId: string): Promise<void> {
    const execution = this.executionByThread.get(threadId);
    const event = this.assistantByThread.get(threadId);
    if (!execution || !event?.messageId) return;
    const ready = execution.consumeAssistantMessage(event.content);
    if (!ready) return;
    await this.acceptedProgress?.beforeDurableCommand(threadId);
    try {
      await this.persistPlan(threadId, event.messageId, ready, execution);
    } finally {
      this.acceptedProgress?.cancelDurableCommand(threadId);
    }
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
    const payload = this.questions.buildAnswerPayload(threadId, answers);
    this.beginOutputGeneration(threadId);
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
    const assistantMessageId = await this.questions.dismiss(threadId);
    if (assistantMessageId) broadcast("plan.dismissed", { threadId, assistantMessageId });
  }

  /** Clear volatile plan state once a turn reaches its terminal lifecycle. */
  clearTurn(threadId: string): void {
    const outcome = this.executionByThread.get(threadId)?.outcome();
    if (outcome?.outcome === "missing") logger.warn("Plan capture missing", { threadId, ...outcome });
    this.executionByThread.delete(threadId);
    this.assistantByThread.delete(threadId);
  }

  private armNativeOutputMode(threadId: string): void {
    const providerId = this.threadRepo.findById(threadId)?.provider as ProviderId | undefined;
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
    const plan = await this.planRepo.create(threadId, messageId, ready.title, ready.contentMd, ready.sectionsJson, ready.changeSummary);
    execution.markPlanPersisted();
    this.acceptedProgress?.recordSavedPlan(plan);
    broadcast("plan.generated", { threadId, plan });
  }

  private execution(threadId: string): PlanExecutionState {
    const state = this.executionByThread.get(threadId) ?? new PlanExecutionState();
    this.executionByThread.set(threadId, state);
    return state;
  }
}
