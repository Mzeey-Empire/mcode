import { ChevronRight } from "lucide-react";
import { delegatedTaskRosterEntryId } from "@mcode/contracts/models/subagent-roster";
import { type DelegatedTaskNotice, type DelegatedTaskNoticeStatus } from "@mcode/contracts/models/message";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { openSubagentDetail } from "@/features/subagents/detail/open-subagent-detail";

const STATUS_WORDS: Record<DelegatedTaskNoticeStatus, string> = {
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  denied: "denied",
  needs_input: "needs your answer",
  setup_blocked: "setup blocked",
};

/** Props for {@link DelegatedTaskWakeUp}. */
export interface DelegatedTaskWakeUpProps {
  readonly tasks: readonly DelegatedTaskNotice[];
  /** The prompt the Coordinator received, kept behind a disclosure. */
  readonly prompt: string;
}

/**
 * A Coordinator wake-up the server sent on a Delegated thread's behalf. It is not
 * the user's words, so it renders as one row per task instead of a user bubble.
 */
export function DelegatedTaskWakeUp({ tasks, prompt }: DelegatedTaskWakeUpProps) {
  return (
    <div className="flex flex-col items-start gap-1 py-1" role="note" data-testid="delegated-task-wake-up">
      {tasks.map((task) => (
        <div key={task.taskId} className="flex min-w-0 items-center gap-2 text-xs">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => openSubagentDetail(delegatedTaskRosterEntryId(task.taskId))}
            aria-label={`Open ${task.title} subagent details`}
            className="h-7 min-w-0 shrink justify-start rounded-full border-border px-2.5 text-xs"
          >
            <span className="text-muted">From</span>{" "}
            <span className="min-w-0 text-fade font-medium text-ink">{task.title}</span>
          </Button>
          <span className={task.status === "failed" ? "text-error" : "text-muted"}>{STATUS_WORDS[task.status]}</span>
        </div>
      ))}
      <Collapsible>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 px-2.5 text-xs text-muted hover:text-ink">
          <ChevronRight size={12} aria-hidden className="transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          Prompt
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 max-w-full whitespace-pre-wrap px-2.5 font-mono text-xs text-muted">{prompt}</pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
