import { Network } from "lucide-react";
import { ComposerCapabilityChip } from "@/components/chat/ComposerCapabilityChip";
import { ActiveGoalChip } from "../ActiveGoalChip";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { ResolvedComposerCapability } from "../composer-capabilities";
import { ORCHESTRATION_MODES } from "@mcode/contracts/models/enums";
import { type GoalState } from "@mcode/contracts/models/goal";

/** Props for Composer's attached capability controls. */
export interface ComposerAttachedCapabilitiesProps {
  threadId?: string;
  isNewThread: boolean;
  selection: ComposerAgentSelection;
  capabilities: ResolvedComposerCapability[];
  activeGoal: GoalState | null | undefined;
  onDetachOrchestration(): void;
}

function ComposerOrchestrationCapability({
  selection,
  capability,
  onDetach,
}: {
  selection: ComposerAgentSelection;
  capability: ResolvedComposerCapability | undefined;
  onDetach(): void;
}) {
  if (selection.orchestrationMode !== ORCHESTRATION_MODES.PROACTIVE || !capability) return null;
  return (
    <ComposerCapabilityChip
      label={capability.label}
      icon={Network}
      turnOffLabel={`Turn off ${capability.label}`}
      onTurnOff={onDetach}
      testId="composer-capability-orchestration"
    />
  );
}

function ComposerActiveGoalCapability({
  threadId,
  isNewThread,
  activeGoal,
}: Pick<ComposerAttachedCapabilitiesProps, "threadId" | "isNewThread" | "activeGoal">) {
  if (!threadId || isNewThread || !activeGoal) return null;
  return <ActiveGoalChip threadId={threadId} goal={activeGoal} />;
}

/** Renders orchestration and an open goal; Plan and a pending Goal sit beside `+` as modes. */
export function ComposerAttachedCapabilities({
  threadId,
  isNewThread,
  selection,
  capabilities,
  activeGoal,
  onDetachOrchestration,
}: ComposerAttachedCapabilitiesProps) {
  const orchestrationCapability = capabilities.find((capability) => capability.id === "orchestration");

  return (
    <>
      <ComposerOrchestrationCapability
        selection={selection}
        capability={orchestrationCapability}
        onDetach={onDetachOrchestration}
      />
      <ComposerActiveGoalCapability threadId={threadId} isNewThread={isNewThread} activeGoal={activeGoal} />
    </>
  );
}
