/**
 * @internal
 * Parent-link extraction shared by Cursor's stream-json and ACP mappers.
 *
 * Subagent detection itself lives in `isCursorTaskAcpTool`. Only Cursor's Task tool
 * spawns a subagent, so explore and browser calls keep their ordinary tool names.
 */

/**
 * Reads an optional parent tool call id from Cursor payloads.
 * Field names vary across stream-json and ACP SDK revisions.
 *
 * @param source - ACP `session/update` object or stream-json line object.
 */
export function extractCursorParentToolCallId(source: Record<string, unknown>): string | undefined {
  const keys = [
    "parentToolCallId",
    "parent_tool_call_id",
    "parentCallId",
    "parent_call_id",
    "parentId",
  ] as const;
  for (const key of keys) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
