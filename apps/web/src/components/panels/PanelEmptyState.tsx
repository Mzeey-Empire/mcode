import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { ShortcutCombo } from "@/components/ui/shortcut-keys";
import { Button } from "@/components/ui/button";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import {
  shownTabTypes,
  type PanelScope,
  type PanelTabType,
} from "@/lib/panel-tabs";
import type { RightPanelTool } from "@/stores/diffStore";

/** A tab type's shortcut keys, split the way the rail's Open tool menu shows them, or null when unbound. */
function tabKeycaps(type: PanelTabType): readonly string[] | null {
  if (!type.commandId) return null;
  const binding = getKeybindingForCommand(type.commandId);
  return binding ? keybindingKeycaps(binding.key, isMac) : null;
}

/**
 * The empty-state create surface for the right panel: a centered list of the
 * tab types creatable in the current scope, under a short header. Each row
 * carries an icon, label, blurb, and the type's mcode keycap; clicking one opens
 * that tab. There is intentionally no add control here —
 * the list is the create surface (ADR-0004, issue #610).
 *
 * A single column (rather than a grid) keeps the surface legible at the panel's
 * minimum width, gives the first-listed types (Browser, Terminal) natural
 * primacy, and never orphans an odd card on a half-empty row.
 */
export function PanelEmptyState({
  scope,
  openTabs,
  onOpen,
}: {
  scope: PanelScope;
  /** Tab types already open, dropped from the list by the cardinality filter. */
  readonly openTabs: readonly RightPanelTool[];
  /** Open (create-or-focus) a tab type. */
  onOpen: (id: RightPanelTool) => void;
}) {
  const rows = shownTabTypes(scope, openTabs);

  return (
    <div
      data-testid="panel-empty-state"
      className="flex h-full flex-col overflow-y-auto px-5 py-10"
    >
      {/* m-auto centers the block when there's room and lets it scroll from the
          top when the list is taller than the panel (auto margins collapse
          rather than clip, unlike justify-center). */}
      {/* The root font size makes 1rem 10px, so max-w-sm would be only 240px: too narrow for a
          blurb beside a three-key shortcut. */}
      <div className="m-auto w-full max-w-[38rem]">
        <header className="mb-5 text-center">
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            Open a tool
          </h2>
        </header>
        {/* One list of quiet rows, like a menu: seven outlined cards read as seven competing panels. */}
        {/* One sliding fill for the list, like menus and pickers, so hover glides between rows. */}
        <div className="relative flex flex-col gap-0.5">
          <SlidingHighlight follow={{ pointer: "button" }} />
          {rows.map((type) => {
            const Icon = type.icon;
            const keycaps = tabKeycaps(type);
            return (
              <Button
                key={type.id}
                type="button"
                variant="ghost"
                size="compact"
                data-testid={`panel-card-${type.id}`}
                aria-label={`Open ${type.label}`}
                onClick={() => onOpen(type.id)}
                // The shortcut shares the title's line, which is short, so the blurb below gets the
                // row's full width and reads whole at the panel's minimum width. The sliding fill draws
                // hover, so the row drops the ghost's own hover fill.
                className="grid h-auto w-full grid-cols-[auto_minmax(0,1fr)] items-center justify-start gap-3 rounded-control px-3 py-2.5 text-left hover:bg-transparent"
              >
                <span className="grid size-8 flex-none place-items-center text-muted">
                  <Icon size={18} />
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-fade min-w-0 text-sm font-medium text-ink">{type.label}</span>
                    {keycaps && keycaps.length > 0 ? (
                      <span aria-hidden className="ml-auto flex shrink-0 items-center text-muted">
                        <ShortcutCombo keys={keycaps} />
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-fade text-xs text-muted">{type.blurb}</span>
                </span>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
