import { Plus, X } from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { cn } from "@/lib/utils";

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
  if (!tabSet) {
    return null;
  }
  const canClose = tabSet.tabs.length > 1;
  return (
    <div
      data-testid="preview-tab-bar"
      className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 pt-1.5"
      role="tablist"
      aria-label="Preview tabs"
    >
      {tabSet.tabs.map((tab) => {
        const active = tab.id === tabSet.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid="preview-tab"
            data-active={active ? "true" : "false"}
            onClick={() => {
              if (!active) onActivate(tab.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!active) onActivate(tab.id);
              }
            }}
            className={cn(
              "group flex min-w-[6rem] max-w-[12rem] cursor-default items-center gap-1.5 rounded-t-md border-b-2 border-transparent px-2 py-1 text-xs transition-colors",
              active
                ? "border-primary bg-muted/40 text-foreground"
                : "text-muted-foreground hover:bg-muted/20 hover:text-foreground",
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
            <span className="truncate" title={tabLabel(tab)}>
              {tabLabel(tab)}
            </span>
            {canClose ? (
              <button
                type="button"
                aria-label="Close tab"
                data-testid="preview-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        data-testid="preview-tab-new"
        onClick={onNewTab}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}
