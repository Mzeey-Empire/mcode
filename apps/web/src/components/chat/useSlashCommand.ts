import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
  providerCatalogCacheKey,
  useProviderCatalogStore,
} from "@/stores/providerCatalogStore";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { type ProviderCapabilityEntry, type ProviderCapabilityKind, type ProviderCapabilityIdentity } from "@mcode/contracts/providers/capability-catalog";
import { type SkillSource } from "@mcode/contracts/skills";
import type { ProviderCatalogRequest } from "@/transport";
import type { SlashCommandNamespace } from "./lexical/SlashCommandNode";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityAction,
  type ResolvedComposerCapability,
} from "@/features/conversation/composer/composer-capabilities";
import { filterMenuCommands, readMenuTrigger, slashMenuReducer, type MenuTrigger, type SlashMenuEvent, type SlashMenuState } from "./menu-trigger";

/** A slash command entry shown in the popup. */
export type ComposerCommandAction = ComposerCapabilityAction;

/** A slash command entry shown in the popup. */
export interface Command {
  id: string;
  name: string;
  description: string;
  namespace: SlashCommandNamespace;
  capabilityKind: ProviderCapabilityKind | "mcode";
  nativeId: string;
  mentionPath?: string;
  /** Filesystem path of the backing skill/command file, when the catalog knows it. */
  path?: string;
  identity?: ProviderCapabilityIdentity;
  /** Discovery scope of the backing skill entry; used to tag project-local duplicates. */
  source?: SkillSource;
  /** For mcode-namespace commands, the action string dispatched on selection. */
  action?: ComposerCommandAction;
}

/**
 * Render state of the slash command popup, modelled as a discriminated union
 * so the stale-while-revalidate priority (error → list → loading → empty) is an
 * exhaustive switch the compiler checks rather than a comment plus nested
 * ternary. `staleRevalidating` names the state behind the stuck-popup bug:
 * cached items are shown while a fresh skill load is still in flight.
 */
export type PopupState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; items: Command[] }
  | { kind: "staleRevalidating"; items: Command[] }
  | { kind: "empty" }
  | { kind: "error"; error: Error };

const MAX_SLASH_COMMAND_ITEMS = 100;

const BUILTIN_COMMANDS: Command[] = [
  {
    id: "builtin:mcode:mcode-browser",
    name: "mcode-browser",
    description: "Read the Mcode Browser operating guide",
    namespace: "mcode",
    capabilityKind: "mcode",
    nativeId: "mcode-browser",
  },
  {
    id: "builtin:mcode:thread-control",
    name: "thread-control",
    description: "Read the Mcode thread-control operating guide",
    namespace: "mcode",
    capabilityKind: "mcode",
    nativeId: "thread-control",
  },
  {
    id: "builtin:command:compact",
    name: "compact",
    description: "Summarise conversation history to free up context window",
    namespace: "command",
    capabilityKind: "providerCommand",
    nativeId: "compact",
  },
];

const CLOSED_MENU_FILTER: Pick<MenuTrigger, "query" | "scope"> = { query: "", scope: "all" };

function menuFilter(menu: SlashMenuState): Pick<MenuTrigger, "query" | "scope"> {
  return menu.status === "open" ? menu.trigger : CLOSED_MENU_FILTER;
}

/** Plain inputs have one text node, so their triggers share one anchor key. */
const PLAIN_INPUT_NODE_KEY = "input";

function capabilityCommandDescription(
  capability: Pick<ResolvedComposerCapability, "id" | "label">,
  planActive: boolean,
): string {
  if (capability.id === "plan") return planActive ? "Exit plan mode" : "Enter plan mode";
  return `Attach ${capability.label} to the composer`;
}

