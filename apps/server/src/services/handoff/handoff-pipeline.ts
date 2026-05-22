/**
 * Orchestrates the B->A->D ladder for chat fork handoff generation.
 *
 * The dispatch routes on the parent provider's `sessionForkOnResume` capability:
 * - "clean"       : path B (side-channel resume)
 * - "mutating"    : path A (hidden turn on the parent thread)
 * - "unsupported" or null parent.sdk_session_id : path D (deterministic) directly
 *
 * On any provider failure classified by error-classifier as quota/auth/
 * context-overflow/fatal, the pipeline falls through to D rather than
 * attempting the next ladder step (the next step would hit the same wall).
 */

import { inject, injectable } from "tsyringe";
import { logger, getMcodeDir, resolveHandoffDir, newHandoffUlid } from "@mcode/shared";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { classifyProviderError } from "./error-classifier.js";
import { buildHandoffPrompt, computeBudgetChars, pickHandoffMode, truncateAtSectionBoundary } from "./handoff-prompt.js";
import { runPathDDeterministic } from "./path-d-deterministic.js";
import { buildConversationReplay } from "../handoff-builder.js";
import type {
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
} from "@mcode/contracts";
/**
 * Render an Error-shaped value for structured logging. Winston cannot
 * serialize Error.message / Error.stack because they are non-enumerable;
 * this returns a plain object with those fields plus any classifier-relevant
 * properties (code, status, name).
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
      status: (err as { status?: number }).status,
    };
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    return {
      value: obj,
      message: obj.message,
      code: obj.code,
      status: obj.status,
    };
  }
  return { value: String(err) };
}

import type {
  HandoffArtifact,
  HandoffMeta,
  HandoffMode,
  HandoffRequest,
  LadderStep,
} from "./handoff-types.js";

/**
 * Minimal structural interface for the repos needed by this service.
 * Sync or async return values are both accepted so tests can use
 * async mocks against the real sync repo methods.
 */
interface IThreadRepo {
  findById(id: string): Promise<any> | any;
}
interface IMessageRepo {
  listIncludingInternal(threadId: string): Promise<any[]> | any[];
}
interface IWorkspaceRepo {
  findById(id: string): Promise<any> | any;
}

/** Timeout for side-channel and hidden-turn provider calls, in milliseconds. */
const PROVIDER_CALL_TIMEOUT_MS = 60_000;

