import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { AgentService } from "../orchestration/agent-service.js";
import type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";

const PREVIEW_ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v1";
const PREVIEW_ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

/** Dispatch a retry with the same annotation and admission semantics as a user RPC. */
export function dispatchRetryTurn(service: Pick<AgentService, "sendMessage">, command: SendMessageCommand): Promise<void> {
  return sendAdmittedTurn(service, { ...command,
    content: appendPreviewAnnotations(command.content, command.previewAnnotations),
    displayContent: command.content });
}

/** Resolve after durable admission rather than keeping the caller open for the provider's whole turn. */
export async function sendAdmittedTurn(service: Pick<AgentService, "sendMessage">, command: SendMessageCommand): Promise<void> {
  let admitted = false;
  let resolveAdmission!: () => void;
  const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
  const dispatch = service.sendMessage({
    ...command,
    // onTurnStarted reserves the turn before its user message is committed.
    onAdmissionComplete: () => {
      admitted = true;
      command.onAdmissionComplete?.();
      resolveAdmission();
    },
  });
  void dispatch.catch((error: unknown) => {
    if (!admitted) return;
    logger.error("Admitted turn dispatch failed", { threadId: command.threadId,
      error: error instanceof Error ? error.message : String(error) });
  });
  await Promise.race([admission, dispatch]);
}

/** Append provider-facing preview context while preserving the original display content. */
export function appendPreviewAnnotations(content: string, previewAnnotations: PreviewAnnotationBundle | undefined): string {
  if (!previewAnnotations || previewAnnotations.annotations.length === 0) return content;
  if (content.includes(PREVIEW_ANNOTATION_FENCE_START)) return content;
  const serialized = JSON.stringify(previewAnnotations)
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return `${content.trim()}\n\n${PREVIEW_ANNOTATION_FENCE_START}\n${serialized}\n${PREVIEW_ANNOTATION_FENCE_END}`.trim();
}
