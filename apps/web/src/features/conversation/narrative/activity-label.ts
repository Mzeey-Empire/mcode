import type { ToolCall } from "@/transport/types";
import { resolveToolName, TOOL_PHASE_LABELS } from "@/components/chat/tool-renderers/constants";
import type { ThoughtSegment } from "./types";

const LABEL_LIMIT = 120;

function shortLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, 1024).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
}

/** Extracts a complete Markdown heading from the current open narration segment. */
export function currentActivityHeading(segments: readonly ThoughtSegment[]): string | undefined {
  const current = segments.at(-1);
  if (!current || current.endedAt !== undefined) return undefined;
  // Bound work on long streams and exclude a cut-off first line.
  const tail = current.text.slice(-4096);
  const lines = tail.split("\n");
  if (current.text.length > tail.length) lines.shift();
  let heading: string | undefined;
  for (const [index, line] of lines.entries()) {
    const bold = line.match(/^\s*\*\*([^*]+)\*\*\s*$/);
    const markdown = index < lines.length - 1 ? line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/) : null;
    const candidate = shortLabel(bold?.[1] ?? markdown?.[1]);
    if (candidate) heading = candidate;
  }
  return heading;
}

function fileActivity(tool: ToolCall, name: string): string | undefined {
  const verbs: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing" };
  const verb = verbs[name];
  const path = tool.toolInput.file_path ?? tool.toolInput.path;
  if (!verb || typeof path !== "string") return undefined;
  const file = shortLabel(path.split(/[\\/]/).at(-1));
  return file ? shortLabel(`${verb} ${file}`) : undefined;
}

/** Selects active tool detail, then a current summary heading, then an honest fallback. */
export function narrativeActivityLabel(tools: readonly ToolCall[], summaryHeading?: string): string {
  const active = tools.filter((tool) => !tool.isComplete && tool.parentToolCallId == null).at(-1);
  if (!active) return shortLabel(summaryHeading) ?? "Thinking...";
  const name = resolveToolName(active.toolName);
  return shortLabel(active.toolInput.description)
    ?? fileActivity(active, name)
    ?? TOOL_PHASE_LABELS[name]
    ?? (name === "file_change" ? "Editing files..." : "Working...");
}
