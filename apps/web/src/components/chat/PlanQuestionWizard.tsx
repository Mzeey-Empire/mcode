import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { OptionTile } from "./plan-questions/OptionTile";
import { AcceptRecommended } from "./plan-questions/AcceptRecommended";
import { useWizardKeyboard } from "./plan-questions/useWizardKeyboard";
import { cn } from "@/lib/utils";
import type { PlanAnswer, PlanQuestion, PlanQuestionOption } from "@mcode/contracts";

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
 * Renders the inline plan-mode wizard inside the conversation surface
 * (between MessageList and Composer). The wizard inhabits the prose
 * flow rather than overlaying it — a single top hairline marks the
 * threshold, the body uses the same background as the conversation,
 * and selected state is signaled by the same `▸` chevron that prefixes
 * assistant turns. Submission is gated client-side on thread-running
 * state so the wizard can render mid-turn without risking overlapping
 * sends.
 */
const EMPTY_MAP = new Map<string, PlanAnswer>();

/** Format the step counter as two-digit mono ("01 of 05"). */
function formatStep(current: number, total: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(current)} of ${pad(total)}`;
}

export function PlanQuestionWizard({ threadId }: PlanQuestionWizardProps) {
  const questions = useThreadStore((s) => s.planQuestionsByThread[threadId] ?? null);
  const answersMap = useThreadStore((s) => s.planAnswersByThread[threadId] ?? EMPTY_MAP);
  const activeIndex = useThreadStore((s) => s.activeQuestionIndexByThread[threadId] ?? 0);
  const status = useThreadStore((s) => s.planQuestionsStatusByThread[threadId] ?? "idle");
  const isThreadRunning = useThreadStore((s) => s.runningThreadIds.has(threadId));
  const setPlanAnswer = useThreadStore((s) => s.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((s) => s.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((s) => s.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((s) => s.clearPlanQuestions);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slideDirection, setSlideDirection] = useState<"forward" | "back">("forward");
  const prevIndexRef = useRef(activeIndex);
  // Toggles the per-tile flash when the user accepts every recommended
  // option in one gesture. Reset shortly after so the keyframe can fire
  // again on a subsequent batch.
  const [flashing, setFlashing] = useState(false);
  // Pressing `?` reveals a transient keyboard legend. The legend
  // auto-hides on the next keystroke or after a short timeout, so it
  // never sticks around to compete with the question.
  const [legendOpen, setLegendOpen] = useState(false);

  const isActive = status === "pending";

  useEffect(() => {
    if (activeIndex > prevIndexRef.current) setSlideDirection("forward");
    else if (activeIndex < prevIndexRef.current) setSlideDirection("back");
    prevIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Hide the legend after 3s, or sooner on any other key. Mounted only
  // while `legendOpen` is true so we don't keep a listener around for
  // the common case where the legend has never been triggered.
  useEffect(() => {
    if (!legendOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "?") setLegendOpen(false);
    };
    const timer = window.setTimeout(() => setLegendOpen(false), 3000);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [legendOpen]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (isSubmitting || isThreadRunning) return;
    setIsSubmitting(true);
    try {
      await submitPlanAnswers(threadId);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, isThreadRunning, threadId, submitPlanAnswers]);

  const handleAcceptRecommended = useCallback(
    async (answers: PlanAnswer[]): Promise<void> => {
      if (isSubmitting || isThreadRunning) return;
      for (const a of answers) {
        setPlanAnswer(threadId, a.questionId, a);
      }
      // Trigger the per-tile flash before submitting. The flash runs
      // entirely in CSS (~400ms with stagger) and is non-blocking — we
      // kick off the submit immediately and let the animation play
      // through whichever transition state arrives first.
      setFlashing(true);
      window.setTimeout(() => setFlashing(false), 600);
      setIsSubmitting(true);
      try {
        await submitPlanAnswers(threadId);
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, isThreadRunning, threadId, setPlanAnswer, submitPlanAnswers],
  );

  // Hold the last-rendered question batch in local state so the wizard's
  // inner subtree stays mounted while AnimatedCollapsible animates its
  // height down on cancel/submit. Without this, the children unmount in
  // the same render that flips `open` to false and the close snaps shut
  // instead of collapsing smoothly. Cleared ~280ms later (matches the
  // collapse duration in AnimatedCollapsible).
  const [closingSnapshot, setClosingSnapshot] = useState<{
    questions: PlanQuestion[];
    activeIndex: number;
  } | null>(null);
  useEffect(() => {
    if (questions && questions.length > 0) {
      // Fresh data is live — drop any held closing snapshot so the body
      // tracks the current store.
      if (closingSnapshot) setClosingSnapshot(null);
      return;
    }
    // Store cleared (cancel/submit). Capture the previous render's data
    // by snapshotting on the next state transition; the previous block
    // already populated the snapshot via `questions` being live, so we
    // just need to delay the actual clear.
    if (!closingSnapshot) return;
    const t = window.setTimeout(() => setClosingSnapshot(null), 280);
    return () => window.clearTimeout(t);
  }, [questions, closingSnapshot]);
  // Keep the snapshot fresh while data is live so the next "go null"
  // transition always has the last-good batch to fall back on.
  useEffect(() => {
    if (questions && questions.length > 0) {
      setClosingSnapshot({ questions, activeIndex });
    }
  }, [questions, activeIndex]);

  const displayQuestions =
    questions && questions.length > 0
      ? questions
      : closingSnapshot?.questions ?? null;
  const displayActiveIndex =
    questions && questions.length > 0
      ? activeIndex
      : closingSnapshot?.activeIndex ?? 0;

  const q = displayQuestions?.[displayActiveIndex] ?? null;
  const answer = q ? answersMap.get(q.id) : undefined;
  const isLast = displayQuestions
    ? displayActiveIndex === displayQuestions.length - 1
    : false;
  // Memoize so the array identity is stable across renders that don't change
  // the underlying question. `handleSelectByIndex` closes over `allOptions`
  // and feeds `useWizardKeyboard`; without memoization the keyboard listener
  // re-registers on every unrelated zustand subscription update.
  const allOptions = useMemo<PlanQuestionOption[]>(
    () => (q ? [...q.options, OTHER_OPTION] : []),
    [q],
  );
  const selectedOptionId = answer?.selectedOptionId ?? null;
  const selectedIndex = useMemo(
    () =>
      selectedOptionId
        ? allOptions.findIndex((o) => o.id === selectedOptionId)
        : -1,
    [allOptions, selectedOptionId],
  );

  const handleSelectOption = useCallback(
    (optionId: string): void => {
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
    (index: number): void => {
      const opt = allOptions[index];
      if (opt) handleSelectOption(opt.id);
    },
    [allOptions, handleSelectOption],
  );

  const handleOtherText = useCallback(
    (text: string): void => {
      if (!q) return;
      setPlanAnswer(threadId, q.id, {
        questionId: q.id,
        selectedOptionId: OTHER_OPTION_ID,
        freeText: text || null,
      });
    },
    [q, threadId, setPlanAnswer],
  );

  const handleAdvance = useCallback((): void => {
    if (isSubmitting) return;
    if (isLast) {
      // Submit is independently gated on isThreadRunning inside
      // handleSubmit; calling it here while the model is still running
      // is a silent no-op rather than throwing.
      void handleSubmit();
    } else {
      setActiveQuestionIndex(threadId, activeIndex + 1);
    }
  }, [isSubmitting, isLast, handleSubmit, setActiveQuestionIndex, threadId, activeIndex]);

  const handlePrevious = useCallback((): void => {
    if (activeIndex > 0) setActiveQuestionIndex(threadId, activeIndex - 1);
  }, [activeIndex, setActiveQuestionIndex, threadId]);

  const handleDeselect = useCallback((): void => {
    if (!q) return;
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: null,
      freeText: null,
    });
  }, [q, threadId, setPlanAnswer]);

  const handleCancel = useCallback((): void => {
    clearPlanQuestions(threadId);
  }, [clearPlanQuestions, threadId]);

  // Capture `?` for the legend before useWizardKeyboard processes other
  // shortcuts. The legend is a passive overlay; it does not affect
  // selection or navigation state.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent): void => {
      // Ignore when typing into an input/textarea — `?` should reach the field.
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (inField) return;
      if (e.key === "?") {
        e.preventDefault();
        setLegendOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  // Gate on `!!q` as well as `isActive` — without it the global key
  // listener can still intercept Enter/Escape/arrows when the wizard
  // has no renderable question (e.g. questions array drained mid-state
  // but status not yet reconciled), mutating wizard state with no
  // visible UI to ground the action.
  useWizardKeyboard({
    enabled: isActive && !isSubmitting && q !== null,
    optionCount: allOptions.length,
    selectedIndex,
    hasSelection: selectedOptionId !== null,
    onSelectOption: handleSelectByIndex,
    onAdvance: handleAdvance,
    onPrevious: handlePrevious,
    onDeselect: handleDeselect,
    onCancel: handleCancel,
  });

  const submitDisabled = isSubmitting || isThreadRunning;

  return (
    <AnimatedCollapsible open={isActive}>
      {displayQuestions && q && (
        <div
          role="form"
          aria-label="Plan questions"
          data-direction={slideDirection}
          className="relative px-5 pt-4 pb-3"
        >
          {/* Top hairline draws outward on mount. transform-origin: center
              gives the symmetric "drawer" feel rather than the linear
              swipe of a left-anchored origin. */}
          <div
            aria-hidden="true"
            className="absolute left-0 right-0 top-0 h-px bg-border/50 animate-wizard-hairline"
          />

          {/* Mono header: step counter + category. Lives above the
              question so the question text itself can be the visual
              hero of the panel. */}
          <div className="animate-wizard-header flex items-baseline gap-2 mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/45">
            <span aria-hidden="true" className="text-muted-foreground/30">
              ›
            </span>
            <span className="tabular-nums">
              step {formatStep(displayActiveIndex + 1, displayQuestions.length)}
            </span>
            <span className="text-muted-foreground/25" aria-hidden="true">
              ·
            </span>
            <span>{q.category.toLowerCase()}</span>
          </div>

          {/* Question — the focal point. Animates in on advance/previous;
              the data-direction on the wrapper drives which keyframe runs. */}
          <p
            key={displayActiveIndex}
            className={cn(
              "text-[15px] font-medium text-foreground leading-snug mb-3 max-w-[68ch]",
              slideDirection === "forward"
                ? "animate-wizard-question-forward"
                : "animate-wizard-question-back",
            )}
          >
            {q.question}
          </p>

          {/* Option list — borderless, flows like a list within the prose. */}
          <div
            role="radiogroup"
            aria-label="Options"
            className="-mx-3 mb-3"
          >
            {q.options.map((option, i) => (
              <OptionTile
                key={option.id}
                option={option}
                selected={selectedOptionId === option.id}
                isRecommended={option.recommended}
                onSelect={handleSelectOption}
                index={i}
                flashing={flashing}
              />
            ))}
            <OptionTile
              option={OTHER_OPTION}
              selected={selectedOptionId === OTHER_OPTION_ID}
              onSelect={handleSelectOption}
              isOtherTile
              otherText={answer?.freeText ?? ""}
              onOtherTextChange={handleOtherText}
              index={q.options.length}
              flashing={false}
            />
          </div>

          {/* Secondary action: accept-all shortcut. Sits as a quiet
              text-link under the options, only visible when every
              question has a single recommended option. */}
          <div className="mb-3 px-0.5">
            <AcceptRecommended
              questions={displayQuestions}
              onAccept={handleAcceptRecommended}
              disabled={submitDisabled}
              testId="plan-accept-recommended"
            />
          </div>

          {/* Nav row — lowercase mono actions, no boxed buttons. The
              spacing carries the affordance instead of a button chrome. */}
          <div className="animate-wizard-nav flex items-center justify-between font-mono text-[11px] tracking-wide">
            <div className="flex items-center gap-4 text-muted-foreground/55">
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSubmitting}
                className="lowercase hover:text-muted-foreground transition-colors duration-150 ease-out disabled:opacity-40"
              >
                cancel
              </button>
              {displayActiveIndex > 0 && (
                <button
                  type="button"
                  onClick={handlePrevious}
                  disabled={isSubmitting}
                  className="lowercase hover:text-muted-foreground transition-colors duration-150 ease-out disabled:opacity-40"
                >
                  ← previous
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {isThreadRunning && !isSubmitting && (
                <span
                  className="lowercase text-muted-foreground/55"
                  aria-live="polite"
                >
                  model is still working…
                </span>
              )}
              <button
                type="button"
                onClick={handleAdvance}
                disabled={isLast ? submitDisabled : isSubmitting}
                className={cn(
                  "lowercase font-medium text-primary/85 hover:text-primary",
                  "transition-colors duration-150 ease-out",
                  "disabled:opacity-40 disabled:hover:text-primary/85",
                )}
              >
                {isSubmitting
                  ? "submitting…"
                  : isLast
                    ? "submit ↵"
                    : "next →"}
              </button>
            </div>
          </div>

          {/* Keyboard legend — discoverable via `?`, auto-hides. Sits
              absolutely so it never affects layout when closed. */}
          {legendOpen && (
            <div
              role="note"
              aria-label="Keyboard shortcuts"
              className={cn(
                "absolute right-5 bottom-12 z-10",
                "rounded-sm border border-border/40 bg-card/95 backdrop-blur-sm",
                "px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80",
                "shadow-sm animate-wizard-legend",
              )}
            >
              <div>
                <span className="text-foreground/80">1–5</span> select
              </div>
              <div>
                <span className="text-foreground/80">← →</span> navigate
              </div>
              <div>
                <span className="text-foreground/80">⏎</span> advance
              </div>
              <div>
                <span className="text-foreground/80">esc</span> cancel
              </div>
            </div>
          )}
        </div>
      )}
    </AnimatedCollapsible>
  );
}