@injectable()
export class HandoffPipelineService {
  /**
   * Per-thread mutex for path A. Hidden turns must not interleave on the same
   * parent thread because each turn mutates the provider session state.
   */
  private readonly pathALocks = new Map<string, Promise<void>>();

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: IThreadRepo,
    @inject(MessageRepo) private readonly messageRepo: IMessageRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: Pick<IProviderRegistry, "resolve">,
    @inject(WorkspaceRepo) private readonly workspaceRepo: IWorkspaceRepo,
  ) {}

  /**
   * Test-friendly factory that bypasses DI. Accepts a plain deps object so
   * unit tests can pass vi.fn() mocks without a container.
   */
  static forTesting(deps: {
    threadRepo: IThreadRepo;
    messageRepo: IMessageRepo;
    providerRegistry: Pick<IProviderRegistry, "resolve">;
    workspaceRepo?: IWorkspaceRepo;
  }): HandoffPipelineService {
    const svc = Object.create(HandoffPipelineService.prototype) as HandoffPipelineService;
    (svc as any).threadRepo = deps.threadRepo;
    (svc as any).messageRepo = deps.messageRepo;
    (svc as any).providerRegistry = deps.providerRegistry;
    (svc as any).workspaceRepo = deps.workspaceRepo ?? {
      findById: async () => ({ path: process.cwd() }),
    };
    // Initialize instance-field Maps that aren't set via the constructor.
    (svc as any).pathALocks = new Map<string, Promise<void>>();
    return svc;
  }

  /**
   * Orchestrates B->A->D. Returns a HandoffArtifact. The caller is responsible
   * for persisting it via HandoffStorage.write() so the orchestrator stays
   * free of disk I/O and is fully testable in isolation.
   */
  async orchestrate(req: HandoffRequest): Promise<HandoffArtifact> {
    const parent = await this.threadRepo.findById(req.parentThreadId);
    if (!parent) throw new Error(`Parent thread ${req.parentThreadId} not found`);
    if (parent.deleted_at) throw new Error("Cannot fork from a deleted thread");

    const workspace = await this.workspaceRepo.findById(parent.workspace_id);
    if (!workspace) throw new Error(`Workspace ${parent.workspace_id} not found for parent thread`);
    // Use worktree_path when the parent is running in a worktree; otherwise the
    // workspace root. This ensures the side-channel SDK call sees the user's
    // project files instead of the server's own working directory.
    const parentCwd: string = parent.worktree_path ?? workspace.path;

    const parentProvider = this.tryResolveProvider(parent.provider);
    const childProvider = this.tryResolveProvider(req.childProviderId);
    const childCap: number = childProvider?.maxInputCharactersPerTurn ?? 16_000;
    const mode = pickHandoffMode(childCap);

    const messages = await this.messageRepo.listIncludingInternal(req.parentThreadId);
    const forkMsg = messages.find((m: any) => m.id === req.forkedFromMessageId);
    if (!forkMsg) throw new Error(`Fork message ${req.forkedFromMessageId} not in parent`);

    const preUlid = newHandoffUlid();
    const handoffPath = `${resolveHandoffDir(getMcodeDir(), req.childThreadId, preUlid)}/handoff.md`;

    const prompt = buildHandoffPrompt({
      mode,
      forkAnchorRole: req.forkAnchorRole,
      parentThreadTitle: parent.title,
      forkMessageExcerpt: forkMsg.content,
      childProviderId: req.childProviderId,
      childMaxInputCharacters: childCap,
      handoffDocAbsolutePath: handoffPath,
    });

    const capability: string = parentProvider?.sessionForkOnResume ?? "unsupported";
    const parentSdkSession: string | null = parent.sdk_session_id ?? null;

    // Path B: side-channel query against the parent provider's existing session.
    // Requires sdk_session_id because the side-channel must resume the correct
    // provider conversation state.
    if (capability === "clean" && parentProvider?.runSideChannelQuery && parentSdkSession) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROVIDER_CALL_TIMEOUT_MS);
      try {
        // Build a budgeted history replay so that if the session-resume fails
        // (e.g. after a server restart), the provider can retry without `resume:`
        // and still produce a high-fidelity path-B result.
        const replayBudget = computeBudgetChars(childCap);
        const conversationHistory = buildConversationReplay(messages, replayBudget, null);

        let text: string = await parentProvider.runSideChannelQuery({
          parentThreadId: req.parentThreadId,
          parentSdkSessionId: parentSdkSession,
          prompt,
          abortSignal: abort.signal,
          conversationHistory,
          cwd: parentCwd,
        });
        text = this.applyBudgetGuard(text, childCap, "B");
        return this.buildProviderArtifact(req, parent, text, "B", mode);
      } catch (err) {
        if ((abort.signal as AbortSignal).aborted) {
          logger.warn("Handoff path B timed out; falling to D", { threadId: req.parentThreadId });
          return runPathDDeterministic({
            parentThread: parent,
            messagesUpToFork: messages,
            forkedFromMessageId: req.forkedFromMessageId,
            forkAnchorRole: req.forkAnchorRole,
            childThreadId: req.childThreadId,
            reason: "transient",
          });
        }
        const cls = classifyProviderError(err);
        logger.warn("Handoff path B failed", { error: describeError(err), cls, threadId: req.parentThreadId });
        return runPathDDeterministic({
          parentThread: parent,
          messagesUpToFork: messages,
          forkedFromMessageId: req.forkedFromMessageId,
          forkAnchorRole: req.forkAnchorRole,
          childThreadId: req.childThreadId,
          reason: cls,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    // Path A: hidden turn injected into the parent's mutable session.
    // sdk_session_id is NOT required here because runHiddenTurn creates its own
    // ephemeral turn rather than resuming an existing session; the hidden turn
    // is a no-op if the parent has never started a session (the provider will
    // simply have no prior context to draw from, which is acceptable -- path D
    // will produce an equivalent result in that case). We intentionally do not
    // gate path A on sdk_session_id to avoid blocking providers that defer
    // session creation until the first real turn.
    const runHiddenTurn = parentProvider?.runHiddenTurn?.bind(parentProvider);
    if (capability === "mutating" && runHiddenTurn) {
      return this.withPathALock(req.parentThreadId, async () => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), PROVIDER_CALL_TIMEOUT_MS);
        try {
          let text: string = await runHiddenTurn({
            parentThreadId: req.parentThreadId,
            prompt,
            abortSignal: abort.signal,
          });
          text = this.applyBudgetGuard(text, childCap, "A");
          return this.buildProviderArtifact(req, parent, text, "A", mode);
        } catch (err) {
          if ((abort.signal as AbortSignal).aborted) {
            logger.warn("Handoff path A timed out; falling to D", { threadId: req.parentThreadId });
            return runPathDDeterministic({
              parentThread: parent,
              messagesUpToFork: messages,
              forkedFromMessageId: req.forkedFromMessageId,
              forkAnchorRole: req.forkAnchorRole,
              childThreadId: req.childThreadId,
              reason: "transient",
            });
          }
          const cls = classifyProviderError(err);
          logger.warn("Handoff path A failed", { error: describeError(err), cls, threadId: req.parentThreadId });
          return runPathDDeterministic({
            parentThread: parent,
            messagesUpToFork: messages,
            forkedFromMessageId: req.forkedFromMessageId,
            forkAnchorRole: req.forkAnchorRole,
            childThreadId: req.childThreadId,
            reason: cls,
          });
        } finally {
          clearTimeout(timer);
        }
      });
    }

    // Path D: deterministic fallback for unsupported providers or missing sessions
    return runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      childThreadId: req.childThreadId,
      reason: null,
    });
  }

  /**
   * Safely resolve a provider by ID. The real ProviderRegistry.resolve()
   * throws if the provider isn't registered; this wraps that into a nullable
   * return so the orchestrator can gracefully degrade (typically to path D).
   */
  private tryResolveProvider(providerId: string): IAgentProvider | null {
    try {
      return this.providerRegistry.resolve(providerId as ProviderId);
    } catch {
      return null;
    }
  }

  /**
   * Serializes path A calls on the same parent thread. Concurrent fork
   * requests mutate the provider session state, so each hidden turn must
   * complete before the next begins.
   */
  private async withPathALock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    while (this.pathALocks.has(threadId)) {
      await this.pathALocks.get(threadId);
    }
    let release!: () => void;
    const p = new Promise<void>((res) => { release = res; });
    this.pathALocks.set(threadId, p);
    try {
      return await fn();
    } finally {
      this.pathALocks.delete(threadId);
      release();
    }
  }

  /**
   * Validates provider output against the child's input budget. Truncates at
   * the nearest H2 section boundary when the provider overshoots by more than
   * 15%, appending a truncation notice so the child agent knows the doc was cut.
   */
  private applyBudgetGuard(text: string, childCap: number, step: LadderStep): string {
    const budget = computeBudgetChars(childCap);
    if (text.length > budget * 1.15) {
      logger.warn("Provider exceeded handoff budget; truncating", { produced: text.length, budget, ladderStep: step });
      const truncated = truncateAtSectionBoundary(text, budget);
      return truncated + "\n\n<!-- handoff truncated at budget; see full doc on disk -->";
    }
    return text;
  }

  /** Builds a provider-generated artifact with the given ladder step and mode. */
  private buildProviderArtifact(
    req: HandoffRequest,
    parent: any,
    markdownBody: string,
    step: LadderStep,
    mode: HandoffMode,
  ): HandoffArtifact {
    const meta: HandoffMeta = {
      schemaVersion: 1,
      parentThreadId: req.parentThreadId,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      childThreadId: req.childThreadId,
      generatedBy: "provider",
      provider: parent.provider,
      ladderStep: step,
      mode,
      generatedAt: new Date().toISOString(),
      characterCount: markdownBody.length,
      parentSdkSessionId: parent.sdk_session_id ?? null,
      providerErrorOnGenerate: null,
      regenerationHistory: [],
      attachments: [],
    };
    return { markdown: markdownBody, meta };
  }
}
