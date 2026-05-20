import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";
import type { PlanQuestion, PlanAnswer } from "@mcode/contracts";

interface AcceptRecommendedProps {
  /** The full batch of questions. */
  questions: PlanQuestion[];
  /** Called with answers for every question, each set to its recommended option. */
  onAccept: (answers: PlanAnswer[]) => void;
  /** Disables the button during submission. */
  disabled?: boolean;
}

/**
 * Visible when every question has exactly one option with `recommended: true`.
 * Clicking submits all recommended options at once (AC-1.12, AC-1.13).
 */
export function AcceptRecommended({ questions, onAccept, disabled }: AcceptRecommendedProps) {
  // Check: every question must have exactly one recommended option
  const allHaveRecommended = questions.every(
    (q) => q.options.filter((o) => o.recommended).length === 1,
  );

  if (!allHaveRecommended) return null;

  const handleClick = () => {
    const answers: PlanAnswer[] = questions.map((q) => ({
      questionId: q.id,
      selectedOptionId: q.options.find((o) => o.recommended)!.id,
      freeText: null,
    }));
    onAccept(answers);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={disabled}
      className="h-7 gap-1.5 px-2.5 text-xs text-primary/70 hover:text-primary hover:bg-primary/8"
    >
      <Zap className="w-3 h-3" />
      Accept recommended
    </Button>
  );
}
