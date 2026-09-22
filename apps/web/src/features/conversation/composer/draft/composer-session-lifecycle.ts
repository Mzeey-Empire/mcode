import type { ComposerDraft } from "@/stores/composerDraftStore";
import type { ThreadDraft } from "@/stores/threadDraftStore";
import { INTERACTION_MODES, PERMISSION_MODES } from "@/transport";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import { resolveComposerSession, snapshotComposerDraft, type ComposerSession } from "@/lib/composer-session";
import { buildSavedComposerSession } from "@/lib/composer-session";
import { readWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";

/** Identity of the session a Composer is bound to. */
export type ComposerOwner =
  | { kind: "thread"; id: string }
  | { kind: "draft"; id: string }
  | { kind: "new" };

/** Stable comparison key for one composer owner. */
export function composerOwnerKey(owner: ComposerOwner): string {
  return owner.kind === "new" ? "new" : `${owner.kind}:${owner.id}`;
}

/** Dependencies that transition a Composer draft between owners. */
export interface ComposerDraftOwnerTransition {
  previousOwnerKey: string;
  nextOwnerKey: string;
  draft: ComposerDraft;
  ownerExists(ownerKey: string): boolean;
  saveDraft(ownerKey: string, draft: ComposerDraft): void;
}

/** Inputs that resolve the Composer session for the current owner. */
export interface ComposerSessionOwnerInput {
  owner: ComposerOwner;
  getDraft(threadId: string): ComposerDraft | undefined;
  getThreadDraft(draftId: string): ThreadDraft | undefined;
}

function releaseOrphanedComposerDraft(draft: ComposerDraft): void {
  for (const attachment of draft.attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  const spillPaths = collectSpillPathsFromPendingAttachments(draft.attachments);
  if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
}

function readComposerThreadSettings(threadId: string | undefined) {
  if (!threadId) {
    return {
      interactionMode: INTERACTION_MODES.BUILD,
      orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      permissionMode: PERMISSION_MODES.FULL,
      copilotAgent: null,
      contextWindow: null,
      thinking: null,
      codexFastMode: null,
      devinMode: null,
    };
  }
  const settings = useThreadStore.getState().getThreadSettings(threadId);
  return {
    interactionMode: settings.interactionMode,
    orchestrationMode: settings.orchestrationMode,
    permissionMode: settings.permissionMode,
    copilotAgent: settings.copilotAgent ?? null,
    contextWindow: settings.contextWindow ?? null,
    thinking: settings.thinking ?? null,
    codexFastMode: settings.codexFastMode ?? null,
    devinMode: settings.devinMode ?? null,
  };
}

function readComposerGlobalDefaults() {
  const { settings } = useSettingsStore.getState();
  return {
    interactionMode:
      settings.agent.defaults.mode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.BUILD,
    permissionMode: settings.agent.defaults.permission,
  };
}

function resolveDefaultComposerSession(): ComposerSession {
  return resolveComposerSession({
    threadId: undefined,
    getDraft: () => undefined,
    threadRow: undefined,
    threadSettings: readComposerThreadSettings(undefined),
    globalDefaults: readComposerGlobalDefaults(),
  });
}

/** Draft entities carry the modes a real thread would read from its settings record. */
function resolveThreadDraftSession(entity: ThreadDraft): ComposerSession {
  return buildSavedComposerSession(entity.draft, {
    interactionMode: entity.selection.interactionMode,
    permissionMode: entity.selection.permissionMode,
    orchestrationMode: entity.selection.orchestrationMode,
    approvalReviewMode: entity.selection.approvalReviewMode,
    copilotAgent: entity.selection.copilotAgent,
    thinking: entity.selection.thinking,
    // Draft-owned fields live on the draft itself; the settings fallback re-reads them.
    contextWindow: entity.draft.contextWindow ?? null,
    codexFastMode: entity.draft.codexFastMode ?? null,
    devinMode: entity.draft.devinMode ?? null,
  });
}

/** Saves a departed draft when its owner exists or releases its browser resources when it does not. */
export function transitionComposerDraftOwner({
  previousOwnerKey,
  nextOwnerKey,
  draft,
  ownerExists,
  saveDraft,
}: ComposerDraftOwnerTransition): void {
  if (previousOwnerKey === nextOwnerKey || previousOwnerKey === "new") return;
  if (ownerExists(previousOwnerKey)) {
    saveDraft(previousOwnerKey, snapshotComposerDraft(draft));
    return;
  }
  releaseOrphanedComposerDraft(draft);
}

/** Resolves the stored draft and settings that belong to the current Composer owner. */
export function resolveComposerSessionForOwner({
  owner,
  getDraft,
  getThreadDraft,
}: ComposerSessionOwnerInput): ComposerSession {
  if (owner.kind === "new") return resolveDefaultComposerSession();

  if (owner.kind === "draft") {
    const entity = getThreadDraft(owner.id);
    return entity
      ? resolveThreadDraftSession(entity)
      : resolveDefaultComposerSession();
  }

  const threadSettings = readComposerThreadSettings(owner.id);
  return resolveComposerSession({
    threadId: owner.id,
    getDraft,
    threadRow: readWorkspaceThread(owner.id),
    threadSettings,
    globalDefaults: readComposerGlobalDefaults(),
  });
}
