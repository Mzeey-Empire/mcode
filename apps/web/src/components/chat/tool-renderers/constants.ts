import type { LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  FileText, FilePen, FolderSearch, Globe,
  Pencil, Search, Terminal, Wrench,
} from "lucide-react";
import { StackedLayersIcon } from "../narrative/StackedLayersIcon";

/** Accepts both Lucide icons and plain SVG function components. */
export type IconComponent = LucideIcon | ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export const TOOL_LABELS: Record<string, string> = {
  Glob: "Listed directory",
  Read: "Read file",
  Edit: "Edited file",
  Write: "Created file",
  Bash: "Ran command",
  Grep: "Searched files",
  Agent: "Delegated task",
  WebSearch: "Searched web",
  WebFetch: "Fetched page",
};

export const TOOL_ICONS: Record<string, IconComponent> = {
  Glob: FolderSearch,
  Grep: Search,
  Read: FileText,
  Write: FilePen,
  Edit: Pencil,
  Bash: Terminal,
  Agent: StackedLayersIcon,
  WebSearch: Globe,
  WebFetch: Globe,
};

export const DEFAULT_ICON: IconComponent = Wrench;

/** Provider-specific shell tool names normalized to `Bash`. */
const SHELL_TOOL_ALIASES: Record<string, "Bash"> = {
  Shell: "Bash",
  Terminal: "Bash",
  command_execution: "Bash",
};

/**
 * Maps provider-specific shell tool names to the canonical `Bash` label/icon set.
 */
export function resolveToolName(toolName: string): string {
  return SHELL_TOOL_ALIASES[toolName] ?? toolName;
}

/** Returns true when the tool is a shell/command execution (any provider alias). */
export function isShellTool(toolName: string): boolean {
  return resolveToolName(toolName) === "Bash";
}

/** Present-tense phase labels shown in the streaming indicator. */
export const TOOL_PHASE_LABELS: Record<string, string> = {
  Glob: "Searching the codebase...",
  Grep: "Searching the codebase...",
  Read: "Reading files...",
  Edit: "Making changes...",
  Write: "Making changes...",
  Bash: "Running a command...",
  Agent: "Thinking deeper...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching a page...",
};

/** Singular/plural labels for tool summary text generation. */
export const TOOL_SUMMARY_VERBS: Record<string, [string, string]> = {
  Read: ["Read %d file", "Read %d files"],
  Glob: ["Listed %d directory", "Listed %d directories"],
  Grep: ["%d search", "%d searches"],
  Edit: ["Edited %d file", "Edited %d files"],
  Write: ["Created %d file", "Created %d files"],
  Bash: ["Ran %d command", "Ran %d commands"],
  WebSearch: ["%d web search", "%d web searches"],
  WebFetch: ["Fetched %d page", "Fetched %d pages"],
};

/**
 * Generate a summary string from a group of tool calls.
 * Example: "Read 3 files, 1 search"
 */
export function buildToolSummaryText(calls: readonly { toolName: string }[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const name = resolveToolName(c.toolName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    const verbs = TOOL_SUMMARY_VERBS[name];
    if (verbs) {
      const template = count === 1 ? verbs[0] : verbs[1];
      parts.push(template.replace("%d", String(count)));
    } else {
      parts.push(`${count} ${name.toLowerCase()}${count > 1 ? "s" : ""}`);
    }
  }
  return parts.join(", ");
}
