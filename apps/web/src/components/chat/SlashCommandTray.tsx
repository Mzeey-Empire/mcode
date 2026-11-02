import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { cn } from "@/lib/utils";
import type { Command, PopupState } from "./useSlashCommand";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";
import { shortenPathPrefixedName } from "./command-name";
import { EntityIcon } from "./EntityToken";

const TRAY_SURFACE_CLASS = "p-2";
// Floating over the transcript it keeps the rail border, where `panel` alone matches the light canvas.
const ATTACHED_TRAY_SURFACE_CLASS = "rounded-t-[14px] bg-panel";
/**
 * In the capsule the menu takes the attachment tray's place and look: the tray's inset, measured inside the capsule's
 * 1px border, and its bottom edge on that border, so the menu and an open tray share one footprint.
 */
const CAPSULE_DOCK_CLASS =
  "absolute inset-x-[calc(var(--tray-inset)-1px)] bottom-[calc(100%+1px)] z-(--layer-dropdown) cursor-default rounded-t-[14px] bg-panel p-2";
const LIST_CLASS =
  "scroll-fade-y relative max-h-[262px] [&>[data-slot=sliding-highlight]]:rounded-full [&>[data-slot=sliding-highlight]]:bg-ink/7";

function commandDisplayLabel(command: Command): string {
  if (command.capabilityKind === "plugin") return `@${command.name}`;
  if (command.namespace === "skill") return shortenPathPrefixedName(command.name);
  if (command.namespace === "plugin") return command.name.split(":").at(-1) ?? command.name;
  return `/${command.name}`;
}

/** Props for the {@link SlashCommandTray} component. */
interface SlashCommandTrayProps {
  /** Typed render state from {@link useSlashCommand}; the tray switches on `state.kind`. */
  state: PopupState;
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onSelect: (cmd: Command) => void;
  /** Moves the selection when the pointer moves onto a row. Without it the pointer never selects. */
  onHighlight?: (index: number) => void;
  onDismiss: () => void;
  onRetry: () => void;
  /** Compact annotation treatment; colours follow the app theme. */
  tone?: "default" | "dark";
  /** Extra class names for border/positioning overrides that don't belong in tone. */
  className?: string;
  /** Active workspace root used to identify local workspace skills. */
  workspacePath?: string;
  /** The text typed after the trigger key; its first match in each name is set in semibold. */
  query?: string;
  /** Docks in the composer capsule, in the attachment tray's place. Otherwise it floats above its anchor. */
  docked?: boolean;
}

/**
 * Tray that lists slash command suggestions. Inside a composer layout it docks
 * on top of the composer like the task tray; elsewhere it floats above its
 * anchor. Handles keyboard navigation via `selectedIndex`, caps the visible
 * list height, and dismisses on outside click. The render priority (error →
 * list → inline loader → empty) is encoded by the {@link PopupState} union
 * rather than a comment, so this component is an exhaustive switch on `state.kind`.
 */
