import { sql } from "drizzle-orm";
import { messages } from "../../../../runtime/persistence/sqlite/schema.js";

/** Session notices are excluded from conversation history and provider context. */
export const notSessionNotice = sql`json_extract(${messages.systemNotice}, '$.scope') IS NOT 'session'`;
const notRoutineTranscriptNotice = sql`COALESCE(json_extract(${messages.systemNotice}, '$.kind'), '') NOT IN ('warning', 'configuration', 'deprecation', 'authentication-recovered')`;

/** Display pages and attention sequence anchors must exclude the same hidden rows. */
export const transcriptMessageVisibility = sql`${messages.isInternal} = 0 AND ${notSessionNotice} AND ${notRoutineTranscriptNotice}`;
