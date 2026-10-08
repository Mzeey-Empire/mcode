import { Button } from "@/components/ui/button";
import { SiteFavicon } from "@/components/ui/favicon";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isModifierClick, isPreviewableUrl, openUrlInPreview } from "@/features/preview";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useOverviewMessages } from "@/features/thread-overview/use-overview-messages";
import { extractThreadSources, type ThreadSource } from "@/lib/message-sources";
import { type Thread } from "@/transport";
import { Globe } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

interface ThreadOverviewSourcesProps {
  sources: ThreadSource[];
  onOpen: (event: React.MouseEvent, url: string) => void;
}

/**
 * Renders the deduped external links the assistant produced this thread as a
 * compact favicon grid. Each chip shows its full URL on hover and reuses the
 * standard link-open behavior (Ctrl/Cmd+click opens in the in-app preview,
 * plain click opens the system browser).
 */
function ThreadOverviewSources({ sources, onOpen }: ThreadOverviewSourcesProps) {
  if (sources.length === 0) return null;

  return (
    <div data-testid="thread-overview-sources" className="flex w-full flex-col gap-1.5 px-2 py-1.5">
      <span className="text-xs font-medium text-muted">
        Sources
      </span>
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => (
          <Tooltip key={source.url}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-compact"
                  type="button"
                  aria-label={source.url}
                  data-testid="thread-overview-source"
                  onClick={(event) => onOpen(event, source.url)}
                  className="size-6 rounded-md hover:bg-hover/50"
                >
                  <SiteFavicon
                    src={source.faviconUrl}
                    fallback={<Globe size={13} className="text-muted" />}
                  />
                </Button>
              }
            />
            <TooltipContent side="top" className="max-w-xs break-all text-xs">
              {source.url}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function SourcesEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const sourceMessages = useOverviewMessages(thread.id, open);
  const sources = useMemo(
    () => (open ? extractThreadSources(sourceMessages) : []),
    [open, sourceMessages],
  );
  const openSource = useCallback(
    (event: React.MouseEvent, url: string) => {
      if (isModifierClick(event) && window.desktopBridge?.preview && isPreviewableUrl(url)) {
        openUrlInPreview({ url, threadId: thread.id });
        return;
      }
      if (window.desktopBridge?.openExternalUrl) {
        void window.desktopBridge.openExternalUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    [thread.id],
  );
  return (<ThreadOverviewWhen when={sources.length > 0}>
    <>
      <Separator className="my-1.5" />
      <ThreadOverviewSources sources={sources} onOpen={openSource} />
    </>
  </ThreadOverviewWhen>);
}

/** Sources block in the thread overview, preserving its existing row position. */
export function SourcesEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SourcesEntry thread={subject.thread} /> : null;
}
