import { Button } from "@/components/ui/button";
import { SiteFavicon } from "@/components/ui/favicon";
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

function sourceHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * Names each source by its host, adding the first path segment when another source shares the
 * host, so two links on one site stay distinguishable without hovering.
 */
export function sourceLabels(sources: readonly ThreadSource[]): string[] {
  const urls = sources.map((source) => new URL(source.url));
  const hostCounts = new Map<string, number>();
  for (const url of urls) hostCounts.set(sourceHost(url), (hostCounts.get(sourceHost(url)) ?? 0) + 1);
  return urls.map((url) => {
    const host = sourceHost(url);
    const segment = url.pathname.split("/").find((part) => part !== "");
    return (hostCounts.get(host) ?? 0) > 1 && segment ? `${host}/${segment}` : host;
  });
}

interface ThreadOverviewSourcesProps {
  sources: ThreadSource[];
  onOpen: (event: React.MouseEvent, url: string) => void;
}

/**
 * Renders the deduped external links the assistant produced this thread as a
 * wrapping row of favicon and host chips. Each chip shows its full URL on hover and reuses the
 * standard link-open behavior (Ctrl/Cmd+click opens in the in-app preview,
 * plain click opens the system browser).
 */
function ThreadOverviewSources({ sources, onOpen }: ThreadOverviewSourcesProps) {
  const labels = useMemo(() => sourceLabels(sources), [sources]);
  if (sources.length === 0) return null;

  return (
    <div data-testid="thread-overview-sources" className="flex w-full flex-col px-3 pb-2">
      <div className="flex h-6 items-center text-caption font-medium text-muted">Sources</div>
      <div className="flex flex-wrap gap-1">
        {sources.map((source, index) => (
          <Tooltip key={source.url}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="compact"
                  type="button"
                  aria-label={source.url}
                  data-testid="thread-overview-source"
                  onClick={(event) => onOpen(event, source.url)}
                  className="h-6 max-w-40 gap-1.5 rounded-md px-1.5 text-caption text-muted hover:bg-hover/50 hover:text-ink"
                >
                  <SiteFavicon
                    src={source.faviconUrl}
                    fallback={<Globe className="size-3.5 text-muted" />}
                  />
                  <span className="text-fade min-w-0">{labels[index]}</span>
                </Button>
              }
            />
            <TooltipContent side="top" className="max-w-xs break-all text-caption">
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
      <ThreadOverviewSources sources={sources} onOpen={openSource} />
    </>
  </ThreadOverviewWhen>);
}

/** Sources block in the thread overview, preserving its existing row position. */
export function SourcesEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SourcesEntry thread={subject.thread} /> : null;
}
