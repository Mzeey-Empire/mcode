/**
 * Orchestrates chat fork handoff generation by delegating to each provider's
 * {@link SessionForker}.
 *
 * The pipeline builds a {@link ForkRequest} and calls `provider.forker.fork(req)`.
 * Each provider owns the strategy: CleanForker (Claude, path B), MutatingForker
 * (Cursor, path A), or DeterministicForker (Codex/Copilot, path D). The
 * `sessionForkOnResume` field is now metadata only (provenance + the path-A
 * mutex decision), not the dispatch key.
 *
 * On a classified non-retryable provider error (quota/auth/context-overflow/
 * fatal) or a timeout, the pipeline falls back to a shared DeterministicForker
 * (path D) rather than retrying — the same wall would be hit again.
 */

import { tmpdir } from "os";
import { writeFile } from "fs/promises";
import { join as pathJoin } from "path";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { classifyProviderError } from "./error-classifier.js";
import { buildHandoffPrompt, computeBudgetChars, pickHandoffMode, truncateAtSectionBoundary } from "./handoff-prompt.js";
import { DeterministicForker } from "./session-forker.js";
import { buildConversationReplay } from "../handoff-builder.js";
import type {
  ForkRequest,
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

/**
 * Timeout for side-channel and hidden-turn provider calls, in milliseconds.
 * Handoff generation includes a cold SDK subprocess start plus model inference;
 * 60s was too tight after server restarts on Windows.
 */
const PROVIDER_CALL_TIMEOUT_MS = 120_000;

@injectable()
export class HandoffPipelineService {
  /**
   * Per-thread mutex for path A. Hidden turns must not interleave on the same
   * parent thread because each turn mutates the provider session state.
   */
  private readonly pathALocks = new Map<string, Promise<void>>();

  /**
   * Cross-forker fallback. The pipeline delegates to a provider's own forker
   * first; on a classified non-retryable error or timeout it falls back to this
   * deterministic forker (path D).
   */
  private readonly deterministicForker = new DeterministicForker();

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
    // Initialize instance fields that aren't set via the constructor (Object.create
    // bypasses field initializers).
    (svc as any).pathALocks = new Map<string, Promise<void>>();
    (svc as any).deterministicForker = new DeterministicForker();
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
    const forkIndex = messages.findIndex((m: any) => m.id === req.forkedFromMessageId);
    if (forkIndex === -1) throw new Error(`Fork message ${req.forkedFromMessageId} not in parent`);
    // Slice to only include messages up to and including the fork anchor so that
    // later parent messages cannot leak into the child handoff context.
    const messagesUpToFork = messages.slice(0, forkIndex + 1);
    const forkMsg = messagesUpToFork[forkIndex];

    const prompt = buildHandoffPrompt({
      mode,
      forkAnchorRole: req.forkAnchorRole,
      parentThreadTitle: parent.title,
      forkMessageExcerpt: forkMsg.content,
      childProviderId: req.childProviderId,
      childMaxInputCharacters: childCap,
      userFollowUpMessage: req.userFollowUpMessage,
    });

    const capability: string = parentProvider?.sessionForkOnResume ?? "unsupported";
    const parentSdkSession: string | null = parent.sdk_session_id ?? null;

    // Build a budgeted history replay so that if a clean-resume session fails
    // (e.g. after a server restart), the provider can retry without `resume:`
    // and still produce a high-fidelity path-B result.
    const replayBudget = computeBudgetChars(childCap);
    const conversationHistory = buildConversationReplay(messagesUpToFork, replayBudget, null);

    const forkReq: ForkRequest = {
      parentThreadId: req.parentThreadId,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      prompt,
      cwd: parentCwd,
      parentSdkSessionId: parentSdkSession,
      conversationHistory,
      messagesUpToFork,
      parentThread: parent,
      childThreadId: req.childThreadId,
    };

    // Providers that cannot fork a session (capability "unsupported") or a
    // clean-resume provider with no session id to resume go straight to the
    // deterministic forker. The DeterministicForker is also the cross-forker
    // fallback below.
    const canProviderFork =
      !!parentProvider &&
      ((capability === "clean" && !!parentSdkSession) || capability === "mutating");
    if (!canProviderFork) {
      return this.deterministicForker.fork({ ...forkReq, forkReason: null });
    }

    // Path A (mutating) must be serialized per parent thread because each
    // hidden turn mutates provider session state. Path B (clean) does not.
    const runFork = async (): Promise<HandoffArtifact> => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROVIDER_CALL_TIMEOUT_MS);
      try {
        const artifact = await parentProvider!.forker.fork({ ...forkReq, abortSignal: abort.signal });
        // Apply the child's input budget to provider output, then stamp the
        // budget-driven mode (forkers return mode "full" by default).
        const guarded = await this.applyBudgetGuard(
          artifact.markdown,
          childCap,
          artifact.meta.ladderStep,
          req.childThreadId,
        );
        return { markdown: guarded, meta: { ...artifact.meta, mode, characterCount: guarded.length } };
      } catch (err) {
        if ((abort.signal as AbortSignal).aborted) {
          logger.warn("Handoff provider fork timed out; falling to D", { threadId: req.parentThreadId });
          return this.deterministicForker.fork({ ...forkReq, forkReason: "transient" });
        }
        const cls = classifyProviderError(err);
        logger.warn("Handoff provider fork failed", { error: describeError(err), cls, threadId: req.parentThreadId });
        return this.deterministicForker.fork({ ...forkReq, forkReason: cls });
      } finally {
        clearTimeout(timer);
      }
    };

    if (capability === "mutating") {
      return this.withPathALock(req.parentThreadId, runFork);
    }
    return runFork();
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
   * Validates provider output against the child's input budget. When the
   * provider overshoots by more than 15%, writes the full doc to OS temp dir
   * and returns a truncated inline version with a pointer to the overflow file.
   * Falls back to a hard truncation with a comment if the temp write fails.
   */
  private async applyBudgetGuard(
    text: string,
    childCap: number,
    step: LadderStep,
    childThreadId: string,
  ): Promise<string> {
    const budget = computeBudgetChars(childCap);

    // Within budget — return as-is.
    if (text.length <= budget * 1.15) return text;

    logger.warn("Provider exceeded handoff budget; truncating + overflowing to temp", {
      produced: text.length,
      budget,
      ladderStep: step,
      threadId: childThreadId,
    });

    // Generate overflow filename in OS temp dir. Format mirrors the
    // /handoff skill's convention (timestamped, slugged).
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const overflowPath = pathJoin(tmpdir(), `mcode-handoff-overflow-${childThreadId}-${ts}.md`);

    try {
      // Write the FULL doc to temp so the next agent can Read it on demand.
      await writeFile(overflowPath, text, "utf8");
    } catch (err) {
      logger.warn("Failed to write handoff overflow to temp; continuing with hard truncation only", {
        overflowPath,
        err: err instanceof Error ? err.message : String(err),
      });
      return truncateAtSectionBoundary(text, budget) + "\n\n<!-- handoff truncated at budget; overflow write failed -->";
    }

    // Truncate the inline version, leaving room for the pointer block.
    const POINTER_BUDGET = 400;
    const inlinedBudget = budget - POINTER_BUDGET;
    const truncated = truncateAtSectionBoundary(text, inlinedBudget);

    return [
      truncated,
      "",
      "## Detailed context (overflow)",
      "The parent thread's full handoff exceeded the inline budget. The complete doc is on the user's filesystem at:",
      `  ${overflowPath}`,
      "Use the Read tool to access it for additional context on the parent thread.",
    ].join("\n");
  }
}
