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
import { classifyProviderError } from "./error-classifier.js";
import { buildHandoffPrompt, pickHandoffMode } from "./handoff-prompt.js";
import { runPathDDeterministic } from "./path-d-deterministic.js";
import type {
  HandoffArtifact,
  HandoffMeta,
  HandoffMode,
  HandoffRequest,
  LadderStep,
} from "./handoff-types.js";

/**
 * Minimal structural interface for the repos and registry needed by this
 * service. Sync or async return values are both accepted so tests can use
 * async mocks against the real sync repo methods.
 */
interface IThreadRepo {
  findById(id: string): Promise<any> | any;
}
interface IMessageRepo {
  listIncludingInternal(threadId: string): Promise<any[]> | any[];
}
interface IProviderRegistry {
  get(id: string): any;
}

@injectable()
export class HandoffPipelineService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: IThreadRepo,
    @inject(MessageRepo) private readonly messageRepo: IMessageRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: IProviderRegistry,
  ) {}

  /**
   * Test-friendly factory that bypasses DI. Accepts a plain deps object so
   * unit tests can pass vi.fn() mocks without a container.
   */
  static forTesting(deps: {
    threadRepo: IThreadRepo;
    messageRepo: IMessageRepo;
    providerRegistry: IProviderRegistry;
  }): HandoffPipelineService {
    const svc = Object.create(HandoffPipelineService.prototype) as HandoffPipelineService;
    (svc as any).threadRepo = deps.threadRepo;
    (svc as any).messageRepo = deps.messageRepo;
    (svc as any).providerRegistry = deps.providerRegistry;
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

    const parentProvider = this.providerRegistry.get(parent.provider);
    const childProvider = this.providerRegistry.get(req.childProviderId);
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

    // Path B: side-channel query against the parent provider's existing session
    if (capability === "clean" && parentProvider?.runSideChannelQuery && parentSdkSession) {
      try {
        const text: string = await parentProvider.runSideChannelQuery({
          parentThreadId: req.parentThreadId,
          parentSdkSessionId: parentSdkSession,
          prompt,
        });
        return this.buildProviderArtifact(req, parent, text, "B", mode);
      } catch (err) {
        const cls = classifyProviderError(err);
        logger.warn("Handoff path B failed", { err, cls, threadId: req.parentThreadId });
        return runPathDDeterministic({
          parentThread: parent,
          messagesUpToFork: messages,
          forkedFromMessageId: req.forkedFromMessageId,
          forkAnchorRole: req.forkAnchorRole,
          childThreadId: req.childThreadId,
          reason: cls,
        });
      }
    }

    // Path A: hidden turn injected into the parent's mutable session
    if (capability === "mutating" && parentProvider?.runHiddenTurn) {
      try {
        const text: string = await parentProvider.runHiddenTurn({
          parentThreadId: req.parentThreadId,
          prompt,
        });
        return this.buildProviderArtifact(req, parent, text, "A", mode);
      } catch (err) {
        const cls = classifyProviderError(err);
        logger.warn("Handoff path A failed", { err, cls, threadId: req.parentThreadId });
        return runPathDDeterministic({
          parentThread: parent,
          messagesUpToFork: messages,
          forkedFromMessageId: req.forkedFromMessageId,
          forkAnchorRole: req.forkAnchorRole,
          childThreadId: req.childThreadId,
          reason: cls,
        });
      }
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
