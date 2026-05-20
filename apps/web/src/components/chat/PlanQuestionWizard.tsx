import { useState, useEffect, useCallback, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { OptionTile } from "./plan-questions/OptionTile";
import { StepIndicator } from "./plan-questions/StepIndicator";
import { AcceptRecommended } from "./plan-questions/AcceptRecommended";
import { useWizardKeyboard } from "./plan-questions/useWizardKeyboard";
import { ArrowRight } from "lucide-react";
import type { PlanAnswer, PlanQuestionOption } from "@mcode/contracts";

/** Sentinel ID for the user-written "Other" option. */
export const OTHER_OPTION_ID = "__other__";

const OTHER_OPTION: PlanQuestionOption = {
  id: OTHER_OPTION_ID,
  title: "Other...",
  description: "",
  recommended: false,
};

interface PlanQuestionWizardProps {
  /** Thread ID this wizard is attached to. */
  threadId: string;
}

/**
 * Composer-takeover wizard: expands upward from the composer area when
 * plan questions arrive, collapses back when submitted or cancelled.
 * Renders inside ChatView between MessageList and Composer.
 */
const EMPTY_MAP = new Map<string, PlanAnswer>();

export function PlanQuestionWizard({ threadId }: PlanQuestionWizardProps) {
  const questions = useThreadStore((s) => s.planQuestionsByThread[threadId] ?? null);
  const answersMap = useThreadStore((s) => s.planAnswersByThread[threadId] ?? EMPTY_MAP);
  const activeIndex = useThreadStore((s) => s.activeQuestionIndexByThread[threadId] ?? 0);
  const status = useThreadStore((s) => s.planQuestionsStatusByThread[threadId] ?? "idle");
  const setPlanAnswer = useThreadStore((s) => s.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((s) => s.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((s) => s.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((s) => s.clearPlanQuestions);

  const [isSubmitting, setIsSubmitting] = useState(false);
  // Track slide direction for question transitions
  const [slideDirection, setSlideDirection] = useState<"right" | "left">("right");
  const prevIndexRef = useRef(activeIndex);

  const isActive = status === "pending";

  // Track slide direction based on index changes
  useEffect(() => {
    if (activeIndex > prevIndexRef.current) {
      setSlideDirection("right");
    } else if (activeIndex < prevIndexRef.current) {
      setSlideDirection("left");
    }
    prevIndexRef.current = activeIndex;
  }, [activeIndex]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await submitPlanAnswers(threadId);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, threadId, submitPlanAnswers]);

  const handleAcceptRecommended = useCallback(
    async (answers: PlanAnswer[]) => {
      if (isSubmitting) return;
      // Set each answer in the store, then submit (AC-1.13)
      for (const a of answers) {
        setPlanAnswer(threadId, a.questionId, a);
      }
      setIsSubmitting(true);
      try {
        await submitPlanAnswers(threadId);
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, threadId, setPlanAnswer, submitPlanAnswers],
  );

  // Current question state
  const q = questions?.[activeIndex] ?? null;
  const answer = q ? answersMap.get(q.id) : undefined;
  const isLast = questions ? activeIndex === questions.length - 1 : false;

  // Build the full options list (question options + "Other")
  const allOptions = q ? [...q.options, OTHER_OPTION] : [];
  const selectedOptionId = answer?.selectedOptionId ?? null;

  // Map selectedOptionId to an index in allOptions (for keyboard navigation)
  const selectedIndex = selectedOptionId
    ? allOptions.findIndex((o) => o.id === selectedOptionId)
    : -1;

  const handleSelectOption = useCallback(
    (optionId: string) => {
      if (!q) return;
      setPlanAnswer(threadId, q.id, {
        questionId: q.id,
        selectedOptionId: optionId,
        freeText: optionId === OTHER_OPTION_ID ? (answer?.freeText ?? null) : null,
      });
    },
    [q, threadId, answer?.freeText, setPlanAnswer],
  );

  const handleSelectByIndex = useCallback(
    (index: number) => {
      const opt = allOptions[index];
      if (opt) handleSelectOption(opt.id);
    },
    [allOptions, handleSelectOption],
  );

  const handleOtherText = useCallback(
    (text: string) => {
      if (!q) return;
      setPlanAnswer(threadId, q.id, {
        questionId: q.id,
        selectedOptionId: OTHER_OPTION_ID,
        freeText: text || null,
      });
    },
    [q, threadId, setPlanAnswer],
  );

  const handleAdvance = useCallback(() => {
    if (isSubmitting) return;
    if (isLast) {
      handleSubmit();
    } else {
      setActiveQuestionIndex(threadId, activeIndex + 1);
    }
  }, [isSubmitting, isLast, handleSubmit, setActiveQuestionIndex, threadId, activeIndex]);

  const handlePrevious = useCallback(() => {
    if (activeIndex > 0) {
      setActiveQuestionIndex(threadId, activeIndex - 1);
    }
  }, [activeIndex, setActiveQuestionIndex, threadId]);

  const handleDeselect = useCallback(() => {
    if (!q) return;
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: null,
      freeText: null,
    });
  }, [q, threadId, setPlanAnswer]);

  const handleCancel = useCallback(() => {
    clearPlanQuestions(threadId);
  }, [clearPlanQuestions, threadId]);

  // Keyboard navigation (AC-1.7 through AC-1.11)
  useWizardKeyboard({
    enabled: isActive && !isSubmitting,
    optionCount: allOptions.length,
    selectedIndex,
    hasSelection: selectedOptionId !== null,
    onSelectOption: handleSelectByIndex,
    onAdvance: handleAdvance,
    onPrevious: handlePrevious,
    onDeselect: handleDeselect,
    onCancel: handleCancel,
  });

  return (
    <AnimatedCollapsible open={isActive}>
      {isActive && questions && q && (
        <div
          role="form"
          aria-label="Plan questions"
          className="border-t border-border/60 bg-card px-4 py-3.5"
        >
          {/* Header: step counter + category + question text */}
          <div className="mb-3">
            <div className="flex items-center gap-1.5 mb-2">
              {questions.length > 1 && (
                <>
                  <span className="text-[11px] text-muted-foreground/40 tabular-nums font-mono">
                    {activeIndex + 1}/{questions.length}
                  </span>
                  <span className="text-muted-foreground/25" aria-hidden="true">
                    ·
                  </span>
                </>
              )}
              <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/35">
                {q.category}
              </span>
            </div>
            <p className="text-sm font-semibold text-foreground leading-snug">{q.question}</p>
          </div>

          {/* Option tiles (AC-1.20: slide animation on question change) */}
          <div
            key={activeIndex}
            className={
              slideDirection === "right"
                ? "animate-wizard-slide-in-right"
                : "animate-wizard-slide-in-left"
            }
          >
            <div
              role="radiogroup"
              aria-label="Options"
              className="flex flex-col mb-3 rounded-md border border-border/30 overflow-hidden"
            >
              {q.options.map((option) => (
                <OptionTile
                  key={option.id}
                  option={option}
                  selected={selectedOptionId === option.id}
                  isRecommended={option.recommended}
                  onSelect={handleSelectOption}
                />
              ))}
              <OptionTile
                option={OTHER_OPTION}
                selected={selectedOptionId === OTHER_OPTION_ID}
                onSelect={handleSelectOption}
                isOtherTile
                otherText={answer?.freeText ?? ""}
                onOtherTextChange={handleOtherText}
              />
            </div>
          </div>

          {/* Navigation bar */}
          <div className="flex items-center justify-between pt-1">
            {/* Left: secondary actions */}
            <div className="flex items-center gap-1">
              {activeIndex > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePrevious}
                  disabled={isSubmitting}
                  className="h-7 px-2 text-xs text-muted-foreground/50 hover:text-muted-foreground"
                >
                  Previous
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={isSubmitting}
                className="h-7 px-2 text-xs text-muted-foreground/50 hover:text-muted-foreground"
              >
                Cancel
              </Button>
              <AcceptRecommended
                questions={questions}
                onAccept={handleAcceptRecommended}
                disabled={isSubmitting}
              />
            </div>

            {/* Center: step indicator */}
            <StepIndicator current={activeIndex} total={questions.length} />

            {/* Right: primary action */}
            <Button
              size="sm"
              onClick={handleAdvance}
              disabled={isSubmitting}
              className="h-7 gap-1.5 px-3 text-xs"
            >
              {isSubmitting
                ? "Submitting..."
                : isLast
                  ? "Submit answers"
                  : "Next"}
              {!isSubmitting && !isLast && <ArrowRight className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      )}
    </AnimatedCollapsible>
  );
}
