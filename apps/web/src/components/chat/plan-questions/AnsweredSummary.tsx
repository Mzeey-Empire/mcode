import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanQuestion } from "@mcode/contracts";

const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

interface AnsweredSummaryProps {
  /** Raw message content containing the plan-questions fence. */
  content: string;
}

/**
 * Read-only collapsed summary of plan questions shown in historical
 * threads where the questions were already answered (AC-1.28).
 */
export function AnsweredSummary({ content }: AnsweredSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  // Parse questions from the fenced block
  const match = content.match(PLAN_QUESTIONS_RE);
  if (!match) return null;

  let questions: PlanQuestion[];
  try {
    questions = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (!questions.length) return null;

  return (
    <div className="group/msg space-y-2" data-role="answered-plan-questions">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors cursor-pointer"
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <span className="font-mono text-[10px] uppercase tracking-widest">
          {questions.length} plan question{questions.length !== 1 ? "s" : ""} answered
        </span>
      </button>

      {expanded && (
        <div className="ml-4.5 space-y-2 animate-fade-up-in">
          {questions.map((q) => (
            <div key={q.id} className="text-xs">
              <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/30">
                {q.category}
              </span>
              <p className="text-muted-foreground/60 mt-0.5">{q.question}</p>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {q.options.map((o) => (
                  <span
                    key={o.id}
                    className={cn(
                      "inline-block text-[10px] px-1.5 py-0.5 rounded border",
                      o.recommended
                        ? "border-primary/20 text-primary/50 bg-primary/5"
                        : "border-border/30 text-muted-foreground/35",
                    )}
                  >
                    {o.title}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
