import type { HandoffMessageInput, HandoffSourceItem } from "./types.js";

// Claude preserves SDK names, Cursor normalizes ACP/stream tools, and Codex
// emits command_execution/file_change or a native function name.
const EDIT_AND_COMMAND_TOOLS = new Set([
  "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "Delete",
  "command_execution", "file_change", "apply_patch",
  "exec_command", "shell_command", "shell",
  "create", "delete", "edit", "move", "remove", "rename",
]);

function boundedLine(text: string): string {
  return Array.from(text.replace(/[\r\n\u2028\u2029]+/g, " ")).slice(0, 200).join("");
}

function assistantActivityItems(row: HandoffMessageInput, message: HandoffSourceItem): HandoffSourceItem[] {
  const items: HandoffSourceItem[] = [];
  for (const tool of row.tools) {
    if (!EDIT_AND_COMMAND_TOOLS.has(tool.toolName)) continue;
    const text = boundedLine(`${tool.toolName}: ${tool.inputSummary}`);
    items.push({ ...message, kind: "tool_call", text });
  }
  if (row.filesChanged.length > 0) {
    const text = boundedLine(`Files changed: ${row.filesChanged.join(", ")}`);
    items.push({ ...message, kind: "files_changed", text });
  }
  return items;
}

/** Extract verbatim messages, bounded tool summaries, and the current plan. */
export function handoffItemsFromMessages(rows: readonly HandoffMessageInput[], plan: string | null): HandoffSourceItem[] {
  const items: HandoffSourceItem[] = [];
  for (const row of rows) {
    if (row.isInternal || (row.role !== "user" && row.role !== "assistant")) continue;
    const message: HandoffSourceItem = {
      sequence: row.sequence,
      role: row.role,
      kind: "message",
      provider: row.provider,
      text: row.content,
    };
    items.push(message);
    if (row.role === "assistant") items.push(...assistantActivityItems(row, message));
  }
  if (plan !== null && plan.length > 0) {
    items.push({ sequence: null, role: "assistant", kind: "plan", provider: null, text: plan });
  }
  return items;
}
