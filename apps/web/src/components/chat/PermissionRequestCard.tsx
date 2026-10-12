import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Shield, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useApprovalStore, type StoredApproval } from "@/stores/approvalStore";
import type { ApprovalQuestion, ApprovalAnswers } from "@mcode/contracts";

function PendingQuestionRequest({
  requestId,
  icon,
  label,
  questions,
  responding,
  ready,
  error,
  onRespond,
}: {
  requestId: string;
  icon: ReactNode;
  label: string;
  questions: ApprovalQuestion[];
  responding: boolean;
  ready: boolean;
  error: string | null;
  onRespond: (decision: "allow" | "deny", answers?: ApprovalAnswers) => void;
}) {
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const controlsDisabled = responding || !ready;
  const answers = useMemo<ApprovalAnswers | undefined>(() => {
    const next = questions.map((question, index) => {
      const customAnswer = custom[index] ?? "";
      if (!customAnswer.trim()) return selected[index] ?? [];
      return question.multiple ? [...(selected[index] ?? []), customAnswer] : [customAnswer];
    });
    return next.every((answer) => answer.length > 0) ? next : undefined;
  }, [custom, questions, selected]);

  const selectOption = (questionIndex: number, option: string, multiple: boolean) => {
    setSelected((current) => current.map((answer, index) => {
      if (index !== questionIndex) return answer;
      if (!multiple) return [option];
      return answer.includes(option) ? answer.filter((item) => item !== option) : [...answer, option];
    }));
    if (!multiple) {
      setCustom((current) => current.map((answer, index) => (index === questionIndex ? "" : answer)));
    }
  };

  return (
    <div className="border-l-2 border-primary/60 pl-3 py-2 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-medium text-primary">
        {icon}
        <span>Answer required: {label}</span>
      </div>
      {questions.map((question, questionIndex) => (
        <fieldset key={`${question.header}-${questionIndex}`} className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium">{question.header}</legend>
          <p className="text-sm text-ink/90">{question.question}</p>
          {question.options.map((option) => {
            const checked = (selected[questionIndex] ?? []).includes(option.label);
            return (
              <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-hover/40">
                <input
                  type={question.multiple ? "checkbox" : "radio"}
                  name={`question-${requestId}-${questionIndex}`}
                  checked={checked}
                  disabled={controlsDisabled}
                  onChange={() => selectOption(questionIndex, option.label, question.multiple)}
                />
                <span>
                  {option.label}
                  {option.description && <span className="block text-xs text-muted">{option.description}</span>}
                </span>
              </label>
            );
          })}
          {question.custom && (
            <input
              aria-label={`Custom answer for ${question.header}`}
              disabled={controlsDisabled}
              value={custom[questionIndex] ?? ""}
              onChange={(event) => setCustom((current) => current.map((answer, index) => (
                index === questionIndex ? event.target.value : answer
              )))}
              placeholder="Your answer"
              className="h-7 rounded border bg-background px-2 text-sm"
            />
          )}
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <button
          disabled={controlsDisabled || !answers}
          onClick={() => answers && onRespond("allow", answers)}
          className={cn("inline-flex h-6 items-center gap-1 px-2 text-xs font-medium rounded-md", "bg-primary text-primary-ink hover:bg-primary/90 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}
        >
          <Check size={11} />
          Submit answers
        </button>
        <button disabled={controlsDisabled} onClick={() => onRespond("deny")} className={cn("inline-flex h-6 items-center gap-1 px-2 text-xs font-medium rounded-md", "text-muted/70 hover:text-destructive", "hover:bg-destructive/10 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}>
          <X size={11} />
          Deny
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}


/** Inline card for a pending question; approvals render in the composer's approval dock instead. */
export function PermissionRequestCard({ request }: { request: StoredApproval }) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(timer);
  }, []);

  if (request.subject.kind !== "question") return null;

  const respond = async (choiceId: string, answers?: ApprovalAnswers) => {
    setResponding(true);
    setError(null);
    try {
      const result = await getTransport().respondToApproval(request.requestId, { choiceId, ...(answers ? { answers } : {}) });
      if (result.status === "failed") setError("Failed to send response. Please try again.");
      else if (result.status === "not_pending") useApprovalStore.getState().remove(request.requestId);
    } catch {
      setError("Failed to send response. Please try again.");
    } finally {
      setResponding(false);
    }
  };
  const label = request.reason ?? "question";
  return <PendingQuestionRequest requestId={request.requestId} icon={<Shield size={13} className="shrink-0" />} label={label}
    questions={request.subject.questions} responding={responding} ready={ready} error={error}
    onRespond={(decision, answers) => {
      const choice = request.choices.find((item) => decision === "deny" ? item.intent === "deny" : item.intent === "allow_once");
      if (choice) void respond(choice.id, answers);
    }} />;
}
