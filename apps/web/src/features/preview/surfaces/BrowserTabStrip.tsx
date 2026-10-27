import { useMemo } from "react";
import { Globe, MousePointer2 } from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts/models/browser-tab";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "@/components/panels/shell/PanelTabStrip";
import { useDiffStore } from "@/stores/diffStore";
import { cn } from "@/lib/utils";
import { useBrowserActing } from "../state/useBrowserActing";
import { usePreviewTabsStore } from "../state/previewTabsStore";

function browserPageLabel(page: Pick<BrowserTabInfo, "title" | "url">): string {
  if (page.title && page.title.trim().length > 0) return page.title;
  if (!page.url || page.url.trim().length === 0) return "New page";
  try {
    const url = new URL(page.url);
    return url.host || url.pathname || page.url;
  } catch {
    return page.url;
  }
}

interface PageIconProps {
  readonly workspaceId: string;
  readonly scopeId: string;
  readonly page: Pick<BrowserTabInfo, "id" | "faviconUrl">;
  readonly active: boolean;
}

/** The page favicon, swapped for a filled pointer while the agent acts on that page. */
function PageIcon({ workspaceId, scopeId, page, active }: PageIconProps) {
  const acting = useBrowserActing(workspaceId, scopeId, page.id);
  if (acting) {
    return (
      <span className="grid place-items-center">
        <MousePointer2 data-testid="browser-agent-control-indicator" size={14} className="fill-primary text-primary" aria-hidden />
      </span>
    );
  }
  return (
    <span className={cn("grid place-items-center", !active && "opacity-60")}>
      {page.faviconUrl ? (
        <img src={page.faviconUrl} alt="" width={14} height={14} className="rounded-[3px]" />
      ) : (
        <Globe aria-hidden />
      )}
    </span>
  );
}

/** Props for {@link BrowserTabStrip}. */
export interface BrowserTabStripProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** The thread id, or the workspace id for the threadless shell. */
  readonly scopeId: string;
  readonly tabSet: BrowserTabSet | null;
}

/** Browser page tabs. Closing the last page closes the Browser tool. See ADR-0026. */
export function BrowserTabStrip({ workspaceId, threadId, scopeId, tabSet }: BrowserTabStripProps) {
  const pages = tabSet?.tabs;
  const activeId = tabSet?.activeTabId ?? null;
  const items = useMemo<readonly PanelTabStripItem[]>(
    () => (pages ?? []).map((page) => ({
      id: page.id,
      label: browserPageLabel(page),
      icon: <PageIcon workspaceId={workspaceId} scopeId={scopeId} page={page} active={page.id === activeId} />,
    })),
    [pages, activeId, workspaceId, scopeId],
  );
  const store = usePreviewTabsStore.getState;
  return (
    <PanelHeaderSlot slot="leading">
      <div data-browser-chrome="" className="flex min-w-0 flex-1 items-center">
        <PanelTabStrip
          appearance="browser"
          items={items}
          activeId={activeId}
          label="Browser pages"
          addLabel="New page"
          onSelect={(pageId) => void store().activatePage(workspaceId, scopeId, pageId)}
          onClose={(pageId) => void store().closePage(workspaceId, scopeId, pageId, {
            onLastClose: () => useDiffStore.getState().closeRightPanelTab(workspaceId, threadId, "preview"),
          })}
          onAdd={() => void store().openPage(workspaceId, scopeId)}
        />
      </div>
    </PanelHeaderSlot>
  );
}
