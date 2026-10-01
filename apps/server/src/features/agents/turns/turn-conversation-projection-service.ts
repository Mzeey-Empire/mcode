import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { AgentEvent } from "@mcode/contracts";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PARENT_TURN_DURABILITY, type ParentTurnDurability } from "./parent-turn-durability.js";
import { TURN_FINALIZER, TurnFinalizer } from "./turn-finalizer.js";
import { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { turnConversationWriteOperations } from "./turn-conversation-write-operations.js";

/** Owns conversation-message projection for normalized provider events. */
@injectable()
export class TurnConversationProjectionService {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(TURN_FINALIZER) private readonly finalizer: TurnFinalizer,
    @inject(PARENT_TURN_DURABILITY) private readonly parentTurns: ParentTurnDurability,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    @inject(CanonicalAcceptedProgress, { isOptional: true }) private readonly progress?: CanonicalAcceptedProgress,
  ) {}

  /** Assign renderer identity and buffer a provider assistant message until terminal materialization. */
  async bufferAssistantMessage(
    event: Extract<AgentEvent, { type: "message" }>,
    postTurnGoalReceipt: boolean,
  ): Promise<void> {
    const model = this.threads.findById(event.threadId)?.model ?? null;
    if (postTurnGoalReceipt) {
      await this.materializeGoalReceipt(event, model);
      return;
    }
    const attachments = this.finalizer.getBufferedAssistantAttachments(event.threadId);
    const messageId = this.finalizer.bufferAssistantBody(event.threadId, event.content, model, attachments);
    event.messageId = messageId;
    event.model = model;
    if (attachments.length > 0) event.attachments = attachments;
    this.finalizer.resetStreamingText(event.threadId);
  }

  /** Persist the divider that marks a completed provider compaction. */
  persistCompactionDivider(threadId: string): Promise<void> {
    return this.writer.execute(turnConversationWriteOperations.compactionDivider, threadId);
  }

  /** Return true when the retained writer owner has already published this notice. */
  async persistSystemNotice(event: Extract<AgentEvent, { type: "system" }>): Promise<boolean> {
    if (this.progress) {
      const accepted = this.progress.acceptThreadSystemObservation(event);
      event.messageId = accepted.messageId;
      event.publicationId = accepted.publicationId;
      return true;
    }
    const notice = await this.writer.execute(turnConversationWriteOperations.systemNotice, {
      threadId: event.threadId, content: event.message ?? "", notice: event.systemNotice,
    });
    event.messageId = notice.id;
    return false;
  }

  /** Remove diagnostics from a previous provider session before publishing startup. */
  async beginNoticeSession(event: Extract<AgentEvent, { type: "system" }>): Promise<boolean> {
    if (this.progress) {
      const accepted = this.progress.acceptThreadSystemObservation(event);
      event.publicationId = accepted.publicationId;
      return true;
    }
    await this.messages.beginNoticeSession(event.threadId, event.systemNotice?.sessionId);
    return false;
  }

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

  private async materializeGoalReceipt(
    event: Extract<AgentEvent, { type: "message" }>,
    model: string | null,
  ): Promise<void> {
    const { messages } = this.messages.listByThread(event.threadId, 1);
    const last = messages[messages.length - 1];
    const messageId = last?.role === "assistant" && last.content === event.content
      ? last.id
      : NodeCrypto.createHash("sha256").update(JSON.stringify([
        "goal-receipt", event.threadId, event.turnExecutionId, event.content,
      ])).digest("hex");
    event.messageId = messageId;
    event.model = model;
    const receipt = await this.writer.execute(turnConversationWriteOperations.goalReceipt, {
      threadId: event.threadId, messageId, content: event.content, model,
    });
    if (receipt.id !== messageId) throw new Error("Goal receipt changed its assigned renderer identity");
  }
}
