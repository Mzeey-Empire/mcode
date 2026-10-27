import type { PlanAnswer, PlanQuestion } from "@mcode/contracts/models/plan-questions";

/** Starting answers for a fresh batch: each question's recommended option, so Enter takes it. */
export function recommendedPlanAnswers(questions: readonly PlanQuestion[]): Map<string, PlanAnswer> {
  const answers = new Map<string, PlanAnswer>();
  for (const question of questions) {
    const recommended = question.options.find((option) => option.recommended);
    if (recommended) answers.set(question.id, { questionId: question.id, selectedOptionId: recommended.id, freeText: null });
  }
  return answers;
}
