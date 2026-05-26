import { useRef } from "react";
import { Plus, X } from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { COMPACT_ICON_HIT_SLOP } from "@/lib/ui-hit-target";
import { useHorizontalScrollEdges } from "@/hooks/useHorizontalScrollEdges";
import { Button } from "@/components/ui/button";

/** DOM id of the preview surface tabpanel; tabs reference this via aria-controls. */
export const PREVIEW_TABPANEL_ID = "preview-tabpanel";

export interface PreviewTabBarProps {
  readonly tabSet: BrowserTabSet | null;
  readonly onNewTab: () => void;
  readonly onActivate: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
}

function tabLabel(tab: BrowserTabInfo): string {
  if (tab.title && tab.title.trim().length > 0) return tab.title;
  if (tab.url && tab.url.trim().length > 0) {
    try {
      const u = new URL(tab.url);
      return u.host || u.pathname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return "New tab";
}

/**
 * Horizontal tab strip rendered above the preview omnibox. Phase A: a single
 * backing BrowserView per window means activating a tab will detach the
 * current guest and let the next sync drive the new tab's resume URL. The bar
 * shows pending/cold state via the `warm` flag on each tab.
 */
export function PreviewTabBar({
  tabSet,
  onNewTab,
  onActivate,
  onClose,
}: PreviewTabBarProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const scrollEdges = useHorizontalScrollEdges(tabListRef, tabSet?.tabs.length ?? 0);

  if (!tabSet) {
    return null;
  }

  const canClose = tabSet.tabs.length > 1;

  const focusTabAtIndex = (index: number): void => {
    const tabs = tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!tabs || tabs.length === 0) return;
    const clamped = Math.max(0, Math.min(index, tabs.length - 1));
    tabs[clamped]?.focus();
  };

  const onTabListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const tabs = tabSet.tabs;
    const currentIndex = tabs.findIndex((t) => t.id === tabSet.activeTabId);
    if (currentIndex === -1) return;

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
      onActivate(tabs[nextIndex].id);
      focusTabAtIndex(nextIndex);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      onActivate(tabs[0].id);
      focusTabAtIndex(0);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      onActivate(tabs[tabs.length - 1].id);
      focusTabAtIndex(tabs.length - 1);
    }
  };

  return (
    <div className="relative min-w-0">
      {scrollEdges.left ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-background to-transparent pt-1.5"
        />
      ) : null}
      {scrollEdges.right ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-gradient-to-l from-background to-transparent pt-1.5"
        />
      ) : null}
      <div
        ref={tabListRef}
        data-testid="preview-tab-bar"
        className={cn(
          "flex min-w-0 items-center gap-1 overflow-x-auto px-2 pt-1.5",
          "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
        )}
        role="tablist"
        aria-label="Preview tabs"
        onKeyDown={onTabListKeyDown}
      >
        {tabSet.tabs.map((tab) => {
          const active = tab.id === tabSet.activeTabId;
          const label = tabLabel(tab);
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex min-w-[6rem] max-w-[12rem] shrink-0 items-center rounded-t-md border-b-2 border-transparent transition-colors",
                active
                  ? "border-primary bg-muted/40 text-foreground"
                  : "text-muted-foreground hover:bg-muted/20 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={PREVIEW_TABPANEL_ID}
                tabIndex={active ? 0 : -1}
                data-testid="preview-tab"
                data-active={active ? "true" : "false"}
                onClick={() => {
                  if (!active) onActivate(tab.id);
                }}
                className={cn(
                  "flex min-w-0 flex-1 cursor-default items-center gap-1.5 px-2 py-1 text-left text-xs",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:ring-inset",
                )}
              >
                {tab.faviconUrl ? (
                  <img
                    src={tab.faviconUrl}
                    alt=""
                    width={12}
                    height={12}
                    className="shrink-0 rounded-[2px]"
                  />
                ) : (
                  <span className="size-3 shrink-0 rounded-[2px] bg-muted-foreground/20" aria-hidden />
                )}
                <span className="truncate" title={label}>
                  {label}
                </span>
              </button>
              {canClose ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close ${label}`}
                  data-testid="preview-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className={cn(
                    "mr-0.5 shrink-0 opacity-0 transition-opacity",
                    COMPACT_ICON_HIT_SLOP,
                    "group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          data-testid="preview-tab-new"
          onClick={onNewTab}
          className="shrink-0"
        >
          <Plus className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
