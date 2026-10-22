import type { AgentTurn, TaskState, ThreadStartup } from "@mcode/contracts";

/** Mutable lifecycle facts read for the latest delegated attempt. */
export interface TaskFacts {
  turn?: Pick<AgentTurn, "status"> | null;
  startup?: (Pick<ThreadStartup, "state" | "phase"> & { error?: { message: string } }) | null;
  approval?: string | null;
  summary?: string;
  error?: string;
  needsInput?: boolean;
  launching?: boolean;
}

/** Derive current task state without freezing resumable terminal outcomes. */
export function deriveTaskState(facts: TaskFacts): TaskState {
  if (facts.turn) return turnState(facts);
  const startup = startupState(facts.startup);
  if (startup) return startup;
  const approval = approvalState(facts.approval);
  if (approval) return approval;
  if (facts.launching) return { status: "working", phase: "preparing" };
  return { status: "finished", outcome: "failed", error: "not started; call delegate_task again with the same clientRequestId" };
}

function startupState(startup: TaskFacts["startup"]): TaskState | null {
  if (!startup) return null;
  if (startup.state === "blocked" && startup.phase === "setup") return { status: "waiting", reason: "setup_blocked" };
  if (startup.state === "failed" || startup.state === "interrupted") {
    return { status: "finished", outcome: "failed", ...(startup.error ? { error: startup.error.message.slice(0, 8_000) } : {}) };
  }
  if (startup.state === "cancelled") return { status: "finished", outcome: "cancelled" };
  if (startup.state !== "completed") return { status: "working", phase: "preparing" };
  return null;
}

function approvalState(approval: TaskFacts["approval"]): TaskState | null {
  switch (approval) {
    case "pending": return { status: "waiting", reason: "approval" };
    case "rejected":
    case "expired": return { status: "finished", outcome: "denied" };
    case "cancelled": return { status: "finished", outcome: "cancelled" };
    default: return null;
  }
}

function turnState(facts: TaskFacts): TaskState {
  switch (facts.turn?.status) {
    case "Completed":
      return { status: "finished", outcome: "completed", ...(facts.summary ? { summary: facts.summary.slice(0, 8_000) } : {}) };
    case "Errored":
      return { status: "finished", outcome: "failed", ...(facts.error ? { error: facts.error.slice(0, 8_000) } : {}) };
    case "Cancelled": return { status: "finished", outcome: "cancelled" };
    case "Interrupted": return { status: "finished", outcome: "interrupted" };
    default:
      return facts.needsInput ? { status: "waiting", reason: "needs_input" } : { status: "working", phase: "running" };
  }
}
