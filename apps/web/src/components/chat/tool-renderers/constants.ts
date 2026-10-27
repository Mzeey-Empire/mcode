import type { LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  CircleSlash, FileText, FilePen, FolderSearch, Globe,
  ListChecks, Pencil, Search, Terminal, Wrench,
} from "lucide-react";
import { stripMcodeMcpPrefix } from "@mcode/contracts/models/subagent-roster";
import { StackedLayersIcon } from "@/components/ui/StackedLayersIcon";

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
  browser_open: "Opened page",
  browser_inspect: "Inspected page",
  browser_act: "Acted on page",
  browser_tabs: "Updated Browser tabs",
  browser_evaluate: "Evaluated page",
  delegate_task: "Delegate task",
  task_status: "Check task",
  task_cancel: "Cancel task",
  workspace_search: "Searched projects",
  worktree_list: "Listed worktrees",
  thread_target_list: "Listed targets",
  thread_launch: "Launched thread",
  thread_search: "Searched threads",
  thread_get: "Read thread",
  thread_send: "Sent to thread",
  thread_stop: "Stopped thread",
  thread_wait: "Waited on threads",
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
  browser_open: Globe,
  browser_inspect: Globe,
  browser_act: Globe,
  browser_tabs: Globe,
  browser_evaluate: Globe,
  delegate_task: StackedLayersIcon,
  task_status: ListChecks,
  task_cancel: CircleSlash,
  thread_launch: StackedLayersIcon,
};

export const DEFAULT_ICON: IconComponent = Wrench;

/** Provider-specific shell tool names normalized to `Bash`. */
const SHELL_TOOL_ALIASES: Record<string, "Bash"> = {
  PowerShell: "Bash",
  Shell: "Bash",
  Terminal: "Bash",
  command_execution: "Bash",
};

/**
 * Provider file-edit tool names normalized to `Edit` so edits get the pencil.
 * Codex reports `file_change` items and `apply_patch` calls; Cursor ACP edit
 * kinds already arrive as `Edit`.
 */
const EDIT_TOOL_ALIASES: Record<string, "Edit"> = {
  file_change: "Edit",
  fileChange: "Edit",
  apply_patch: "Edit",
};

/**
 * Maps provider-specific shell, edit, browser, and Mcode MCP tool names to the canonical label/icon set.
 */
export function resolveToolName(toolName: string): string {
  const browserTool = toolName.match(/(?:^|__)(browser_[a-z_]+)$/)?.[1];
  return SHELL_TOOL_ALIASES[toolName] ?? EDIT_TOOL_ALIASES[toolName] ?? browserTool ?? stripMcodeMcpPrefix(toolName);
}

/** Plain label for a tool name, falling back to the name without its Mcode MCP prefix. */
export function toolDisplayLabel(toolName: string): string {
  const canonicalName = resolveToolName(toolName);
  return TOOL_LABELS[canonicalName] ?? canonicalName;
}

/** Returns true when the tool is a shell/command execution (any provider alias). */
export function isShellTool(toolName: string): boolean {
  return resolveToolName(toolName) === "Bash";
}

/** Present-tense phase labels shown in the streaming indicator. */
export const TOOL_PHASE_LABELS: Record<string, string> = {
  Glob: "Searching the codebase",
  Grep: "Searching the codebase",
  Read: "Reading files",
  Edit: "Making changes",
  Write: "Making changes",
  Bash: "Running a command",
  WebSearch: "Searching the web",
  WebFetch: "Fetching a page",
  browser_open: "Opening a page",
  browser_inspect: "Inspecting the page",
  browser_act: "Acting on the page",
  browser_tabs: "Updating Browser tabs",
  browser_evaluate: "Evaluating the page",
};

/** Verbs for one call that did not finish, as in "Edit failed". */
export const TOOL_OUTCOME_VERBS: Record<string, string> = {
  Glob: "List",
  Grep: "Search",
  Read: "Read",
  Edit: "Edit",
  Write: "Write",
  Bash: "Command",
  WebSearch: "Web search",
  WebFetch: "Fetch",
  delegate_task: "Delegation",
  task_status: "Task check",
  task_cancel: "Cancel",
  workspace_search: "Project search",
  worktree_list: "Worktree list",
  thread_target_list: "Target list",
  thread_launch: "Thread launch",
  thread_search: "Thread search",
  thread_get: "Thread read",
  thread_send: "Thread send",
  thread_stop: "Thread stop",
  thread_wait: "Thread wait",
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
  delegate_task: ["Delegated %d task", "Delegated %d tasks"],
  task_status: ["Checked %d task", "Checked %d tasks"],
  task_cancel: ["Cancelled %d task", "Cancelled %d tasks"],
  workspace_search: ["%d project search", "%d project searches"],
  worktree_list: ["Listed worktrees %d time", "Listed worktrees %d times"],
  thread_target_list: ["Listed targets %d time", "Listed targets %d times"],
  thread_launch: ["Launched %d thread", "Launched %d threads"],
  thread_search: ["%d thread search", "%d thread searches"],
  thread_get: ["Read %d thread", "Read %d threads"],
  thread_send: ["Sent %d message", "Sent %d messages"],
  thread_stop: ["Stopped %d thread", "Stopped %d threads"],
  thread_wait: ["Waited %d time", "Waited %d times"],
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
      parts.push(`${count} ${name} ${count === 1 ? "call" : "calls"}`);
    }
  }
  return parts.join(", ");
}
