import { THREAD_GET_TRANSCRIPT_MAX_BYTES, type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { recoveredNarrativeWriteOperation } from "../narrative/persistence/recovered-narrative-write-operation.js";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { MessageStore } from "./message-store.js";
import { messageWriteOperations } from "./message-write-operations.js";
export type { ThreadControlMessageRecord, ThreadHistoryBudget, BudgetedThreadMessages, BudgetedThreadMessageOptions } from "./message-store.js";

/** Read-only queries and committed mutations for MessageRepo. */
@injectable()
export class MessageRepo {
  private readonly reader: MessageStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new MessageStore(db);
  }

  /** Commit the complete recovered detail projection against its owning assistant message. */
  persistRecoveredNarrative(messageId: string, items: readonly ParentNarrativeRecoveryItem[], replaceExisting = false): Promise<void> {
    return this.writer.execute(recoveredNarrativeWriteOperation, [messageId, [...items], replaceExisting]);
  }

  create(threadId: Parameters<MessageStore["create"]>[0], role: Parameters<MessageStore["create"]>[1], content: Parameters<MessageStore["create"]>[2], sequence: Parameters<MessageStore["create"]>[3], attachments?: Parameters<MessageStore["create"]>[4], replyToMessageId?: Parameters<MessageStore["create"]>[5], quotedText?: Parameters<MessageStore["create"]>[6], model?: Parameters<MessageStore["create"]>[7], isInternal?: Parameters<MessageStore["create"]>[8], mentions?: Parameters<MessageStore["create"]>[9], previewAnnotations?: Parameters<MessageStore["create"]>[10], origin: Parameters<MessageStore["create"]>[11] = { type: "composer" }, messageId?: Parameters<MessageStore["create"]>[12], selectedTextComments?: Parameters<MessageStore["create"]>[13], systemNotice?: Parameters<MessageStore["create"]>[14]): Promise<ReturnType<MessageStore["create"]>> {
    return this.writer.execute(messageWriteOperations.create, [threadId, role, content, sequence, attachments, replyToMessageId, quotedText, model, isInternal, mentions, previewAnnotations, origin, messageId, selectedTextComments, systemNotice]);
  }

  createSystemNotice(threadId: Parameters<MessageStore["createSystemNotice"]>[0], content: Parameters<MessageStore["createSystemNotice"]>[1], sequence: Parameters<MessageStore["createSystemNotice"]>[2], systemNotice: Parameters<MessageStore["createSystemNotice"]>[3]): Promise<ReturnType<MessageStore["createSystemNotice"]>> {
    return this.writer.execute(messageWriteOperations.createSystemNotice, [threadId, content, sequence, systemNotice]);
  }

  beginNoticeSession(threadId: Parameters<MessageStore["beginNoticeSession"]>[0], sessionId: Parameters<MessageStore["beginNoticeSession"]>[1]): Promise<ReturnType<MessageStore["beginNoticeSession"]>> {
    return this.writer.execute(messageWriteOperations.beginNoticeSession, [threadId, sessionId]);
  }

  listSessionNotices(threadId: Parameters<MessageStore["listSessionNotices"]>[0]): ReturnType<MessageStore["listSessionNotices"]> {
    return this.reader.listSessionNotices(threadId);
  }

  createAssistantIdempotent(input: Parameters<MessageStore["createAssistantIdempotent"]>[0]): Promise<ReturnType<MessageStore["createAssistantIdempotent"]>> {
    return this.writer.execute(messageWriteOperations.createAssistantIdempotent, [input]);
  }

  setAssistantOutcome(messageId: Parameters<MessageStore["setAssistantOutcome"]>[0], outcome: Parameters<MessageStore["setAssistantOutcome"]>[1], executionId?: Parameters<MessageStore["setAssistantOutcome"]>[2]): Promise<ReturnType<MessageStore["setAssistantOutcome"]>> {
    return this.writer.execute(messageWriteOperations.setAssistantOutcome, [messageId, outcome, executionId]);
  }

  publishAssistant(messageId: Parameters<MessageStore["publishAssistant"]>[0]): Promise<ReturnType<MessageStore["publishAssistant"]>> {
    return this.writer.execute(messageWriteOperations.publishAssistant, [messageId]);
  }

  getLatestSequenceIncludingInternal(threadId: Parameters<MessageStore["getLatestSequenceIncludingInternal"]>[0]): ReturnType<MessageStore["getLatestSequenceIncludingInternal"]> {
    return this.reader.getLatestSequenceIncludingInternal(threadId);
  }

  isLatestNonSystemMessage(threadId: Parameters<MessageStore["isLatestNonSystemMessage"]>[0], messageId: Parameters<MessageStore["isLatestNonSystemMessage"]>[1]): ReturnType<MessageStore["isLatestNonSystemMessage"]> {
    return this.reader.isLatestNonSystemMessage(threadId, messageId);
  }

  appendAttachments(messageId: Parameters<MessageStore["appendAttachments"]>[0], attachments: Parameters<MessageStore["appendAttachments"]>[1]): Promise<ReturnType<MessageStore["appendAttachments"]>> {
    return this.writer.execute(messageWriteOperations.appendAttachments, [messageId, attachments]);
  }

  listByThread(threadId: Parameters<MessageStore["listByThread"]>[0], limit: Parameters<MessageStore["listByThread"]>[1], before?: Parameters<MessageStore["listByThread"]>[2]): ReturnType<MessageStore["listByThread"]> {
    return this.reader.listByThread(threadId, limit, before);
  }

  listByThreadAfter(threadId: Parameters<MessageStore["listByThreadAfter"]>[0], limit: Parameters<MessageStore["listByThreadAfter"]>[1], after: Parameters<MessageStore["listByThreadAfter"]>[2]): ReturnType<MessageStore["listByThreadAfter"]> {
    return this.reader.listByThreadAfter(threadId, limit, after);
  }

  listByThreadForThreadControl(threadId: Parameters<MessageStore["listByThreadForThreadControl"]>[0], limit: Parameters<MessageStore["listByThreadForThreadControl"]>[1], maxBytes: Parameters<MessageStore["listByThreadForThreadControl"]>[2] = THREAD_GET_TRANSCRIPT_MAX_BYTES): ReturnType<MessageStore["listByThreadForThreadControl"]> {
    return this.reader.listByThreadForThreadControl(threadId, limit, maxBytes);
  }

  listByThreadUpToSequence(threadId: Parameters<MessageStore["listByThreadUpToSequence"]>[0], maxSequence: Parameters<MessageStore["listByThreadUpToSequence"]>[1]): ReturnType<MessageStore["listByThreadUpToSequence"]> {
    return this.reader.listByThreadUpToSequence(threadId, maxSequence);
  }

  listByThreadUpToSequenceBudgeted(threadId: Parameters<MessageStore["listByThreadUpToSequenceBudgeted"]>[0], maxSequence: Parameters<MessageStore["listByThreadUpToSequenceBudgeted"]>[1], options: Parameters<MessageStore["listByThreadUpToSequenceBudgeted"]>[2]): ReturnType<MessageStore["listByThreadUpToSequenceBudgeted"]> {
    return this.reader.listByThreadUpToSequenceBudgeted(threadId, maxSequence, options);
  }

  findByIdInThread(threadId: Parameters<MessageStore["findByIdInThread"]>[0], messageId: Parameters<MessageStore["findByIdInThread"]>[1]): ReturnType<MessageStore["findByIdInThread"]> {
    return this.reader.findByIdInThread(threadId, messageId);
  }

  findByIdInThreadIncludingInternal(threadId: Parameters<MessageStore["findByIdInThreadIncludingInternal"]>[0], messageId: Parameters<MessageStore["findByIdInThreadIncludingInternal"]>[1]): ReturnType<MessageStore["findByIdInThreadIncludingInternal"]> {
    return this.reader.findByIdInThreadIncludingInternal(threadId, messageId);
  }

  findById(id: Parameters<MessageStore["findById"]>[0]): ReturnType<MessageStore["findById"]> {
    return this.reader.findById(id);
  }

  listIncludingInternal(threadId: Parameters<MessageStore["listIncludingInternal"]>[0]): ReturnType<MessageStore["listIncludingInternal"]> {
    return this.reader.listIncludingInternal(threadId);
  }
}
