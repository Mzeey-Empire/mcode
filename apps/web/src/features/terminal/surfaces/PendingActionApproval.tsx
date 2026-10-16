import { useState } from "react";
import { ActionApprovalCard } from "@/features/projects/actions/ActionApprovalCard";
import { approveAndStartAction } from "@/features/projects/actions/approveAndStartAction";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useToastStore } from "@/stores/toastStore";
import { closeTerminalRecord } from "./useTerminalClose";
import { useScopeTerminals } from "./terminalTabs";

interface PendingActionApprovalProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly scopeId: string;
}

/**
 * The approval card over the active terminal while its run waits for approval.
 * That terminal has no process, so the card replaces the xterm surface until Run.
 */
export function PendingActionApproval({ workspaceId, threadId, scopeId }: PendingActionApprovalProps) {
  const { terminals, activeId } = useScopeTerminals(scopeId);
  const active = terminals.find((terminal) => terminal.id === activeId);
  const run = useProjectActionStore((state) =>
    threadId && active?.kind === "action" ? state.runsByThread[threadId]?.[active.actionId ?? ""] ?? null : null,
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!active || !run || run.status !== "awaiting-approval" || run.terminalSessionId !== active.id || run.snapshot.script === null) {
    return null;
  }

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await approveAndStartAction(run);
      if (started.status === "awaiting-approval") setError("The command changed. Review the updated command before running it.");
    } catch (failure) {
      useToastStore.getState().show({
        kind: "failed",
        title: `Couldn't run ${run.actionName}. Try again.`,
        meta: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="absolute inset-0 overflow-auto bg-page px-3.5 py-3">
      <ActionApprovalCard
        actionName={run.actionName}
        script={run.snapshot.script}
        starting={starting}
        error={error}
        onRun={() => void start()}
        onCancel={() => void closeTerminalRecord({ workspaceId, threadId, scopeId }, active.id, run.actionName)}
      />
    </div>
  );
}
