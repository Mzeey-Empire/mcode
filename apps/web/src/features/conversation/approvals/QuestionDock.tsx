import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CircleHelp } from "lucide-react";
import { getCatalogEntry, isNativePlanQuestionId, type PlanAnswer, type PlanQuestion, type ProviderId } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useThreadStore } from "@/stores/threadStore";
import { APPROVAL_ARM_DELAY_MS } from "./ApprovalDock";
import { choiceRowClass, KeyChip, ROW_CLASS } from "./ApprovalChoiceRow";
import { ApprovalPager } from "./ApprovalPager";
import { DockStopButton } from "./DockStopButton";
import { pageKeyDelta, questionKeyAction, type QuestionKeyAction } from "./question-keys";
import { useDockFocus } from "./use-dock-focus";

/** Answer id for the user-written row; the server reads `freeText` and ignores the id. */
export const OTHER_OPTION_ID = "__other__";

function isAnswered(answer: PlanAnswer | undefined): boolean {
  if (!answer?.selectedOptionId) return false;
  return answer.selectedOptionId !== OTHER_OPTION_ID || Boolean(answer.freeText?.trim());
}

function selectedRowOf(question: PlanQuestion, answer: PlanAnswer | undefined): number {
  if (answer?.selectedOptionId === OTHER_OPTION_ID) return question.options.length;
  return question.options.findIndex((option) => option.id === answer?.selectedOptionId);
}

/** Props for {@link QuestionDock}. */
export interface QuestionDockProps {
  readonly threadId: string;
  readonly providerId: ProviderId;
  /** The hidden composer; focus inside it counts as the user's attention being here. */
  readonly composerContainerRef: RefObject<HTMLElement | null>;
  readonly isAgentRunning: boolean;
  readonly isStopPending: boolean;
  readonly onStop: () => void;
  readonly onFocusComposer: () => void;
}

interface OptionRowsProps {
  readonly question: PlanQuestion;
  readonly selectedRow: number;
  readonly focusedRow: number;
  readonly freeText: string;
  readonly rowRefs: RefObject<(HTMLButtonElement | null)[]>;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onSelect: (row: number) => void;
  readonly onFreeText: (text: string) => void;
}

function OptionRows({ question, selectedRow, focusedRow, freeText, rowRefs, inputRef, onSelect, onFreeText }: OptionRowsProps) {
  const otherRow = question.options.length;
  return (
    <div role="group" aria-label={question.question} className="flex flex-col gap-0.5">
      {question.options.map((option, row) => (
        <button
          key={option.id}
          ref={(element) => { rowRefs.current[row] = element; }}
          type="button"
          tabIndex={row === focusedRow ? 0 : -1}
          aria-pressed={row === selectedRow}
          className={cn(choiceRowClass(row === focusedRow, false, false))}
          onClick={() => onSelect(row)}
          onFocus={() => onSelect(row)}
        >
          <KeyChip index={row} />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className={cn("text-sm text-ink", row === selectedRow && "font-medium")}>{option.title}</span>
            {option.recommended && <span className="text-xs text-muted">Recommended</span>}
          </span>
        </button>
      ))}
      {selectedRow === otherRow ? (
        <div className={cn(ROW_CLASS, "bg-hover")}>
          <KeyChip index={otherRow} />
          <input
            ref={inputRef}
            value={freeText}
            aria-label="Your own answer"
            placeholder="Write your own answer…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            onChange={(event) => onFreeText(event.target.value)}
          />
        </div>
      ) : (
        <button
          ref={(element) => { rowRefs.current[otherRow] = element; }}
          type="button"
          tabIndex={otherRow === focusedRow ? 0 : -1}
          className={choiceRowClass(otherRow === focusedRow, false, false)}
          onClick={() => onSelect(otherRow)}
          onFocus={() => onSelect(otherRow)}
        >
          <KeyChip index={otherRow} />
          <span className="min-w-0 flex-1 text-sm text-muted">Write your own answer…</span>
        </button>
      )}
    </div>
  );
}

interface QuestionPanelProps extends QuestionDockProps {
  readonly question: PlanQuestion;
  readonly questions: readonly PlanQuestion[];
  readonly answer: PlanAnswer | undefined;
  readonly activeIndex: number;
}

