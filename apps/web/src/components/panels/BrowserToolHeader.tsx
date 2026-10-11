import { useMemo } from "react";
import { Globe, MousePointer2 } from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import {
  isBrowserAutomationAgentControlled,
  useBrowserAutomationStore,
  usePreviewTabsStore,
} from "@/features/preview";
import { useDiffStore } from "@/stores/diffStore";
import { PanelHeaderSlot } from "./shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "./shell/PanelTabStrip";

/** Human-readable name for a browser page: its title, else its host, else "New page". */
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

function PageIcon({ faviconUrl }: { readonly faviconUrl: string | null }) {
  if (!faviconUrl) return <Globe aria-hidden />;
  return <img src={faviconUrl} alt="" width={14} height={14} className="rounded-[3px]" />;
}

function AgentControlIndicator({
  workspaceId,
  scopeId,
  pageId,
}: {
  readonly workspaceId: string;
  readonly scopeId: string;
  readonly pageId: string;
}) {
  const agentControlled = useBrowserAutomationStore((state) =>
    isBrowserAutomationAgentControlled(state, workspaceId, scopeId, pageId),
  );
  if (!agentControlled) return null;
  return (
    <MousePointer2
      data-testid="browser-agent-control-indicator"
      size={14}
      className="shrink-0 text-primary"
      aria-hidden
    />
  );
}

interface BrowserToolHeaderProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** The thread id, or the workspace id for the threadless shell. */
  readonly scopeId: string;
  readonly tabSet: BrowserTabSet | null;
}

/**
 * The Browser tool's row-1 tabs: one per open page, with a round + that opens
 * another. Closing the last page closes the Browser tool. See ADR-0025.
 */
export function BrowserToolHeader({ workspaceId, threadId, scopeId, tabSet }: BrowserToolHeaderProps) {
  const pages = tabSet?.tabs;
  const items = useMemo<readonly PanelTabStripItem[]>(
    () => (pages ?? []).map((page) => ({
      id: page.id,
      label: browserPageLabel(page),
      icon: <PageIcon faviconUrl={page.faviconUrl} />,
    })),
    [pages],
  );
  const store = usePreviewTabsStore.getState;
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTabStrip
        items={items}
        activeId={tabSet?.activeTabId ?? null}
        label="Browser pages"
        addLabel="New page"
        onSelect={(pageId) => void store().activatePage(workspaceId, scopeId, pageId)}
        onClose={(pageId) => void store().closePage(workspaceId, scopeId, pageId, {
          onLastClose: () => useDiffStore.getState().closeRightPanelTab(workspaceId, threadId, "preview"),
        })}
        onAdd={() => void store().openPage(workspaceId, scopeId)}
        renderAdornment={(item) => (
          <AgentControlIndicator workspaceId={workspaceId} scopeId={scopeId} pageId={item.id} />
        )}
      />
    </PanelHeaderSlot>
  );
}
