import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type { RecoveryIncident } from "@mcode/contracts";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";

/** Reconciles durable turn checkpoints after a server process restart. */
@injectable()
export class TurnRecoveryService {
  private currentIncident: RecoveryIncident | null = null;

  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonicalSink: CanonicalAgentBoundary,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(ParentAssistantTextCheckpointService)
    private readonly parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
  ) {}

  /** Interrupt executions for which no current provider can prove the exact live execution. */
  async reconcileOnStartup(): Promise<{ interrupted: string[] }> {
    await this.parentAssistantTextCheckpoints.importRecoveryJournals();
    await this.reopenMaterializableTerminalCheckpoints();
    await this.parentAssistantTextCheckpoints.retireTerminalCheckpoints();
    await this.canonicalSink.interruptSavedFamilyChildren(UNPROVED_EXECUTION_REASON);
    const checkpoints = this.canonicalSink.listUnfinishedCheckpoints();
    if (checkpoints.length === 0) {
      this.currentIncident = null;
      return { interrupted: [] };
    }
    const incident = { id: NodeCrypto.randomUUID(), createdAt: new Date().toISOString() };
    const interrupted: string[] = [];
    for (const checkpoint of checkpoints) interrupted.push(await this.interruptUnfinishedCheckpoint(checkpoint, incident));
    const entries = this.canonicalSink.listRecoveryIncidentEntries(incident.id).map((entry) => ({
      ...entry,
      durationMs: this.durationMs(entry.startedAt, entry.interruptedAt),
    }));
    this.currentIncident = entries.length > 0 ? { ...incident, entries } : null;
    return { interrupted };
  }

  private async reopenMaterializableTerminalCheckpoints(): Promise<void> {
    for (const checkpoint of this.canonicalSink.listUnmaterializedTerminalCheckpoints()) {
      const hasChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId).length > 0;
      const hasNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId).length > 0;
      if (hasChunks || hasNarrative) await this.reopenTerminalCheckpoint(checkpoint.executionId);
    }
  }

  private async reopenTerminalCheckpoint(executionId: string): Promise<void> {
    if (!await this.canonicalSink.reopenUnmaterializedTerminalCheckpoint(executionId)) {
      throw new Error(`Unmaterialized terminal checkpoint was not recoverable: ${executionId}`);
    }
  }

  private async interruptUnfinishedCheckpoint(
    checkpoint: ReturnType<CanonicalAgentBoundary["listUnfinishedCheckpoints"]>[number],
    incident: { id: string; createdAt: string },
  ): Promise<string> {
    const chunkCount = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId).length;
    await this.canonicalSink.interruptUnfinishedExecution({
      threadId: checkpoint.threadId, turnId: checkpoint.turnId, executionId: checkpoint.executionId,
      reason: UNPROVED_EXECUTION_REASON, recoveryIncidentId: incident.id, endedAt: incident.createdAt,
    });
    if (chunkCount > 0 && !await this.parentAssistantTextCheckpoints.retire(checkpoint.executionId)) {
      throw new Error(`Recovered assistant text checkpoint was not retired: ${checkpoint.executionId}`);
    }
    return checkpoint.executionId;
  }

  /** Read unresolved entries from the incident created by this server startup. */
  currentRecoveryIncident(): RecoveryIncident | null {
    return this.currentIncident;
  }

  private durationMs(startedAt: string, interruptedAt: string): number {
    const durationMs = Date.parse(interruptedAt) - Date.parse(startedAt);
    if (!Number.isFinite(durationMs)) {
      throw new Error(`Recovery incident has invalid turn timestamps: ${startedAt}, ${interruptedAt}`);
    }
    return Math.max(0, durationMs);
  }

  /** Dispatch an interrupted turn's accepted user input as a new provider execution. */
  async retry(
    executionId: string,
    dispatch: (command: SendMessageCommand) => Promise<void>,
  ): Promise<void> {
    if (!this.currentIncident?.entries.some((entry) => entry.executionId === executionId)) {
      throw new Error(`Recovery incident entry not found: ${executionId}`);
    }
    const checkpoint = this.canonicalSink.loadCheckpoint(executionId);
    if (!checkpoint || checkpoint.phase !== "interrupted") {
      throw new Error(`Recoverable execution not found: ${executionId}`);
    }
    const message = this.canonicalSink.loadUserMessage(checkpoint.turnId);
    if (!message) throw new Error(`Accepted user input not found: ${executionId}`);
    const thread = this.threadRepo.findById(checkpoint.threadId);
    if (!thread || !["interrupted", "errored"].includes(thread.status)) {
      throw new Error(`Recoverable thread not found: ${checkpoint.threadId}`);
    }
    const attachments = this.attachmentService.prepareRetryAttachments(thread.id, message.attachments ?? []);
    await dispatch(this.retryCommand(thread, message, attachments, executionId));
    this.consumeRecoveryIncidentEntry(executionId);
  }

  private consumeRecoveryIncidentEntry(executionId: string): void {
    if (!this.currentIncident) return;
    const entries = this.currentIncident.entries.filter((entry) => entry.executionId !== executionId);
    this.currentIncident = entries.length > 0 ? { ...this.currentIncident, entries } : null;
  }

  private retryCommand(
    thread: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    message: NonNullable<ReturnType<CanonicalAgentBoundary["loadUserMessage"]>>,
    attachments: ReturnType<AttachmentService["prepareRetryAttachments"]>,
    executionId: string,
  ): SendMessageCommand {
    return {
      threadId: thread.id,
      content: message.content,
      model: this.optionalValue(thread.model),
      permissionMode: this.optionalValue(thread.permission_mode),
      attachments,
      reasoningLevel: this.optionalValue(thread.reasoning_level),
      provider: thread.provider as SendMessageCommand["provider"],
      interactionMode: this.optionalValue(thread.interaction_mode),
      orchestrationMode: this.optionalValue(thread.orchestration_mode),
      copilotAgent: this.optionalValue(thread.copilot_agent),
      contextWindow: this.optionalValue(thread.context_window_mode),
      thinking: this.optionalValue(thread.thinking),
      codexFastMode: this.optionalValue(thread.codex_fast_mode),
      devinMode: this.optionalValue(thread.devin_mode),
      replyToMessageId: this.optionalValue(message.reply_to_message_id),
      quotedText: this.optionalValue(message.quoted_text),
      mentions: this.optionalValue(message.mentions),
      previewAnnotations: this.optionalValue(message.previewAnnotations),
      forceFreshSession: true,
      retryOfExecutionId: executionId,
    };
  }

  private optionalValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }
}