function QuestionPanel({ threadId, providerId, composerContainerRef, isAgentRunning, isStopPending, onStop, onFocusComposer, question, questions, answer, activeIndex }: QuestionPanelProps) {
  const setPlanAnswer = useThreadStore((state) => state.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((state) => state.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((state) => state.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((state) => state.clearPlanQuestions);

  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const guardUntilRef = useRef(0);
  const [focus, setFocus] = useState({ questionId: "", row: 0 });

  const selectedRow = selectedRowOf(question, answer);
  const focusedRow = focus.questionId === question.id ? focus.row : Math.max(selectedRow, 0);
  const isLast = activeIndex === questions.length - 1;
  // A native turn is paused on this very question, so it is running by design and Submit must stay live.
  const submitHeldByRun = isAgentRunning && !isNativePlanQuestionId(question.id);
  const canAdvance = isAnswered(answer) && !(isLast && submitHeldByRun);
  const arm = () => { guardUntilRef.current = Date.now() + APPROVAL_ARM_DELAY_MS; };

  const focusedRowRef = useRef(focusedRow);
  focusedRowRef.current = focusedRow;
  useEffect(arm, [question.id]);
  useDockFocus(rootRef, composerContainerRef, onFocusComposer, () => inputRef.current ?? rowRefs.current[focusedRowRef.current], question.id);

  const writeAnswer = (selectedOptionId: string, freeText: string | null) =>
    setPlanAnswer(threadId, question.id, { questionId: question.id, selectedOptionId, freeText });

  const select = (row: number) => {
    setFocus({ questionId: question.id, row });
    if (row === selectedRow) return;
    const option = question.options[row];
    writeAnswer(option?.id ?? OTHER_OPTION_ID, null);
    // The input only exists once the Other row is selected, so focus waits a frame.
    if (!option) requestAnimationFrame(() => inputRef.current?.focus());
  };

  const advance = () => {
    if (Date.now() < guardUntilRef.current || !canAdvance) return;
    if (isLast) void submitPlanAnswers(threadId);
    else setActiveQuestionIndex(threadId, activeIndex + 1);
  };

  const page = (delta: number) => {
    const target = activeIndex + delta;
    if (target >= 0 && target < questions.length) setActiveQuestionIndex(threadId, target);
  };

  const move = (delta: number) => {
    const target = Math.max(0, Math.min(question.options.length, focusedRow + delta));
    select(target);
    rowRefs.current[target]?.focus();
  };

  const runKey: Record<QuestionKeyAction["kind"], (value: number, inInput: boolean) => void> = {
    escape: () => clearPlanQuestions(threadId),
    enter: (_, inInput) => {
      if (!inInput && selectedRow !== focusedRow) select(focusedRow);
      advance();
    },
    move,
    digit: (row) => { if (row <= question.options.length) select(row); },
    arm,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inInput = event.target === inputRef.current;
    const pageDelta = pageKeyDelta(event, inInput);
    if (pageDelta) {
      event.preventDefault();
      page(pageDelta);
      return;
    }
    // Stop, the pager and Submit keep their native Enter; only the option rows and the input pick and advance.
    const onFooterControl = event.target instanceof HTMLButtonElement && !rowRefs.current.includes(event.target);
    if (event.key === "Enter" && onFooterControl) return;
    const action = questionKeyAction(event, inInput);
    if (!action) return;
    if (action.kind !== "arm") event.preventDefault();
    runKey[action.kind](action.value, inInput);
  };

  return (
    <div
      ref={rootRef}
      data-testid="question-dock"
      className="relative z-(--layer-sticky) flex w-full flex-col gap-3 rounded-composer border border-primary/45 bg-panel px-4 py-3.5"
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <CircleHelp size={14} className="shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 text-sm font-medium text-ink">{getCatalogEntry(providerId).name} has a question</h2>
        <span className="flex-1" />
        {questions.length > 1 && (
          <ApprovalPager
            index={activeIndex}
            count={questions.length}
            noun="question"
            onPrevious={() => page(-1)}
            onNext={() => page(1)}
          />
        )}
      </div>
      <p className="text-body font-medium text-ink">{question.question}</p>
      <OptionRows
        question={question}
        selectedRow={selectedRow}
        focusedRow={focusedRow}
        freeText={answer?.freeText ?? ""}
        rowRefs={rowRefs}
        inputRef={inputRef}
        onSelect={select}
        onFreeText={(text) => writeAnswer(OTHER_OPTION_ID, text || null)}
      />
      <div className="flex items-center justify-end gap-2">
        {isAgentRunning && <DockStopButton isStopPending={isStopPending} onStop={onStop} />}
        <Button shape="round" disabled={!canAdvance} onClick={advance}>{isLast ? "Submit" : "Next"}</Button>
      </div>
    </div>
  );
}

/**
 * The model's plan questions in place of the composer. The recommended option is
 * preselected, so Enter on the first row takes it. Digits pick a row, arrows move,
 * Enter picks and advances, and Escape dismisses the batch. Keys work only while focus
 * is in the dock, and the dock takes focus only from the composer or nowhere.
 */
export function QuestionDock(props: QuestionDockProps) {
  const questions = useThreadRecord(props.threadId, (record) => record.planQuestions) ?? [];
  const answers = useThreadRecord(props.threadId, (record) => record.planAnswers);
  const activeIndex = useThreadRecord(props.threadId, (record) => record.activeQuestionIndex);
  const question = questions[activeIndex];
  if (!question) return null;
  return <QuestionPanel {...props} question={question} questions={questions} answer={answers.get(question.id)} activeIndex={activeIndex} />;
}
