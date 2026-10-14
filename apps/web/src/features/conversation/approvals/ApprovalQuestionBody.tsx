import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert } from "lucide-react";
import { MAX_APPROVAL_ANSWER_LENGTH, type ApprovalAnswers, type ApprovalQuestion } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApprovalStore, type StoredApproval } from "@/stores/approvalStore";
import { approvalActorName } from "./approval-copy";
import { choiceRowClass, KeyChip, ROW_CLASS } from "./ApprovalChoiceRow";
import { ApprovalPager } from "./ApprovalPager";
import { pageKeyDelta, questionKeyAction, type QuestionKeyAction } from "./question-keys";
import { submitApprovalChoice } from "./submit-approval-choice";

/** Answer for one question: the picked labels, plus the typed answer when the provider allows one. */
function answerFor(question: ApprovalQuestion, selected: readonly string[], custom: string): string[] {
  const typed = custom.trim();
  if (!typed) return [...selected];
  return question.multiple ? [...selected, typed] : [typed];
}

function QuestionPager({ index, count, page }: { readonly index: number; readonly count: number; readonly page: (delta: number) => void }) {
  if (count < 2) return null;
  return <ApprovalPager index={index} count={count} noun="question" onPrevious={() => page(-1)} onNext={() => page(1)} />;
}

/** Props for {@link ApprovalQuestionBody}. */
export interface ApprovalQuestionBodyProps {
  readonly request: StoredApproval;
  readonly questions: readonly ApprovalQuestion[];
  /** Whether the dock's misclick guard has elapsed. */
  readonly isArmed: () => boolean;
  /** Extends the guard; called when the user types. */
  readonly arm: () => void;
}

/**
 * The provider's own question tool, answered inside the approval dock: one question at a
 * time, single or multiple choice, and a typed answer when the provider allows one.
 * Escape declines the request.
 */
export function ApprovalQuestionBody({ request, questions, isArmed, arm }: ApprovalQuestionBodyProps) {
  const [index, setIndex] = useState(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const submission = useApprovalStore((state) => state.submissions[request.requestId]);
  const submitting = submission?.state === "submitting";
  const question = questions[index]!;
  const isLast = index === questions.length - 1;
  const answers = questions.map((item, row) => answerFor(item, selected[row] ?? [], custom[row] ?? ""));
  const canAdvance = answers[index]!.length > 0 && !submitting;

  // Next disables itself until the new question is answered, which would drop focus and silence the number keys.
  useEffect(() => {
    if (index > 0) groupRef.current?.querySelector("button")?.focus();
  }, [index]);

  const respond = (intent: "allow_once" | "deny", payload?: ApprovalAnswers) => {
    const choice = request.choices.find((item) => item.intent === intent);
    if (choice) void submitApprovalChoice(request, choice.id, payload);
  };
  const submit = () => respond("allow_once", answers);

  const advance = () => {
    if (!isArmed() || !canAdvance) return;
    if (isLast) submit();
    else setIndex(index + 1);
  };

  const page = (delta: number) => {
    const target = index + delta;
    if (target >= 0 && target < questions.length) setIndex(target);
  };

  const pick = (label: string) => {
    setSelected((current) => current.map((picked, row) => {
      if (row !== index) return picked;
      if (!question.multiple) return [label];
      return picked.includes(label) ? picked.filter((item) => item !== label) : [...picked, label];
    }));
    if (!question.multiple) setCustom((current) => current.map((typed, row) => (row === index ? "" : typed)));
  };

  const runKey: Record<Exclude<QuestionKeyAction["kind"], "move">, (value: number) => void> = {
    escape: () => { if (isArmed()) respond("deny"); },
    enter: advance,
    // Focus follows the pick so a following Enter acts on the chosen row, not the one that had focus.
    digit: (row) => {
      const option = question.options[row];
      if (!isArmed()) arm();
      else if (option) {
        pick(option.label);
        groupRef.current?.querySelectorAll("button")[row]?.focus();
      } else if (question.custom && row === question.options.length) inputRef.current?.focus();
    },
    arm,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLInputElement;
    const pageDelta = pageKeyDelta(event, typing);
    if (pageDelta) {
      event.preventDefault();
      page(pageDelta);
      return;
    }
    const action = questionKeyAction(event, typing);
    // Enter outside the input stays native so it clicks the focused button.
    if (!action || action.kind === "move" || (action.kind === "enter" && !typing)) return;
    if (action.kind !== "arm") event.preventDefault();
    runKey[action.kind](action.value);
  };

  const picked = selected[index] ?? [];
  return (
    <div className="flex flex-col gap-3" onKeyDown={handleKeyDown}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-body font-medium text-ink">{question.question}</p>
        <QuestionPager index={index} count={questions.length} page={page} />
      </div>
      <div ref={groupRef} role="group" aria-label={question.question} className="flex flex-col gap-0.5">
        {question.options.map((option, row) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={picked.includes(option.label)}
            className={choiceRowClass(picked.includes(option.label), false, false)}
            onClick={() => isArmed() && pick(option.label)}
          >
            <KeyChip index={row} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className={cn("text-sm text-ink", picked.includes(option.label) && "font-medium")}>{option.label}</span>
              {option.description && <span className="text-xs text-muted">{option.description}</span>}
            </span>
          </button>
        ))}
        {question.custom && (
          <div className={cn(ROW_CLASS, custom[index] && "bg-hover")}>
            <KeyChip index={question.options.length} />
            <input
              ref={inputRef}
              value={custom[index] ?? ""}
              aria-label="Your own answer"
              maxLength={MAX_APPROVAL_ANSWER_LENGTH}
              placeholder="Write your own answer…"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              onChange={(event) => setCustom((current) => current.map((typed, row) => (row === index ? event.target.value : typed)))}
            />
          </div>
        )}
      </div>
      {submission?.state === "failed" && (
        <div role="alert" className="flex items-center gap-2 text-sm">
          <CircleAlert size={14} strokeWidth={1.5} className="shrink-0 text-error" aria-hidden />
          <span className="min-w-0 text-error">Your answer didn&apos;t reach {approvalActorName(request)}.</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" shape="round" disabled={submitting} onClick={() => isArmed() && respond("deny")}>Skip</Button>
        <Button shape="round" disabled={!canAdvance} onClick={advance}>{isLast ? "Submit" : "Next"}</Button>
      </div>
    </div>
  );
}
