import { useState } from "react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { ActionApprovalCard } from "@/features/projects/actions/ActionApprovalCard";
import { approveAndStartAction } from "@/features/projects/actions/approveAndStartAction";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useToastStore } from "@/stores/toastStore";
import { closeTerminalRecord, type CloseScope } from "./useTerminalClose";
import { useScopeTerminals } from "./terminalTabs";

/**
 * The approval card over the active terminal while its run waits for approval.
 * That terminal has no process, so the card replaces the xterm surface until Run.
 */
export function PendingActionApproval(scope: CloseScope) {
  const { threadId, scopeId } = scope;
  const { terminals, activeId } = useScopeTerminals(scopeId);
  const active = terminals.find((terminal) => terminal.id === activeId);
  const run = useProjectActionStore((state) =>
    threadId && active?.kind === "action" ? state.runsByThread[threadId]?.[active.actionId ?? ""] ?? null : null,
  );
  if (!active || !run || run.status !== "awaiting-approval" || run.terminalSessionId !== active.id || run.snapshot.script === null) {
    return null;
  }
  // Keyed by terminal so a request in flight for one pending tab never disables or annotates another's card.
  // A renewed approval keeps the terminal, so its "command changed" note survives the new run.
  return <PendingApprovalCard key={active.id} scope={scope} run={run} script={run.snapshot.script} ptyId={active.id} />;
}

interface PendingApprovalCardProps {
  readonly scope: CloseScope;
  readonly run: WorkspaceEnvironmentActionRun;
  readonly script: string;
  readonly ptyId: string;
}

function PendingApprovalCard({ scope, run, script, ptyId }: PendingApprovalCardProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await approveAndStartAction(run);
      if (started?.status === "awaiting-approval") setError("The command changed. Review the updated command before running it.");
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
    <div className="absolute inset-x-2 top-0 bottom-2 overflow-auto rounded-[10px] bg-page px-3.5 py-3">
      <ActionApprovalCard
        actionName={run.actionName}
        script={script}
        starting={starting}
        error={error}
        onRun={() => void start()}
        onCancel={() => void closeTerminalRecord(scope, ptyId, run.actionName)}
      />
    </div>
  );
}
