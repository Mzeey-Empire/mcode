import { z } from "zod";
import {
  MessageSchema, MessageRoleSchema, MessageMentionsSchema, PreviewAnnotationBundleSchema,
  SelectedTextCommentsSchema, StoredAttachmentSchema, SystemNoticeMetadataSchema, TurnOutcomeSchema,
} from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const origin = z.discriminatedUnion("type", [
  z.object({ type: z.literal("composer") }).strict(),
  z.object({ type: z.literal("thread"), sourceThreadId: z.string(), sourceTurnId: z.string(), sourceProviderId: z.string() }).strict(),
]);
const attachments = z.array(StoredAttachmentSchema());
const assistantInput = z.object({
  id: z.string(), threadId: z.string(), content: z.string(), sequence: z.number().int(),
  model: z.string().nullable().optional(), provider: z.string().nullable().optional(),
  attachments: attachments.optional(), mentions: MessageMentionsSchema().optional(), isInternal: z.boolean().optional(),
}).strict();

/** Message writes admitted to the shared database owner. */
export const messageWriteOperations = {
  create: databaseWriteOperation("message.create", z.tuple([
    z.string(), MessageRoleSchema, z.string(), z.number().int(), attachments.optional(),
    z.string().optional(), z.string().optional(), z.string().nullable().optional(), z.boolean().optional(),
    MessageMentionsSchema().optional(), PreviewAnnotationBundleSchema().optional(), origin.optional(),
    z.string().optional(), SelectedTextCommentsSchema().optional(), SystemNoticeMetadataSchema().optional(),
  ]), MessageSchema()),
  createSystemNotice: databaseWriteOperation("message.createSystemNotice", z.tuple([
    z.string(), z.string(), z.number().int(), SystemNoticeMetadataSchema().optional(),
  ]), MessageSchema()),
  beginNoticeSession: databaseWriteOperation("message.beginNoticeSession", z.tuple([z.string(), z.string().optional()]), z.void()),
  createAssistantIdempotent: databaseWriteOperation("message.createAssistantIdempotent", z.tuple([assistantInput]), MessageSchema()),
  setAssistantOutcome: databaseWriteOperation("message.setAssistantOutcome", z.tuple([z.string(), TurnOutcomeSchema, z.string().optional()]), z.void()),
  publishAssistant: databaseWriteOperation("message.publishAssistant", z.tuple([z.string()]), z.void()),
  appendAttachments: databaseWriteOperation("message.appendAttachments", z.tuple([z.string(), attachments]), attachments),
};
