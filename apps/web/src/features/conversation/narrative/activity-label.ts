import type { ToolCall } from "@/transport/types";
import { isShellTool, resolveToolName, TOOL_PHASE_LABELS } from "@/components/chat/tool-renderers/constants";
import { stripPlanFences } from "@/lib/plan-fences";
import { extractNarrativeCommand } from "./extract-narrative-command";
import type { ThoughtSegment } from "./types";

const LABEL_LIMIT = 120;

function shortLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, 1024).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  // The status line fades overflow, so a hard cut reads cleaner than an ellipsis.
  return text.slice(0, LABEL_LIMIT);
}

/** A hidden plan's headings must not surface as the live label; the cheap check skips the scan for ordinary prose. */
function withoutHiddenPlan(text: string): string {
  return text.includes("plan") ? stripPlanFences(text, true) : text;
}

/** Extracts a complete Markdown heading from the current open narration segment. */
export function currentActivityHeading(segments: readonly ThoughtSegment[]): string | undefined {
  const current = segments.at(-1);
  if (!current || current.endedAt !== undefined) return undefined;
  const text = withoutHiddenPlan(current.text);
  // Bound work on long streams and exclude a cut-off first line.
  const tail = text.slice(-4096);
  const lines = tail.split("\n");
  if (text.length > tail.length) lines.shift();
  let heading: string | undefined;
  for (const [index, line] of lines.entries()) {
    const bold = line.match(/^\s*\*\*([^*]+)\*\*\s*$/);
    const markdown = index < lines.length - 1 ? line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/) : null;
    const candidate = shortLabel(bold?.[1] ?? markdown?.[1]);
    if (candidate) heading = candidate;
  }
  return heading;
}

/** Live recovered tool calls keep only the server's input summary, which for file tools is the bare path. */
function filePath(tool: ToolCall): unknown {
  return tool.toolInput.file_path ?? tool.toolInput.path ?? tool.toolInput._summary;
}

function fileActivity(tool: ToolCall, name: string): string | undefined {
  const verbs: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing" };
  const verb = verbs[name];
  const path = filePath(tool);
  if (!verb || typeof path !== "string") return undefined;
  const file = shortLabel(path.split(/[\\/]/).at(-1));
  return file ? shortLabel(`${verb} ${file}`) : undefined;
}

/**
 * Shells read the command itself for every provider, so all providers word the same action alike.
 * Live recovered calls carry only the server's `_summary`, so this shares the shell row's extraction.
 */
function shellActivity(tool: ToolCall): string {
  const command = shortLabel(extractNarrativeCommand(tool));
  return shortLabel(command && `Running ${command}`) ?? "Running command";
}

/** Status line label for one running tool call. */
export function toolActivityLabel(tool: ToolCall): string {
  if (isShellTool(tool.toolName)) return shellActivity(tool);
  const name = resolveToolName(tool.toolName);
  return fileActivity(tool, name)
    ?? shortLabel(tool.toolInput.description)
    ?? TOOL_PHASE_LABELS[name]
    ?? (name === "file_change" ? "Editing files" : "Working");
}
