import type { HandoffMessageRow, HandoffSourceItem } from "./types.js";

function parseArray(value: string | null): unknown[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function toolLine(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = firstText(value.name, value.tool_name);
  if (!name) return null;
  const input = isRecord(value.input) ? value.input : {};
  const detail = firstText(input.command, input.file_path, input.path, value.command, value.path, value.input_summary);
  const line = detail ? `${name}: ${detail}` : name;
  return Array.from(line.replace(/[\r\n\u2028\u2029]+/g, " ")).slice(0, 200).join("");
}

function filePath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return firstText(value.path);
  return undefined;
}

function toolActivity(row: HandoffMessageRow): string {
  const lines: string[] = [];
  for (const tool of parseArray(row.tool_calls)) {
    const line = toolLine(tool);
    if (line !== null) lines.push(line);
  }
  const paths = parseArray(row.files_changed).map(filePath).filter((path) => path !== undefined);
  if (paths.length > 0) {
    lines.push(`Files changed: ${paths.join(", ").replace(/[\r\n\u2028\u2029]+/g, " ")}`);
  }
  return lines.join("\n");
}

/** Extract verbatim messages, bounded tool summaries, and the current plan. */
export function handoffItemsFromMessages(rows: readonly HandoffMessageRow[], plan: string | null): HandoffSourceItem[] {
  const items: HandoffSourceItem[] = [];
  for (const row of rows) {
    if (row.is_internal === 1 || (row.role !== "user" && row.role !== "assistant")) continue;
    const message: HandoffSourceItem = {
      sequence: row.sequence,
      role: row.role,
      kind: "message",
      provider: row.provider,
      text: row.content,
    };
    items.push(message);
    if (row.role !== "assistant") continue;
    const activity = toolActivity(row);
    if (activity.length > 0) items.push({ ...message, kind: "tool_activity", text: activity });
  }
  if (plan !== null && plan.length > 0) {
    items.push({ sequence: null, role: "assistant", kind: "plan", provider: null, text: plan });
  }
  return items;
}
