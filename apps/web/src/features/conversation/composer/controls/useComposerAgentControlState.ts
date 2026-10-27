import { useCallback, useEffect, useMemo } from "react";
import { PERMISSION_MODES } from "@/transport";
import { isWindows } from "@/lib/platform";
import { isCursorPermissionLockedToFull } from "@/lib/cursor-permission";
import {
  getReasoningLevels,
} from "@/lib/model-registry";
import { useThreadStore } from "@/stores/threadStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useToastStore } from "@/stores/toastStore";
import { INTERACTION_MODES, ORCHESTRATION_MODES } from "@mcode/contracts/models/enums";
import { isGoalOpen, type GoalState } from "@mcode/contracts/models/goal";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";
import { type ReasoningLevel } from "@mcode/contracts/models/settings";
import {
  resolveComposerCapabilities,
  supportsApprovalReview,
  type ComposerCapabilityId,
} from "../composer-capabilities";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";

/** Inputs for Composer capability policy and control-state synchronization. */
export interface UseComposerAgentControlStateOptions {
  threadId?: string;
  provider: ProviderId;
  modelId: string;
  permissionMode: ComposerAgentSelection["permissionMode"];
  interactionMode: ComposerAgentSelection["interactionMode"];
  orchestrationMode: ComposerAgentSelection["orchestrationMode"];
  goalPending: boolean;
  activeGoal: GoalState | null | undefined;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
  onGoalPendingChange(pending: boolean): void;
  onSelectionTouched(): void;
  focusEditor(): void;
}

/** Capability state and actions needed by Composer's add menu and control chips. */
export interface ComposerAgentControlState {
  capabilities: ReturnType<typeof resolveComposerCapabilities>;
  attachedCapabilityIds: ReadonlySet<ComposerCapabilityId>;
  reasoningLevels: ReasoningLevel[];
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  /** Toggles Plan, and attaches Goal or orchestration. */
  attachCapability(capabilityId: ComposerCapabilityId): void;
  /** Turns Plan on and never off, for the inline `/plan ` conversion. */
  enablePlan(): void;
  detachPlan(): void;
  detachGoal(): void;
  detachOrchestration(): void;
}