export function SlashCommandTray({
  state,
  selectedIndex,
  anchorRect,
  onSelect,
  onHighlight,
  onDismiss,
  onRetry,
  tone = "default",
  className,
  workspacePath,
  query = "",
  docked = false,
}: SlashCommandTrayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const pointerSelectedIndexRef = useRef<number | null>(null);

  // The list-bearing states carry the items; all others render no list.
  const items: Command[] =
    state.kind === "ready" || state.kind === "staleRevalidating" ? state.items : [];
  const isOpen = state.kind !== "closed";

  useEffect(() => {
    if (!isOpen) return;
    // A row the pointer chose is already under the pointer; scrolling it would slide the list away.
    if (pointerSelectedIndexRef.current === selectedIndex) return;
    pointerSelectedIndexRef.current = null;
    const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, isOpen, items.length]);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // Chromium can report pointer events when the list scrolls under a still cursor. Only a
    // real move selects, so wheel scrolling never steals the keyboard selection.
    const last = lastPointerRef.current;
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    const row = (event.target as Element).closest<HTMLElement>("[data-index]");
    const index = row ? Number(row.dataset.index) : Number.NaN;
    if (!Number.isInteger(index) || index === selectedIndex) return;
    pointerSelectedIndexRef.current = index;
    onHighlight?.(index);
  };

  // Dismiss on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-slash-tray]")) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onDismiss]);

  if (state.kind === "closed") return null;

  const content = (
    <SlashMenuContent
      state={state}
      selectedIndex={selectedIndex}
      scrollRef={scrollRef}
      query={query}
      tone={tone}
      workspacePath={workspacePath}
      onSelect={onSelect}
      onRetry={onRetry}
      onPointerMove={handlePointerMove}
    />
  );

  if (docked) {
    return <div data-slash-tray className={cn(CAPSULE_DOCK_CLASS, className)}>{content}</div>;
  }
  if (!anchorRect) return null;
  return (
    // The listbox role belongs to the scrolling options container. The error
    // branch renders its Retry control outside that semantic container.
    <ComposerOverlaySurface
      data-slash-tray
      anchorRect={anchorRect}
      attached
      tone={tone}
      className={cn(TRAY_SURFACE_CLASS, className)}
      attachedClassName={ATTACHED_TRAY_SURFACE_CLASS}
    >
      {content}
    </ComposerOverlaySurface>
  );
}

function SlashMenuContent({
  state,
  selectedIndex,
  scrollRef,
  query,
  tone,
  workspacePath,
  onSelect,
  onRetry,
  onPointerMove,
}: {
  state: Exclude<PopupState, { kind: "closed" }>;
  selectedIndex: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  tone: "default" | "dark";
  workspacePath?: string;
  onSelect: (cmd: Command) => void;
  onRetry: () => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // Render priority (stale-while-revalidate) is encoded by PopupState: error, then the list (ready, or
  // staleRevalidating while cached items show during a fresh load), then the inline loader, then empty.
  // The switch over the open kinds is exhaustive and compiler-checked.
  switch (state.kind) {
    case "error":
      return <ErrorRow message={state.error.message} onRetry={onRetry} tone={tone} />;
    case "ready":
    case "staleRevalidating": {
      const items = state.items;
      return (
        <div
          ref={scrollRef}
          role="listbox"
          aria-label="Slash commands"
          aria-activedescendant={items[selectedIndex] ? `slash-cmd-${selectedIndex}` : undefined}
          className={LIST_CLASS}
          onPointerMove={onPointerMove}
        >
          <SlidingHighlight follow="aria-selected" />
          {items.map((cmd, index) => (
            <Fragment key={cmd.id}>
              {index > 0 && items[index - 1].namespace !== cmd.namespace && (
                <div role="separator" className="mx-2 my-1 h-px bg-border" />
              )}
              <CommandRow
                cmd={cmd}
                index={index}
                selected={index === selectedIndex}
                query={query}
                onSelect={onSelect}
                tone={tone}
                origin={duplicateSkillOriginTag(cmd, items, workspacePath)}
              />
            </Fragment>
          ))}
        </div>
      );
    }
    case "loading":
      return <LoadingInline />;
    case "empty":
      return <EmptyState />;
  }
}

/** The label with its first case-insensitive match of `query` in semibold. */
function highlightMatch(label: string, query: string): ReactNode {
  const at = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <b className="font-semibold">{label.slice(at, at + query.length)}</b>
      {label.slice(at + query.length)}
    </>
  );
}

