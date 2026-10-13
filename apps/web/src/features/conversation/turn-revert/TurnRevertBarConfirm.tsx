import { useMemo } from "react";
import type { TurnSnapshot } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { RevertConfirm } from "./RevertConfirm";
import { turnRevertTitle } from "./revert-copy";
import { useTurnRevert } from "./useTurnRevert";

/** What the menu knows about a turn before asking the server. */
export interface RevertTurnFacts {
  readonly snapshot: TurnSnapshot | undefined;
  /** The snapshot list has loaded, so a missing snapshot is gone rather than pending. */
  readonly listSettled: boolean;
  /** Every listed file of the turn is already back at its pre-turn state. */
  readonly allReverted: boolean;
}

/**
 * Why "Revert this turn…" is disabled, for causes the client knows without a
 * preview. The first match wins. Anything else is left to the preview, which
 * the server answers authoritatively.
 */
export function useRevertTurnDisabledReason(threadId: string | null | undefined, facts: RevertTurnFacts): string | null {
  const running = useThreadStore((s) => (threadId ? s.runningThreadIds.has(threadId) : false));
  // Unknown git status is not a reason: the preview answers `not_git` itself.
  const notGit = useWorkspaceStore((s) => {
    const workspaceId = s.threads.find((t) => t.id === threadId)?.workspace_id;
    return s.workspaces.find((w) => w.id === workspaceId)?.is_git_repo === false;
  });
  if (!threadId) return "This turn's snapshot is gone";
  if (running) return "Wait for the turn to finish";
  if (notGit) return "Not a git repository";
  if (!facts.snapshot && facts.listSettled) return "This turn's snapshot is gone";
  if (facts.allReverted) return "Already reverted";
  return null;
}

/** Props for {@link TurnRevertBarConfirm}. */
export interface TurnRevertBarConfirmProps {
  readonly threadId: string;
  /** Server id of the turn's assistant message. */
  readonly messageId: string;
  readonly onClose: () => void;
}

/** The revert confirm for a whole turn, opened from the changes bar's menu. */
export function TurnRevertBarConfirm({ threadId, messageId, onClose }: TurnRevertBarConfirmProps) {
  const target = useMemo(() => ({ threadId, messageId, scope: { kind: "turn" as const } }), [threadId, messageId]);
  const { state, apply } = useTurnRevert(target, onClose);
  return <RevertConfirm state={state} title={turnRevertTitle} onRevert={apply} onCancel={onClose} />;
}
