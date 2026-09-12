import type { AttachmentMeta } from "@/transport";
import type {
  DevinMode,
  MessageMention,
  OrchestrationMode,
  PreviewAnnotationBundle,
  SelectedTextComment,
} from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** A normalized Composer payload that can be sent to an existing thread. */
export interface ComposerThreadMessagePayload {
  content: string;
  displayContent: string;
  attachments: AttachmentMeta[];
  selection: ComposerAgentSelection;
  mentions: MessageMention[];
  previewAnnotations?: PreviewAnnotationBundle;
  goalObjective?: string;
  orchestrationMode?: OrchestrationMode;
  selectedTextComments?: SelectedTextComment[];
}

/** Provider-scoped composer values, undefined for providers that do not own them. */
export function providerScopedSelection(selection: ComposerAgentSelection): {
  copilotAgent: string | undefined;
  codexFastMode: boolean | undefined;
  devinMode: DevinMode | undefined;
} {
  return {
    copilotAgent: selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined,
    codexFastMode: selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined,
    devinMode: selection.provider === "devin" ? selection.devinMode ?? undefined : undefined,
  };
}

/** Sends one normalized Composer payload to its existing thread. */
export async function sendComposerThreadMessage(
  threadId: string,
  payload: ComposerThreadMessagePayload,
): Promise<void> {
  const { selection } = payload;
  const scoped = providerScopedSelection(selection);
  const sent = await useThreadStore.getState().sendMessage(
    threadId,
    payload.content,
    selection.modelId,
    selection.permissionMode,
    payload.attachments.length > 0 ? payload.attachments : undefined,
    payload.displayContent,
    selection.reasoning,
    selection.provider,
    scoped.copilotAgent,
    selection.contextWindow ?? undefined,
    selection.thinking ?? undefined,
    scoped.codexFastMode,
    undefined,
    undefined,
    undefined,
    payload.mentions,
    payload.previewAnnotations,
    payload.goalObjective,
    payload.orchestrationMode,
    payload.selectedTextComments,
    selection.approvalReviewMode,
    scoped.devinMode,
  );
  if (!sent) throw new Error("Message dispatch failed");
}

/** Adapts a prepared submit for existing-thread transport. */
export function createPreparedThreadMessagePayload(
  submission: PreparedComposerSubmission,
): ComposerThreadMessagePayload {
  return {
    content: submission.prepared.content,
    displayContent: submission.prepared.displayContent,
    attachments: submission.attachmentMetas,
    selection: submission.snapshot.selection,
    mentions: submission.snapshot.mentions,
    previewAnnotations: submission.previewAnnotations,
    goalObjective: submission.goalObjective,
    orchestrationMode: submission.snapshot.selection.orchestrationMode,
    selectedTextComments: submission.snapshot.selectedTextComments.length > 0
      ? submission.snapshot.selectedTextComments
      : undefined,
  };
}
