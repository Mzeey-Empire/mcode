import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PARENT_TURN_DURABILITY, type ParentTurnDurability } from "./parent-turn-durability.js";

/** Owns conversation-message projection for normalized provider events. */
@injectable()
export class TurnConversationProjectionService {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(PARENT_TURN_DURABILITY) private readonly parentTurns: ParentTurnDurability,
  ) {}

  /** Start the deterministic reliability harness parent turn with its durable user message. */
  async startReliabilityTurn(threadId: string, executionId: string): Promise<void> {
    const thread = this.threads.findById(threadId);
    if (!thread) throw new Error(`Reliability stream thread not found: ${threadId}`);
    const sequence = this.messages.getLatestSequenceIncludingInternal(threadId) + 1;
    await this.parentTurns.startParentTurn({
      thread: {
        id: thread.id,
        workspaceId: thread.workspace_id,
        providerId: thread.provider,
        createdAt: thread.created_at,
      },
      turnId: NodeCrypto.randomUUID(),
      executionId,
      permissionMode: "supervised",
      approvalReviewMode: "manual",
      approvalReviewReason: "manual-requested",
      providerIdentities: [],
      userMessage: { kind: "create", content: "Reliability harness assistant stream", sequence },
    });
  }
}
