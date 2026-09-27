import type { ParentNarrativeRecoveryItem, StoredAttachment, TurnOutcome } from "@mcode/contracts";

import type { DataOnlyParentTerminalProjectionInput } from "../canonical/canonical-parent-turn-write.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import { AssistantExecutionState } from "./assistant-execution-state.js";
import { deriveTurnAssistantMessageId } from "./turn-assistant-message-id.js";

/** The mailbox identifies one turn; the current message anchor arrives at projection time. */
export interface CodexParentMessageProjectionInput {
  readonly execution: ExecutionIdentity;
  readonly turnKind: "ordinary" | "plan";
}

/** Public fields attached to a provider message before it reaches the renderer. */
export interface ProjectedCodexParentMessage {
  readonly messageId: string;
  readonly model: string | null;
  readonly attachments?: readonly StoredAttachment[];
}

/** Cloneable terminal data, including the public ID the writer must persist. */
export interface ProjectedCodexParentTerminal extends DataOnlyParentTerminalProjectionInput {
  readonly assistant: DataOnlyParentTerminalProjectionInput["assistant"] & { readonly messageId: string };
  readonly fromProvider: boolean;
}

/** Keeps the assistant projection for one Codex parent execution off the server loop. */
export class CodexParentMessageProjection {
  private readonly execution: ExecutionIdentity;
  private messageId: string | undefined;
  private readonly assistant = new AssistantExecutionState();

  constructor(input: CodexParentMessageProjectionInput) {
    if (input.turnKind === "plan") {
      throw new Error("Codex plan output needs early assistant materialization and is not supported by this projection");
    }
    this.execution = structuredClone(input.execution);
  }

  /** Record final response text that can become an assistant body if no provider message arrives. */
  appendFinalResponseText(execution: ExecutionIdentity, delta: string): void {
    this.assertExecution(execution);
    this.assistant.appendStreamingText(delta);
  }

  /** Buffer a generated attachment with the same ID replacement order as the live finalizer. */
  bufferGeneratedAttachment(execution: ExecutionIdentity, attachment: StoredAttachment): void {
    this.assertExecution(execution);
    this.assistant.bufferAttachments([structuredClone(attachment)]);
  }

  /** Buffer a normal provider body and return exactly the public fields of the live message path. */
  projectMessage(input: {
    readonly execution: ExecutionIdentity;
    readonly content: string;
    readonly model: string | null;
    readonly precedingMessageId: string;
    readonly postTurnGoalReceipt: boolean;
  }): ProjectedCodexParentMessage {
    this.assertExecution(input.execution);
    if (input.postTurnGoalReceipt) {
      throw new Error("Post-turn goal receipts need a separate persisted message and are not supported by this projection");
    }
    const messageId = this.deriveMessageId(input.precedingMessageId);
    const attachments = structuredClone(this.assistant.getBufferedAttachments());
    this.assistant.bufferBody(input.content, input.model, attachments);
    this.assistant.resetStreamingText();
    this.messageId = messageId;
    return {
      messageId,
      model: input.model,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /** Produce terminal data for a future single-writer mutation without reading or writing SQLite. */
  projectTerminal(input: {
    readonly execution: ExecutionIdentity;
    readonly outcome: TurnOutcome;
    readonly endedAt: string;
    readonly fallbackModel: string | null;
    readonly precedingMessageId?: string;
    readonly narrative: readonly ParentNarrativeRecoveryItem[];
  }): ProjectedCodexParentTerminal {
    this.assertExecution(input.execution);
    // A notice can change the last visible row after publication. Keep the
    // published ID; only a text-only fallback derives its ID at terminal time.
    const messageId = this.messageId ?? this.deriveMessageId(input.precedingMessageId);
    const assistant = this.assistant.materializationInput(input.fallbackModel);
    return {
      threadId: this.execution.threadId,
      executionId: this.execution.executionId,
      outcome: input.outcome,
      endedAt: input.endedAt,
      fromProvider: assistant.fromProvider,
      assistant: {
        messageId,
        content: assistant.content,
        model: assistant.model,
        attachments: structuredClone(assistant.attachments),
      },
      narrative: structuredClone(input.narrative),
    };
  }

  private assertExecution(execution: ExecutionIdentity): void {
    if (execution.threadId !== this.execution.threadId || execution.turnId !== this.execution.turnId
      || execution.executionId !== this.execution.executionId) {
      throw new Error(`Stale Codex parent message projection command: ${execution.executionId}`);
    }
  }

  private deriveMessageId(precedingMessageId: string | undefined): string {
    if (!precedingMessageId) throw new Error("Codex parent projection needs the current preceding message ID");
    return deriveTurnAssistantMessageId(this.execution.threadId, precedingMessageId);
  }
}
