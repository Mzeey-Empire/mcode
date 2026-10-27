import { toPreviewAnnotationBundleV2, type PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import { logger } from "@mcode/shared";
import type { AgentService } from "../orchestration/agent-service.js";
import type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";

const PREVIEW_ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v2";
const PREVIEW_ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

/** Dispatch a server-built recovery attempt, rebuilding its provider input the way a composer send does. */
export function sendRecoveryAttempt(service: Pick<AgentService, "sendMessage">, command: SendMessageCommand): Promise<void> {
  return sendAdmittedTurn(service, { ...command,
    content: appendPreviewAnnotations(command.content, command.previewAnnotations),
    displayContent: command.content });
}

/** A turn command that can report its durable admission before provider dispatch. */
type AdmittableTurnCommand = Pick<SendMessageCommand, "threadId" | "onAdmissionComplete">;

/** Resolve after durable admission rather than keeping the caller open for the provider's whole turn. */
export async function sendAdmittedTurn<Command extends AdmittableTurnCommand>(
  service: { sendMessage(command: Command): Promise<void> },
  command: Command,
): Promise<void> {
  let admitted = false;
  let resolveAdmission!: () => void;
  const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
  const dispatch = service.sendMessage({
    ...command,
    // onTurnStarted reserves the turn before its user message is committed.
    onAdmissionComplete: (turnAdmitted) => {
      admitted = true;
      command.onAdmissionComplete?.(turnAdmitted);
      resolveAdmission();
    },
  });
  void dispatch.catch((error: unknown) => {
    if (!admitted) return;
    logger.error("Admitted turn dispatch failed", { threadId: command.threadId,
      error: error instanceof Error ? error.message : String(error) });
  });
  // Completion arrives through the execution stream. Keeping this RPC open
  // would let its timeout undo a healthy turn that is still running.
  await Promise.race([admission, dispatch]);
}

/** The provider sees page metadata only. A snapshot's host path and file name stay on this machine. */
function withoutLocalSnapshotPaths(bundle: ReturnType<typeof toPreviewAnnotationBundleV2>) {
  const pages = bundle.pages.map(({ snapshot, ...page }) => {
    const { sourcePath: _sourcePath, name: _name, ...metadata } = snapshot;
    return { ...page, snapshot: metadata };
  });
  return { ...bundle, pages };
}

/** Append provider-facing preview context while preserving the original display content. */
export function appendPreviewAnnotations(content: string, previewAnnotations: PreviewAnnotationBundle | undefined): string {
  if (!previewAnnotations || previewAnnotations.annotations.length === 0) return content;
  if (content.includes(PREVIEW_ANNOTATION_FENCE_START)) return content;
  const serialized = JSON.stringify(withoutLocalSnapshotPaths(toPreviewAnnotationBundleV2(previewAnnotations)))
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return `${content.trim()}\n\n${PREVIEW_ANNOTATION_FENCE_START}\n${serialized}\n${PREVIEW_ANNOTATION_FENCE_END}`.trim();
}
