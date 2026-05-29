/**
 * Session-fork contract for the chat fork handoff pipeline.
 *
 * The B/A/D ladder is no longer dispatched inline in the handoff pipeline.
 * Instead every {@link IAgentProvider} exposes a `forker` whose `fork(req)`
 * produces a {@link HandoffArtifact}. This module is the canonical home for
 * the artifact shape and the forker contract so the provider interface (which
 * lives in this package) can reference them without depending on the server.
 *
 * The server's `services/handoff/handoff-types.ts` re-exports these so
 * existing server-side imports keep working unchanged.
 */

import type { Message, Thread } from "../index.js";

/** Which step of the B->A->D ladder produced the handoff. */
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

/** Returned by every forker. The pipeline writes both fields to disk. */
export interface HandoffArtifact {
  markdown: string;
  meta: HandoffMeta;
}

/**
 * Provider-agnostic input to {@link SessionForker.fork}. The handoff pipeline
 * builds one from the parent thread + sliced message history and hands it to
 * the resolved provider's forker.
 */
export interface ForkRequest {
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  prompt: string;
  cwd: string;
  parentSdkSessionId?: string | null;
  /**
   * Conversation history as plain text (budgeted replay). Used by clean-resume
   * providers as the sessionless B-prime fallback body.
   */
  conversationHistory?: string;
  /** Parent messages up to the fork point, for the deterministic builder. */
  messagesUpToFork: Message[];
  /** Full parent thread row; the deterministic builder needs its metadata. */
  parentThread: Thread;
  /** The forked child thread id, threaded through to the artifact metadata. */
  childThreadId: string;
  /**
   * Why a deterministic fork is running, when it runs as a fallback. null when
   * the deterministic forker is the only viable path (e.g. unsupported provider).
   */
  forkReason?: ProviderErrorClass | null;
  abortSignal?: AbortSignal;
}

/**
 * A provider-specific strategy that turns a {@link ForkRequest} into a
 * {@link HandoffArtifact}. Implemented server-side by CleanForker (path B),
 * MutatingForker (path A), and DeterministicForker (path D).
 */
export interface SessionForker {
  fork(req: ForkRequest): Promise<HandoffArtifact>;
}
