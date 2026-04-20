import { useState, useRef, useCallback, useEffect } from "react";
import { useSkillsStore } from "@/stores/skillsStore";
import type { SkillInfo } from "@/transport";
import type { SlashCommandNamespace } from "./lexical/SlashCommandNode";

/** A slash command entry shown in the popup. */
export interface Command {
  name: string;
  description: string;
  namespace: SlashCommandNamespace;
  /** For mcode-namespace commands, the action string dispatched on selection. */
  action?: string;
}

const BUILTIN_COMMANDS: Command[] = [
  { name: "m:plan", description: "Toggle plan mode", namespace: "mcode", action: "toggle-plan" },
  { name: "compact", description: "Summarise conversation history to free up context window", namespace: "command" },
];

/** Regex: matches `/` at start of line or after whitespace, followed by non-space chars. */
export const SLASH_TRIGGER_RE = /(^|\s)(\/\S*)$/;

/** Map a SkillInfo into a Command. */
function toCommand(s: SkillInfo): Command {
  // `kind === "command"` overrides any namespace inference.
  if (s.kind === "command") {
    return { name: s.name, description: s.description || `Run /${s.name}`, namespace: "command" };
  }
  return {
    name: s.name,
    description: s.description || `Run /${s.name}`,
    namespace: s.name.includes(":") ? "plugin" : "skill",
  };
}

/** Sort commands: source group order, then alphabetical within group. */
const NAMESPACE_ORDER: Record<SlashCommandNamespace, number> = {
  mcode: 0,
  command: 1,
  skill: 2,
  plugin: 3,
};

function sortCommands(cmds: Command[]): Command[] {
  return [...cmds].sort((a, b) => {
    const order = NAMESPACE_ORDER[a.namespace] - NAMESPACE_ORDER[b.namespace];
    return order !== 0 ? order : a.name.localeCompare(b.name);
  });
}

/** Options for the useSlashCommand hook. */
interface UseSlashCommandOptions {
  anchorRef: React.RefObject<HTMLElement | null>;
  onMcodeCommand?: (action: string) => void;
  cwd?: string;
}

/** Return value of the useSlashCommand hook. */
export interface UseSlashCommandReturn {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  allCommands: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  error: Error | null;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (cmd: Command, replaceText: (v: string) => void) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

/** Manages slash command detection, skill loading via skillsStore, and popup state. */
export function useSlashCommand({
  anchorRef,
  onMcodeCommand,
  cwd,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const lastInputRef = useRef("");
  const lastFilterRef = useRef("");

  const skills = useSkillsStore((s) => s.skills);
  const isLoading = useSkillsStore((s) => s.isLoading);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);

  // Build the full command list (memoize via skills identity).
  const allCommands = useCallback(() => {
    const commands: Command[] = [
      ...BUILTIN_COMMANDS,
      ...((skills ?? []).map(toCommand)),
    ];
    return sortCommands(commands);
  }, [skills])();

  const filtered = (() => {
    const f = lastFilterRef.current.toLowerCase();
    if (!f) return allCommands;
    return allCommands.filter((c) => c.name.toLowerCase().includes(f));
  })();

  // Trigger an initial load when the popup first opens.
  // The `!error` gate is critical: without it, a failed load resets
  // `isLoading` to false, which would re-trigger this effect immediately
  // and create an infinite retry loop. Recovery happens via `onRetry`.
  useEffect(() => {
    if (isOpen && skills === null && !isLoading && !error) {
      load(cwd).catch(() => { /* surfaced via `error` */ });
    }
  }, [isOpen, skills, isLoading, error, load, cwd]);

  const onInputChange = useCallback(
    (value: string) => {
      lastInputRef.current = value;
      const cursor = value.length;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (!match) {
        setIsOpen(false);
        return;
      }

      const anchor = anchorRef.current;
      if (anchor) setAnchorRect(anchor.getBoundingClientRect());

      lastFilterRef.current = match[2].slice(1);
      setIsOpen(true);
      setSelectedIndex(0);
    },
    [anchorRef],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(false);
          break;
      }
    },
    [isOpen, filtered.length],
  );

  const onSelect = useCallback(
    (cmd: Command, replaceText: (v: string) => void) => {
      const value = lastInputRef.current;
      const cursor = value.length;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (match) {
        // Use match.index + leading group length to anchor to the exact regex match
        // position, rather than lastIndexOf which can pick the wrong occurrence
        // when the same trigger text appears multiple times before the cursor.
        const triggerStart = match.index + match[1].length;
        replaceText(value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor));
      }
      if (cmd.action && onMcodeCommand) onMcodeCommand(cmd.action);
      setIsOpen(false);
    },
    [onMcodeCommand],
  );

  const onDismiss = useCallback(() => setIsOpen(false), []);
  const onRetry = useCallback(() => {
    load(cwd, true).catch(() => { /* surfaced via `error` */ });
  }, [load, cwd]);

  return {
    isOpen,
    isLoading,
    items: filtered,
    allCommands,
    selectedIndex,
    anchorRect,
    error,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
    onRetry,
  };
}