/** Owns Composer agent-control policy, including persisted control changes. */
export function useComposerAgentControlState({
  threadId,
  provider,
  modelId,
  permissionMode,
  interactionMode,
  orchestrationMode,
  goalPending,
  activeGoal,
  onSelectionChange,
  onGoalPendingChange,
  onSelectionTouched,
  focusEditor,
}: UseComposerAgentControlStateOptions): ComposerAgentControlState {
  const capabilities = useMemo(
    () => resolveComposerCapabilities({ providerId: provider, modelId }),
    [modelId, provider],
  );
  const planCapability = capabilities.find((capability) => capability.id === "plan");
  const goalCapability = capabilities.find((capability) => capability.id === "goal");
  const orchestrationCapability = capabilities.find(
    (capability) => capability.id === "orchestration",
  );
  const permissionLocked = isCursorPermissionLockedToFull(provider, isWindows);
  const approvalReviewSupported = useProviderAvailabilityStore((state) =>
    supportsApprovalReview(state.getAvailability(provider)?.capabilities ?? []),
  );
  const attachedCapabilityIds = useMemo(() => {
    const ids = new Set<ComposerCapabilityId>();
    if (interactionMode === INTERACTION_MODES.PLAN) ids.add("plan");
    if (goalPending || isGoalOpen(activeGoal)) ids.add("goal");
    if (orchestrationMode === ORCHESTRATION_MODES.PROACTIVE) ids.add("orchestration");
    return ids;
  }, [activeGoal, goalPending, interactionMode, orchestrationMode]);
  const reasoningLevels = useMemo<ReasoningLevel[]>(
    () => getReasoningLevels(provider, modelId),
    [modelId, provider],
  );

  const detachPlan = useCallback(() => {
    onSelectionChange({ interactionMode: INTERACTION_MODES.BUILD });
    onSelectionTouched();
    if (threadId) {
      void useThreadStore.getState().setThreadSettings(threadId, {
        interactionMode: INTERACTION_MODES.BUILD,
      });
    }
    focusEditor();
  }, [focusEditor, onSelectionChange, onSelectionTouched, threadId]);
  const detachGoal = useCallback(() => {
    onGoalPendingChange(false);
    focusEditor();
  }, [focusEditor, onGoalPendingChange]);
  const detachOrchestration = useCallback(() => {
    onSelectionChange({ orchestrationMode: ORCHESTRATION_MODES.STANDARD });
    if (threadId) {
      void useThreadStore.getState().setThreadSettings(threadId, {
        orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      });
    }
    focusEditor();
  }, [focusEditor, onSelectionChange, threadId]);
  const attachPlan = useCallback(() => {
    onSelectionChange({ interactionMode: INTERACTION_MODES.PLAN });
    onSelectionTouched();
    if (threadId) {
      void useThreadStore.getState().setThreadSettings(threadId, {
        interactionMode: INTERACTION_MODES.PLAN,
      });
    }
    focusEditor();
  }, [focusEditor, onSelectionChange, onSelectionTouched, threadId]);
  const enablePlan = useCallback(() => {
    if (interactionMode !== INTERACTION_MODES.PLAN) attachPlan();
  }, [attachPlan, interactionMode]);
  const attachGoal = useCallback(() => {
    if (!goalCapability || isGoalOpen(activeGoal)) return;
    onGoalPendingChange(true);
    focusEditor();
  }, [activeGoal, focusEditor, goalCapability, onGoalPendingChange]);
  const attachOrchestration = useCallback(() => {
    if (!orchestrationCapability) return;
    onSelectionChange({ orchestrationMode: ORCHESTRATION_MODES.PROACTIVE });
    if (threadId) {
      void useThreadStore.getState().setThreadSettings(threadId, {
        orchestrationMode: ORCHESTRATION_MODES.PROACTIVE,
      });
    }
    focusEditor();
  }, [focusEditor, onSelectionChange, orchestrationCapability, threadId]);
  const attachCapability = useCallback((capabilityId: ComposerCapabilityId) => {
    if (capabilityId === "plan") {
      if (interactionMode === INTERACTION_MODES.PLAN) detachPlan();
      else attachPlan();
    } else if (capabilityId === "goal") {
      attachGoal();
    } else {
      attachOrchestration();
    }
  }, [attachGoal, attachOrchestration, attachPlan, detachPlan, interactionMode]);

  useEffect(() => {
    if (!permissionLocked || permissionMode === PERMISSION_MODES.FULL) return;
    onSelectionChange({ permissionMode: PERMISSION_MODES.FULL });
    onSelectionTouched();
    if (threadId) {
      void useThreadStore.getState().setThreadSettings(threadId, {
        permissionMode: PERMISSION_MODES.FULL,
      });
    }
  }, [onSelectionChange, onSelectionTouched, permissionLocked, permissionMode, threadId]);
  useEffect(() => {
    if (interactionMode !== INTERACTION_MODES.PLAN || planCapability) return;
    detachPlan();
    useToastStore.getState().show({
      kind: "info",
      title: "Plan removed",
      meta: "The selected provider does not support Plan.",
    });
  }, [detachPlan, interactionMode, planCapability]);
  useEffect(() => {
    if (!goalPending || goalCapability) return;
    onGoalPendingChange(false);
    useToastStore.getState().show({
      kind: "info",
      title: "Goal removed",
      meta: "The selected provider does not support this capability.",
    });
  }, [goalCapability, goalPending, onGoalPendingChange]);
  useEffect(() => {
    if (orchestrationMode !== ORCHESTRATION_MODES.PROACTIVE || orchestrationCapability) return;
    detachOrchestration();
    useToastStore.getState().show({
      kind: "info",
      title: "Orchestration removed",
      meta: "The selected provider or model does not support this capability.",
    });
  }, [detachOrchestration, orchestrationCapability, orchestrationMode]);

  return {
    capabilities,
    attachedCapabilityIds,
    reasoningLevels,
    permissionLocked,
    approvalReviewSupported,
    attachCapability,
    enablePlan,
    detachPlan,
    detachGoal,
    detachOrchestration,
  };
}
