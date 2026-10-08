/**
 * Plan-question wizard engine, extracted from {@link AgentService}.
 *
 * Resolves the latest plan-questions fence through accepted progress before
 * saved message history. Builds the answer payload and records dismissal
 * through the accepted owner or the repository when no accepted match exists.
 *
 * The service builds the answer payload; the facade performs the send and the
 * dismiss broadcast, keeping the send path single-owned.
 */

import { injectable, inject } from "tsyringe";
import { z } from "zod";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "./persistence/plan-question-answers-repo.js";
import { lazySchema, PLAN_ANSWER_MESSAGE_PREFIX, type Message } from "@mcode/contracts";

/** Matches a fenced `plan-questions` block and captures its JSON body. */
const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;
const questionContextSchema = lazySchema(() => z.object({
  id: z.string(), question: z.string(), options: z.unknown().optional(),
}));
const questionOptionContextSchema = lazySchema(() => z.object({
  id: z.string(), title: z.unknown().optional(),
}).transform((option) => ({ id: option.id, title: String(option.title ?? option.id) })));

/** Read accepted assistant bodies and admit ordered dismissal markers before their rows are saved. */
export interface AcceptedPlanQuestionProgress {
  latestAssistantMessage(threadId: string): Message | undefined;
  markPlanAnswered(threadId: string, messageId: string): boolean;
}

/** A user answer to a single plan question. */
export interface PlanAnswerInput {
  questionId: string;
  selectedOptionId: string | null;
  freeText: string | null;
}

/**
 * The payload the facade sends to resume planning after the user answers.
 * `content` is the full message body (human-readable answers + mcode-plan
 * instructions); `markPlanAnswerForMessageId` is the assistant message whose
 * fence is being answered, used to key the answered marker.
 */
export interface PlanAnswerPayload {
  content: string;
  markPlanAnswerForMessageId: string | undefined;
}

/** Plan-question wizard logic with accepted progress read-through and saved history fallback. */
@injectable()
export class PlanQuestionService {
  private acceptedProgress: AcceptedPlanQuestionProgress | undefined;

  constructor(
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(PlanQuestionAnswersRepo)
    private readonly planQuestionAnswersRepo: PlanQuestionAnswersRepo,
  ) {}

  /** Compose accepted read-through without making the wizard own execution progress or saving. */
  bindAcceptedProgress(progress: AcceptedPlanQuestionProgress): void {
    this.acceptedProgress = progress;
  }

  /**
   * Build the human-readable follow-up message for a set of answers and
   * identify the assistant message whose plan-questions fence they answer.
   * Question text and option titles come from the accepted or saved assistant
   * body so the message reads naturally instead of using opaque IDs.
   */
  buildAnswerPayload(threadId: string, answers: PlanAnswerInput[]): PlanAnswerPayload {
    const message = this.findLatestPlanQuestionsMessage(threadId);
    const questionContext = this.buildQuestionContext(message);

    const lines: string[] = [`${PLAN_ANSWER_MESSAGE_PREFIX}\n`];
    for (const a of answers) {
      const qCtx = questionContext.get(a.questionId);
      const label = qCtx?.question ?? a.questionId;
      if (a.freeText) {
        lines.push(`- **${label}**: ${a.freeText}`);
      } else if (a.selectedOptionId) {
        const optionTitle =
          qCtx?.options.find((o) => o.id === a.selectedOptionId)?.title ?? a.selectedOptionId;
        lines.push(`- **${label}**: ${optionTitle}`);
      } else {
        lines.push(`- **${label}**: (skipped)`);
      }
    }
    lines.push(this.buildPlanOutputInstructions());

    // Key the marker on the assistant message carrying the fence (not just on
    // the thread) so it survives restarts and mid-turn errors.
    const markPlanAnswerForMessageId = message?.id;

    return { content: lines.join("\n"), markPlanAnswerForMessageId };
  }

