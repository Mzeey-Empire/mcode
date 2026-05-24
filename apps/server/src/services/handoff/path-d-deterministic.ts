/**
 * Path D of the chat fork handoff ladder.
 *
 * Wraps the existing deterministic handoff-builder so the orchestrator can
 * treat all three paths (B, A, D) uniformly. The legacy builder produces
 * prose for the system message; this adapter wraps it in the new metadata
 * shape and tags the source as `deterministic`.
 */

import type { Thread, Message } from "@mcode/contracts";
import { buildHandoffContent } from "../handoff-builder.js";
import type { HandoffArtifact, HandoffMeta, ForkAnchorRole, ProviderErrorClass } from "./handoff-types.js";

/** Input data required to produce a deterministic path-D handoff artifact. */
export interface PathDInput {
  parentThread: Thread;
  messagesUpToFork: Message[];
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  /** Why D ran instead of B/A. null when D was the only viable path. */
  reason: ProviderErrorClass | null;
}

/**
 * Produce a HandoffArtifact using the legacy deterministic builder.
 * Used when provider-generated handoffs are not available (quota, auth,
 * context-overflow, transient failure with no retry, or unsupported provider).
 */
export async function runPathDDeterministic(input: PathDInput): Promise<HandoffArtifact> {
  const { parentThread, messagesUpToFork, forkedFromMessageId, forkAnchorRole, childThreadId, reason } = input;

  const lastAssistant = [...messagesUpToFork].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistant?.content ?? null;

  const prose = buildHandoffContent({
    parentThread,
    forkMessageId: forkedFromMessageId,
    lastAssistantText,
    recentFilesChanged: [],
    openTasks: [],
    sourceHead: null,
  });

  const markdown = `# Handoff (deterministic)\n\n${prose}\n`;
  const meta: HandoffMeta = {
    schemaVersion: 1,
    parentThreadId: parentThread.id,
    forkedFromMessageId,
    forkAnchorRole,
    childThreadId,
    generatedBy: "deterministic",
    provider: parentThread.provider,
    ladderStep: "D",
    mode: "full",
    generatedAt: new Date().toISOString(),
    characterCount: markdown.length,
    parentSdkSessionId: parentThread.sdk_session_id ?? null,
    providerErrorOnGenerate: reason,
    regenerationHistory: [],
    attachments: [],
  };
  return { markdown, meta };
}