/** Map an invocable provider capability into the existing command presentation. */
function toCommand(entry: ProviderCapabilityEntry): Command | null {
  const base = {
    id: `${entry.identity.providerId}:${entry.identity.kind}:${entry.identity.nativeId}`,
    name: entry.name,
    description: entry.description || `Run /${entry.name}`,
    capabilityKind: entry.kind,
    nativeId: entry.identity.nativeId,
    identity: entry.identity,
  };
  if (entry.kind === "plugin") {
    return {
      ...base,
      description: entry.description || `Use @${entry.name}`,
      namespace: "plugin",
      mentionPath: entry.mentionPath,
    };
  }
  if (entry.kind === "customPrompt" || entry.kind === "providerCommand") {
    return {
      ...base,
      namespace: "command",
      path: entry.path,
    };
  }
  // Compat-prefixed names like `claude:prototype` are ordinary skills, not
  // plugins: every catalog producer tags real plugin skills source "plugin".
  return {
    ...base,
    source: entry.source,
    namespace: entry.source === "plugin" ? "plugin" : "skill",
    path: entry.path,
  };
}

function commandIdentity(command: Command): string {
  const identity = command.identity;
  return identity
    ? JSON.stringify([identity.providerId, identity.kind, identity.nativeId])
    : JSON.stringify(["mcode", command.namespace, command.name, command.action ?? null]);
}

function reconcileOpenCommands(current: Command[], refreshed: Command[]): Command[] {
  const refreshedByIdentity = new Map(
    refreshed.map((command) => [commandIdentity(command), command]),
  );
  const retained = current.flatMap((command) => {
    const updated = refreshedByIdentity.get(commandIdentity(command));
    return updated ? [updated] : [];
  });
  const retainedIdentities = new Set(retained.map(commandIdentity));
  const additions = refreshed.filter(
    (command) => !retainedIdentities.has(commandIdentity(command)),
  );
  return (["mcode", "command", "skill", "plugin"] as const).flatMap((namespace) => [
    ...retained.filter((command) => command.namespace === namespace),
    ...additions.filter((command) => command.namespace === namespace),
  ]);
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
    if (order !== 0) return order;
    const nameOrder = a.name.localeCompare(b.name);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}

/** Options for the useSlashCommand hook. */
interface UseSlashCommandOptions {
  anchorRef: React.RefObject<HTMLElement | null>;
  onMcodeCommand?: (action: ComposerCommandAction) => void;
  cwd?: string;
  /** Workspace whose validated server-side path scopes provider discovery. */
  workspaceId?: string;
  /** Thread whose worktree path scopes provider discovery. */
  threadId?: string;
  /** Provider ID used to scope skill loading and resolve built-in capabilities. */
  providerId?: string;
  /** Model ID used to resolve model-specific composer capabilities. */
  modelId?: string;
  /**
   * Whether to include mcode built-in commands (plan, compact, goal, mcode-browser, thread-control) in the
   * command list. Default `true`. Pass `false` for contexts like the annotation
   * bubble where mcode actions are meaningless and must not be selectable.
   */
  includeBuiltins?: boolean;
  /** Whether this surface can persist native plugin mentions. */
  includePlugins?: boolean;
  /** Whether Plan is on, so the `/plan` row describes what selecting it will do. */
  planActive?: boolean;
}

/** Return value of the useSlashCommand hook. */
export interface UseSlashCommandReturn {
  isOpen: boolean;
  /**
   * Typed render state for the popup. The popup switches on `state.kind`; the
   * priority that used to live in a comment now lives in this union. `items`
   * and `selectedIndex` remain on the return for the Composer's index-based
   * keyboard selection, which needs the flat list independent of render state.
   */
  state: PopupState;
  items: Command[];
  /** The text typed after the trigger key, empty while closed. */
  query: string;
  allCommands: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  /**
   * Notify the hook of a text change. Pass `cursorPos` for inputs where the
   * cursor may be mid-text (e.g. the annotation bubble `<input>`); when omitted
   * the hook defaults to end-of-string, matching the Composer's Lexical path.
   */
  onInputChange: (value: string, cursorPos?: number) => void;
  /** Notify the hook that the editor caret sits after `textBeforeCaret` in the text node `nodeKey`. */
  onEditorTrigger: (textBeforeCaret: string, nodeKey: string) => void;
  /** Notify the hook that the caret no longer sits on a trigger. */
  onTriggerLost: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Moves the selection to a row, for pointer movement over the list. */
  onHighlight: (index: number) => void;
  onSelect: (cmd: Command, replaceText: (v: string) => void) => void;
  /** Escape: closes the menu and keeps it closed while the user keeps typing the same word. */
  onDismiss: () => void;
  /** Closes the menu because focus left it, such as a click outside. */
  onBlur: () => void;
  onRetry: () => void;
}