  /**
   * Prefer the accepted current assistant fence, then walk saved history
   * newest-first. Returns its stable message ID or null when no fence exists.
   */
  findLatestPlanQuestionsMessageId(threadId: string): string | null {
    return this.findLatestPlanQuestionsMessage(threadId)?.id ?? null;
  }

  private findLatestPlanQuestionsMessage(threadId: string): Message | undefined {
    const accepted = this.acceptedProgress?.latestAssistantMessage(threadId);
    if (accepted?.thread_id === threadId && accepted.role === "assistant" && PLAN_QUESTIONS_RE.test(accepted.content)) {
      return accepted;
    }
    const { messages } = this.messageRepo.listByThread(threadId, 50);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      if (PLAN_QUESTIONS_RE.test(msg.content)) return msg;
    }
    return undefined;
  }

  /**
   * Admit dismissal of the latest accepted fence before its message is saved,
   * or persist the marker for saved history. Returns the exact message ID for
   * the facade's dismissal broadcast. The progress owner and repository each
   * keep repeated dismissal idempotent; acceptance does not confirm saving.
   */
  async dismiss(threadId: string): Promise<string | null> {
    const assistantMessageId = this.findLatestPlanQuestionsMessageId(threadId);
    if (!assistantMessageId) return null;
    if (this.acceptedProgress?.markPlanAnswered(threadId, assistantMessageId)) return assistantMessageId;
    await this.planQuestionAnswersRepo.markAnswered(assistantMessageId, threadId);
    return assistantMessageId;
  }

  /** Instructions appended when the model should emit a structured mcode-plan block. */
  buildPlanOutputInstructions(): string {
    return `
Now generate the full implementation plan based on these decisions.

Write a 1-2 sentence summary in chat. Put the full plan only in a four-backtick mcode-plan fence, starting with a single H1 title. Ordinary triple-backtick code blocks may appear inside the plan. If the plan contains a fence of four or more backticks, make the outer mcode-plan fence longer than any inner fence.

\`\`\`\`mcode-plan
# Short plan title

## Implementation
Full implementation steps, verification, and relevant tradeoffs.
\`\`\`\`

Do not repeat the full plan outside the fence.`;
  }

  /**
   * Parse the selected accepted or saved plan-questions block to build
   * a lookup map of question ID to its text and option titles. Used to produce
   * human-readable answer summaries instead of opaque IDs.
   */
  private buildQuestionContext(
    message: Message | undefined,
  ): Map<string, { question: string; options: Array<{ id: string; title: string }> }> {
    const map = new Map<string, { question: string; options: Array<{ id: string; title: string }> }>();

    if (message) this.appendQuestionContext(map, message.content);
    return map;
  }

  private appendQuestionContext(
    context: Map<string, { question: string; options: Array<{ id: string; title: string }> }>,
    content: string,
  ): boolean {
    const match = PLAN_QUESTIONS_RE.exec(content);
    if (!match) return false;
    try {
      const raw: unknown = JSON.parse(match[1]);
      if (Array.isArray(raw)) this.appendQuestions(context, raw);
    } catch {
      // Opaque IDs remain valid when prior plan output is malformed.
    }
    return true;
  }

  private appendQuestions(
    context: Map<string, { question: string; options: Array<{ id: string; title: string }> }>,
    questions: unknown[],
  ): void {
    for (const value of questions) {
      const question = this.questionContext(value);
      if (question) context.set(question.id, question);
    }
  }

  private questionContext(value: unknown): {
    id: string;
    question: string;
    options: Array<{ id: string; title: string }>;
  } | undefined {
    const parsed = questionContextSchema().safeParse(value);
    if (!parsed.success) return undefined;
    return {
      id: parsed.data.id,
      question: parsed.data.question,
      options: this.questionOptions(parsed.data.options),
    };
  }

  private questionOptions(value: unknown): Array<{ id: string; title: string }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((option) => {
      const parsed = questionOptionContextSchema().safeParse(option);
      return parsed.success ? [parsed.data] : [];
    });
  }
}
