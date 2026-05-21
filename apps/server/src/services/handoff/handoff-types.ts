/**
 * Shared types for the chat fork handoff pipeline.
 *
 * The B/A/D ladder, mode selection, error classification, and the on-disk
 * artifact shape all reference these types. Importing modules use them to
 * avoid restating literal unions.
 */

/** Which step of the B→A→D ladder produced the handoff. */
export type LadderStep = "B" | "A" | "D";

/** Full handoff has all sections; minimal targets sub-8000-char child providers. */
export type HandoffMode = "full" | "minimal";

/** Whether the parent message at the fork point was authored by the user or assistant. */
export type ForkAnchorRole = "user" | "assistant";

/** Classified provider error returned during path-B/A attempts. */
export type ProviderErrorClass =
  | "quota"             // 429, rate-limit, billing-exhausted
  | "auth"              // 401, expired credentials
  | "context-overflow"  // input too large for the model
  | "transient"         // network blip, 5xx, retry-once is reasonable
  | "fatal"             // provider misconfigured, model removed, etc.
  | "clean";            // no error

/** What the pipeline writes to handoff.json. */
export interface HandoffMeta {
  schemaVersion: 1;
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  generatedBy: "provider" | "deterministic";
  provider: string | null;
  ladderStep: LadderStep;
  mode: HandoffMode;
  generatedAt: string;
  characterCount: number;
  parentSdkSessionId: string | null;
  providerErrorOnGenerate: ProviderErrorClass | null;
  regenerationHistory: Array<{
    at: string;
    ladderStep: LadderStep;
    reason: ProviderErrorClass | "user-requested";
  }>;
  attachments: Array<{
    id: string;
    originalName: string;
    sha256: string;
    mime: string;
    parentMessageId: string;
  }>;
}

/** Returned by every ladder step. The pipeline writes both to disk. */
export interface HandoffArtifact {
  markdown: string;
  meta: HandoffMeta;
}

/** Input to the pipeline's orchestrate() method. */
export interface HandoffRequest {
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  childProviderId: string;
}
