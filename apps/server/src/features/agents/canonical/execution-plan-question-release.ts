import type { PlanQuestion } from "@mcode/contracts";
import { PlanQuestionBatchSchema } from "@mcode/contracts";
import * as NodeUtil from "node:util";

import type {
  ExecutionPlanQuestionsReceipt, ExecutionSemanticOperation, ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";

const MAX_RELEASED_QUESTIONS = 8_192;

/** Publishes a parsed plan-question batch only from its committed writer receipt. */
export class ExecutionPlanQuestionRelease {
  private readonly released = new Set<string>();

  constructor(private readonly publish: (threadId: string, questions: readonly PlanQuestion[]) => void) {}

  /** Check question data before another publication channel releases the event. */
  validate(operation: ExecutionSemanticOperation, receipt: ExecutionWriteReceipt): ExecutionPlanQuestionsReceipt | null {
    if (receipt.kind !== "committed" || !receipt.planQuestions) return null;
    const batch = receipt.planQuestions;
    if (!matchesOperation(operation, receipt, batch) || !PlanQuestionBatchSchema().safeParse({
      threadId: batch.threadId, questions: batch.questions,
    }).success || !NodeUtil.isDeepStrictEqual(batch.questions, operation.mutation.kind === "live-event"
      ? operation.mutation.planQuestions : undefined)) {
      throw new Error("Plan-question publication receipt is invalid");
    }
    return batch;
  }

  /** Publish once per host lifetime after the writer acknowledges the event. */
  release(operation: ExecutionSemanticOperation, receipt: ExecutionWriteReceipt): void {
    const batch = this.validate(operation, receipt);
    if (!batch) return;
    const key = JSON.stringify([operation.execution.executionId, batch.publicationId]);
    if (this.released.has(key)) return;
    if (this.released.size >= MAX_RELEASED_QUESTIONS) throw new Error("Plan-question publication tracking is full");
    this.publish(batch.threadId, batch.questions);
    this.released.add(key);
  }
}

function matchesOperation(
  operation: ExecutionSemanticOperation,
  receipt: Extract<ExecutionWriteReceipt, { kind: "committed" }>,
  batch: ExecutionPlanQuestionsReceipt,
): boolean {
  return receipt.operationId === operation.operationId && operation.mutation.kind === "live-event"
    && Boolean(operation.mutation.planQuestions)
    && operation.livePublication?.[0]?.event.type === "textDelta"
    && batch.publicationId === `${operation.operationId}:plan-questions`
    && batch.threadId === operation.execution.threadId;
}
