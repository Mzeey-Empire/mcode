import { Check } from "lucide-react";
import { PlanQuestionSchema } from "@mcode/contracts/models/plan-questions";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";

const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

interface AnsweredSummaryProps {
  /** Raw message content containing the plan-questions fence. */
  content: string;
  /** Assistant message that owns the fence; lets the receipt echo once when the answer just landed. */
  messageId?: string;
}

/** Number of valid questions in the fence, or 0 when the batch is malformed (all-or-nothing, like the dock). */
function countQuestions(content: string): number {
  const match = content.match(PLAN_QUESTIONS_RE);
  if (!match) return 0;
  try {
    const raw: unknown = JSON.parse(match[1]);
    if (!Array.isArray(raw)) return 0;
    return raw.every((item) => PlanQuestionSchema().safeParse(item).success) ? raw.length : 0;
  } catch {
    return 0;
  }
}

/** One-line receipt shown in place of a plan-question message once its questions are settled. */
export function AnsweredSummary({ content, messageId }: AnsweredSummaryProps) {
  const echo = useThreadStore((s) => (messageId ? s.recentlyAnsweredPlanMessageIds.has(messageId) : false));
  const count = countQuestions(content);
  if (count === 0) return null;
  return (
    <div
      data-role="answered-plan-questions"
      className={cn("flex h-7 items-center gap-2 rounded-sm px-2", echo && "animate-wizard-marker-echo")}
    >
      <Check size={14} className="shrink-0 text-success" aria-hidden />
      <span className="text-sm text-muted">Answered {count} {count === 1 ? "question" : "questions"}</span>
    </div>
  );
}