function CommandRow({
  cmd,
  index,
  selected,
  query,
  onSelect,
  tone = "default",
  origin,
}: {
  cmd: Command;
  index: number;
  selected: boolean;
  query: string;
  onSelect: (cmd: Command) => void;
  tone?: "default" | "dark";
  origin?: "Local";
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      id={`slash-cmd-${index}`}
      role="option"
      aria-selected={selected}
      data-index={index}
      aria-label={[
        commandDisplayLabel(cmd),
        cmd.capabilityKind === "plugin" ? "Plugin" : undefined,
        cmd.description,
        origin,
      ].filter(Boolean).join(" ")}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      // The sliding highlight is the only fill; a hover fill would show a second highlighted row.
      className="group/row relative h-8 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-full pr-3 pl-2 text-left hover:bg-transparent [&_svg:not([class*='size-'])]:size-3.5"
    >
      <CommandIdentityMark command={cmd} />
      <span className="max-w-[55%] shrink-0 text-fade text-body-small text-ink">
        {highlightMatch(commandDisplayLabel(cmd), query)}
      </span>
      <span className="min-w-0 flex-1 text-fade text-compact text-muted">
        {cmd.description}
      </span>
      {origin && (
        <Badge
          variant="outline"
          size="compact"
          className={cn(tone === "dark" && "border-border text-muted")}
        >
          {origin}
        </Badge>
      )}
    </Button>
  );
}

function commandIconKind(command: Command): "skill" | "plugin" | "mcode" | "command" {
  if (command.capabilityKind === "skill") return "skill";
  if (command.capabilityKind === "plugin") return "plugin";
  if (command.capabilityKind === "mcode" || ["goal", "plan", "ultra", "compact"].includes(command.name)) {
    return "mcode";
  }
  return "command";
}

function CommandIdentityMark({ command }: { command: Command }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center text-muted group-aria-selected/row:text-ink">
      <EntityIcon
        kind={commandIconKind(command)}
        commandName={command.name}
        size={14}
        className="flex items-center justify-center"
      />
    </span>
  );
}

function duplicateSkillOriginTag(
  command: Command,
  commands: Command[],
  workspacePath?: string,
): "Local" | undefined {
  if (
    command.capabilityKind !== "skill" ||
    !commands.some(
      (candidate) =>
        candidate.capabilityKind === "skill" &&
        candidate.name === command.name &&
        candidate.id !== command.id,
    )
  ) {
    return undefined;
  }

  return command.source === "project" || isLocalSkillPath(command, workspacePath)
    ? "Local"
    : undefined;
}

function isLocalSkillPath(command: Command, workspacePath?: string): boolean {
  const nativePath = normalizePath(command.identity?.nativeId ?? command.nativeId);
  const localSkillPath = workspacePath
    ? `${normalizePath(workspacePath).replace(/\/+$/, "")}/.codex/skills/`
    : undefined;
  return (
    (localSkillPath !== undefined && nativePath.startsWith(localSkillPath)) ||
    nativePath.startsWith(".codex/skills/") ||
    nativePath.includes("/.codex/skills/")
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Single-row "Loading commands..." indicator. Replaces the previous 3-row
 * skeleton-shimmer block. The skeleton was visually noisy and triggered on
 * every cold start, workspace switch, and cache-invalidation push; with the
 * stale-while-revalidate render order in this component plus the eager
 * prefetch in `useSlashCommand`, this branch should only be reachable when
 * the user has typed a filter that excludes every cached built-in AND a
 * skill load is still in flight -- an exceedingly rare combination.
 */
function LoadingInline() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      role="status"
      className="flex items-center gap-3 px-3 py-2"
    >
      <span className="flex h-5 w-5 flex-shrink-0" />
      <span className="text-sm text-muted">Loading commands...</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div aria-live="polite" role="status" className="flex h-8 items-center px-2 text-body-small text-muted">
      No matches
    </div>
  );
}

function ErrorRow({
  message,
  onRetry,
  tone = "default",
}: {
  message: string;
  onRetry: () => void;
  tone?: "default" | "dark";
}) {
  return (
    <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
      <span className="flex-1 text-fade">Couldn't load commands: {message}</span>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        // Same pattern as the footer Refresh button: preventDefault on
        // mousedown to retain editor focus, action on click for keyboard a11y.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
        className={cn(
          "h-6 rounded-md px-2 text-xs",
          tone === "dark"
            ? "text-ink hover:bg-hover"
            : "text-ink hover:bg-selected",
        )}
      >
        Retry
      </Button>
    </div>
  );
}
