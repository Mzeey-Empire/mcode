import { formatModelLabel } from "@/lib/format-model-label";
import type { ToolCall } from "@/transport/types";

/**
 * Labels for Cursor `subagentType` objects on Task delegations.
 * Unknown shapes are omitted so we do not show noisy JSON in the UI.
 */
function formatSubagentTypeLabel(subagentType: unknown): string | undefined {
  if (subagentType == null || typeof subagentType !== "object") return undefined;
  const rec = subagentType as Record<string, unknown>;
  if ("custom" in rec && rec.custom != null && typeof rec.custom === "object") {
    const custom = rec.custom as Record<string, unknown>;
    if ("unspecified" in custom) return "Task";
    const keys = Object.keys(custom);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

/**
 * Builds short delegation tags for a sub-agent row (task kind and model).
 *
 * @param toolCall - Agent tool call with `cursor/task` metadata in `toolInput`.
 */
export function buildDelegationTags(toolCall: ToolCall): string[] {
  const tags: string[] = [];
  const input = toolCall.toolInput;

  const typeLabel = formatSubagentTypeLabel(input.subagentType);
  if (typeLabel) tags.push(typeLabel);

  if (typeof input.model === "string" && input.model.trim().length > 0) {
    tags.push(formatModelLabel(input.model.trim()));
  }

  return tags;
}
