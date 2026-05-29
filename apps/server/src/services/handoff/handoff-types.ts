/**
 * Shared types for the chat fork handoff pipeline.
 *
 * These now live canonically in `@mcode/contracts` (providers/session-forker)
 * so the {@link IAgentProvider} interface can reference the forker contract.
 * This module re-exports them and adds the pipeline-only {@link HandoffRequest}
 * so existing server-side imports keep working unchanged.
 */

export type {
  LadderStep,
  HandoffMode,
  ForkAnchorRole,
  ProviderErrorClass,
  HandoffMeta,
  HandoffArtifact,
} from "@mcode/contracts";

import type { ForkAnchorRole } from "@mcode/contracts";

/** Input to the pipeline's orchestrate() method. */
export interface HandoffRequest {
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  childProviderId: string;
  /** The user's new message in the fork composer that the child agent will receive as its first turn. */
  userFollowUpMessage: string;
}