/** Routes a Lexical navigation key to an open slash-command picker. */
export function handleSlashCommandTrayKey(
  key: string,
  items: readonly Command[],
  selectedIndex: number,
  onSelect: (command: Command) => void,
  onDismiss: () => void,
  onKeyDown: (event: React.KeyboardEvent) => void,
): boolean {
  if (key === "Enter" || key === "Tab") {
    const command = items[selectedIndex];
    if (command) {
      onSelect(command);
      return true;
    }
  }
  if (key === "Escape") {
    onDismiss();
    return true;
  }
  onKeyDown({
    key,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.KeyboardEvent);
  return key === "ArrowDown" || key === "ArrowUp";
}

/** Manages slash command detection, provider catalog loading, and popup state. */
export function useSlashCommand({
  anchorRef,
  onMcodeCommand,
  cwd,
  workspaceId,
  threadId,
  providerId,
  modelId,
  includeBuiltins = true,
  includePlugins = true,
  planActive = false,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [menu, setMenu] = useState<SlashMenuState>({ status: "closed", dismissed: null });
  // Escape and the editor update for the next keystroke can land before a re-render, so each event reduces from the
  // last event's result rather than from this render's `menu`.
  const latestMenuRef = useRef(menu);
  const isOpen = menu.status === "open";
  const { query: filter, scope } = menuFilter(menu);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // The visible list is an interaction snapshot. Cache invalidations must not
  // reorder a picker while the user is navigating it with the keyboard.
  const [openCommands, setOpenCommands] = useState<Command[] | null>(null);
  const selectedCommandIdentityRef = useRef<string | null>(null);
  const lastInputRef = useRef("");
  // Tracks the cursor position supplied by the most recent onInputChange call
  // so onSelect can splice the replacement at the correct offset rather than
  // always appending to the end (which breaks mid-text trigger detection).
  const lastCursorRef = useRef<number | undefined>(undefined);

  const catalogRequest = useMemo<ProviderCatalogRequest | null>(() => {
    const parsedProvider = ProviderIdSchema.safeParse(providerId ?? "claude");
    if (!parsedProvider.success) return null;
    if (workspaceId) {
      return {
        providerId: parsedProvider.data,
        workspaceId,
        ...(threadId ? { threadId } : {}),
      };
    }
    return {
      providerId: parsedProvider.data,
      ...(cwd ? { cwd } : {}),
    };
  }, [cwd, providerId, threadId, workspaceId]);
  const cacheKey = catalogRequest ? providerCatalogCacheKey(catalogRequest) : "invalid-provider";
  const cacheEntry = useProviderCatalogStore(
    (state) => state.entries[cacheKey] ?? EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
  );
  const { snapshot, isLoading, needsRefresh, error } = cacheEntry;
  const load = useProviderCatalogStore((state) => state.load);

  // Build the full command list only when its inputs change. Filtering stays
  // separate so keyboard selection does not rebuild every command row.
  const allCommands = useMemo(() => {
    const builtins: Command[] = includeBuiltins
      ? [
          ...resolveComposerCapabilities({ providerId, modelId }).map(
            (capability): Command => ({
              id: `builtin:mcode:${capability.id}`,
              name: capability.slashCommand,
              description: capabilityCommandDescription(capability, planActive),
              namespace: "mcode",
              capabilityKind: "mcode",
              nativeId: capability.id,
              action: capability.action,
            }),
          ),
          ...BUILTIN_COMMANDS,
        ]
      : [];
    const providerCommands = (snapshot?.entries ?? [])
      .filter((entry) => includePlugins || entry.kind !== "plugin")
      .map(toCommand)
      .filter((command): command is Command => command !== null);
    const commands: Command[] = [
      ...builtins,
      ...providerCommands,
    ];
    return sortCommands(commands);
  }, [snapshot, providerId, modelId, includeBuiltins, includePlugins, planActive]);

  const reconciledOpenCommands = useMemo(
    () => openCommands === null ? allCommands : reconcileOpenCommands(openCommands, allCommands),
    [allCommands, openCommands],
  );

  const filtered = useMemo(
    () => filterMenuCommands(reconciledOpenCommands, { query: filter, scope }).slice(0, MAX_SLASH_COMMAND_ITEMS),
    [filter, reconciledOpenCommands, scope],
  );

  const displayedSelectedIndex = useMemo(() => {
    const selectedIdentity = selectedCommandIdentityRef.current;
    const retainedIndex = selectedIdentity
      ? filtered.findIndex((command) => commandIdentity(command) === selectedIdentity)
      : -1;
    if (retainedIndex >= 0) return retainedIndex;
    return filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);
  }, [filtered, selectedIndex]);

  useEffect(() => {
    selectedCommandIdentityRef.current = filtered[displayedSelectedIndex]
      ? commandIdentity(filtered[displayedSelectedIndex])
      : null;
  }, [displayedSelectedIndex, filtered]);

  // Derive the typed popup state. Order encodes the stale-while-revalidate priority:
  //   error → list (ready / staleRevalidating) → loading → empty.
  // The list branch splits on isLoading so a background refresh while cached
  // items are shown is the explicit `staleRevalidating` state, the one that
  // got stuck when invalidate() left isLoading=true.
  const state: PopupState = !isOpen
    ? { kind: "closed" }
    : error
      ? { kind: "error", error }
      : filtered.length > 0
        ? isLoading
          ? { kind: "staleRevalidating", items: filtered }
          : { kind: "ready", items: filtered }
        : isLoading
          ? { kind: "loading" }
          : { kind: "empty" };

  // Eager prefetch runs while the picker is closed. This warms the cache for
  // the next open without replacing commands while the user is navigating.
  //
  // Each provider discovery context has its own cache entry. Load when that entry
  // is cold or stale, while retaining old rows during background refresh.
  //
  // The error gate prevents an infinite retry loop on persistent failures.
  // A different context selects a different entry with its own error.
  useEffect(() => {
    if (isOpen) return;
    if (isLoading) return;
    const noSnapshot = snapshot === null;
    if (catalogRequest && !error && (needsRefresh || noSnapshot)) {
      load(catalogRequest).catch(() => { /* surfaced via `error` */ });
    }
  }, [catalogRequest, snapshot, isLoading, needsRefresh, error, load, isOpen]);

  const applyMenuEvent = useCallback(
    (event: SlashMenuEvent) => {
      const current = latestMenuRef.current;
      const next = slashMenuReducer(current, event);
      if (next === current) return;
      latestMenuRef.current = next;
      setMenu(next);
      if (next.status === "closed") {
        setOpenCommands(null);
        selectedCommandIdentityRef.current = null;
        return;
      }
      const anchor = anchorRef.current;
      if (anchor) setAnchorRect(anchor.getBoundingClientRect());
      if (current.status !== "open") {
        if (snapshot !== null) setOpenCommands(allCommands);
        if (providerId === "codex" && catalogRequest) {
          load(catalogRequest, true).catch(() => { /* surfaced via `error` */ });
        }
      }
      setSelectedIndex(0);
      selectedCommandIdentityRef.current = null;
    },
    [anchorRef, allCommands, catalogRequest, load, providerId, snapshot],
  );

  const onInputChange = useCallback(
    (value: string, cursorPos?: number) => {
      lastInputRef.current = value;
      // Default to end-of-string when no cursor position is given, preserving
      // the Composer's Lexical path which always notifies with the full text.
      const cursor = cursorPos ?? value.length;
      lastCursorRef.current = cursor;
      applyMenuEvent({ type: "caretMoved", trigger: readMenuTrigger(PLAIN_INPUT_NODE_KEY, value.slice(0, cursor)) });
    },
    [applyMenuEvent],
  );

  const onEditorTrigger = useCallback(
    (textBeforeCaret: string, nodeKey: string) => {
      lastInputRef.current = textBeforeCaret;
      lastCursorRef.current = undefined;
      applyMenuEvent({ type: "caretMoved", trigger: readMenuTrigger(nodeKey, textBeforeCaret) });
    },
    [applyMenuEvent],
  );

  const onTriggerLost = useCallback(
    () => applyMenuEvent({ type: "caretMoved", trigger: null }),
    [applyMenuEvent],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          e.stopPropagation();
          // Clamp to 0 when filtered is empty; otherwise `length - 1` would
          // be `-1`, leaking an invalid index into ARIA / keyboard handling.
          const nextIndex = filtered.length === 0
            ? 0
            : Math.min(displayedSelectedIndex + 1, filtered.length - 1);
          selectedCommandIdentityRef.current = filtered[nextIndex]
            ? commandIdentity(filtered[nextIndex])
            : null;
          setSelectedIndex(nextIndex);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          e.stopPropagation();
          const previousIndex = Math.max(displayedSelectedIndex - 1, 0);
          selectedCommandIdentityRef.current = filtered[previousIndex]
            ? commandIdentity(filtered[previousIndex])
            : null;
          setSelectedIndex(previousIndex);
          break;
        }
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          applyMenuEvent({ type: "escaped" });
          break;
      }
    },
    [applyMenuEvent, displayedSelectedIndex, filtered, isOpen],
  );

  const onHighlight = useCallback(
    (index: number) => {
      const command = filtered[index];
      if (!command) return;
      selectedCommandIdentityRef.current = commandIdentity(command);
      setSelectedIndex(index);
    },
    [filtered],
  );

  const onSelect = useCallback(
    (cmd: Command, replaceText: (v: string) => void) => {
      const value = lastInputRef.current;
      // Use the stored cursor position from the last onInputChange so that
      // mid-text replacements splice at the right offset. Falls back to
      // end-of-string for the Composer's Lexical path which never sets it.
      const cursor = lastCursorRef.current ?? value.length;
      const trigger: MenuTrigger | null = readMenuTrigger(PLAIN_INPUT_NODE_KEY, value.slice(0, cursor));

      if (trigger) {
        // The anchor is the trigger's own offset, rather than lastIndexOf, which can pick the wrong
        // occurrence when the same trigger text appears more than once before the cursor.
        const triggerStart = trigger.anchor.start;
        replaceText(
          cmd.action
            ? value.slice(0, triggerStart) + value.slice(cursor)
            : value.slice(0, triggerStart) + (
                cmd.capabilityKind === "plugin" ? `@${cmd.name} ` : `/${cmd.name} `
              ) + value.slice(cursor),
        );
      }
      if (cmd.action && onMcodeCommand) onMcodeCommand(cmd.action);
      applyMenuEvent({ type: "picked" });
    },
    [applyMenuEvent, onMcodeCommand],
  );

  const onDismiss = useCallback(() => applyMenuEvent({ type: "escaped" }), [applyMenuEvent]);
  const onBlur = useCallback(() => applyMenuEvent({ type: "blurred" }), [applyMenuEvent]);
  const onRetry = useCallback(() => {
    if (!catalogRequest) return;
    load(catalogRequest, true).catch(() => { /* surfaced via `error` */ });
  }, [catalogRequest, load]);

  return {
    isOpen,
    state,
    items: filtered,
    query: filter,
    allCommands,
    selectedIndex: displayedSelectedIndex,
    anchorRect,
    onInputChange,
    onEditorTrigger,
    onTriggerLost,
    onKeyDown,
    onHighlight,
    onSelect,
    onDismiss,
    onBlur,
    onRetry,
  };
}
