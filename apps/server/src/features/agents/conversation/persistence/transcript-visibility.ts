import { sql } from "drizzle-orm";
import { BACKGROUND_RESTART_NOTICE_KEY_PREFIX } from "@mcode/shared/planned-restart";
import { messages } from "../../../../runtime/persistence/sqlite/schema.js";

/** Session notices are excluded from conversation history and provider context. */
export const notSessionNotice = sql`json_extract(${messages.systemNotice}, '$.scope') IS NOT 'session'`;
const noticeKind = sql`COALESCE(json_extract(${messages.systemNotice}, '$.kind'), '')`;
const notRoutineTranscriptNotice = sql`(
  ${noticeKind} NOT IN ('warning', 'configuration', 'deprecation', 'authentication-recovered')
  OR (${noticeKind} = 'warning' AND json_extract(${messages.systemNotice}, '$.noticeKey') LIKE ${`${BACKGROUND_RESTART_NOTICE_KEY_PREFIX}%`})
)`;

/** Display pages and attention sequence anchors must exclude the same hidden rows. */
export const transcriptMessageVisibility = sql`${messages.isInternal} = 0 AND ${notSessionNotice} AND ${notRoutineTranscriptNotice}`;
