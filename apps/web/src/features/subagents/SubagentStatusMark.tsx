import { CirclePause, Layers } from "lucide-react";
import type { SubagentStatus } from "@mcode/contracts/models/subagent-roster";
import { StatusMark } from "@/components/ui/status-mark";
import { THREAD_STATUS_LOOK, type ThreadStatusLook } from "@/features/thread-attention/thread-row-presentation";
import { subagentStatusLabel } from "./subagent-status";

/** Each subagent status borrows its thread state's look, so a subagent and a thread row draw the same icon. */
const LOOK: Record<Exclude<SubagentStatus, "stopped">, Pick<ThreadStatusLook, "state" | "icon">> = {
  "needs-you": { state: "attention", icon: Layers },
  "setting-up": THREAD_STATUS_LOOK.Running,
  running: THREAD_STATUS_LOOK.Running,
  failed: THREAD_STATUS_LOOK.Failed,
  finished: THREAD_STATUS_LOOK.Finished,
};

/** A subagent's status icon. Its row or header says the status in words, so the icon is hidden from assistive tech. */
export function SubagentStatusMark({ status }: { readonly status: SubagentStatus }) {
  // A stopped subagent is settled and needs nothing, so it takes Interrupted's icon without Interrupted's attention colour.
  if (status === "stopped") {
    return (
      <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center">
        <CirclePause size={14} className="text-muted" />
      </span>
    );
  }
  const look = LOOK[status];
  return (
    <span aria-hidden className="inline-flex shrink-0">
      <StatusMark state={look.state} label={subagentStatusLabel(status)} icon={look.icon} />
    </span>
  );
}
