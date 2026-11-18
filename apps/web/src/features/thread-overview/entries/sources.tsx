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

/** A source chip's label: the host, and the part that tells it apart from same-host sources. */
export interface SourceLabel {
  readonly host: string;
  /** Empty when the host alone is unique, or for the site root among same-host sources. */
  readonly detail: string;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((part) => part !== "");
}

/** The last `count` path segments, marked as elided when earlier segments were dropped. */
function pathSuffix(segments: readonly string[], count: number): string {
  if (segments.length === 0) return "";
  const kept = segments.slice(-count).join("/");
  return count < segments.length ? `…/${kept}` : kept;
}

/** The shortest path suffix no other same-host URL shares, or null when every suffix is shared. */
function distinguishingPath(url: URL, others: readonly URL[]): string | null {
  const segments = pathSegments(url);
  for (let count = 1; count <= Math.max(segments.length, 1); count += 1) {
    const suffix = pathSuffix(segments, count);
    if (others.every((other) => pathSuffix(pathSegments(other), count) !== suffix)) return suffix;
  }
  return null;
}

/** For URLs with the same path, the query, the fragment, or both: whichever first tells them apart. */
function distinguishingTail(url: URL, others: readonly URL[]): string {
  const samePath = others.filter((other) => other.pathname === url.pathname);
  const last = pathSuffix(pathSegments(url), 1);
  for (const tail of [url.search, url.hash, `${url.search}${url.hash}`]) {
    if (samePath.every((other) => tail !== other.search && tail !== other.hash && tail !== `${other.search}${other.hash}`)) {
      return `${last}${tail}`;
    }
  }
  return `${last}${url.search}${url.hash}`;
}

/**
 * Names each source by its host. When another source shares the host, it adds the shortest path
 * suffix that tells them apart, then the query or fragment when the paths are equal, so two links on
 * one site stay distinguishable without hovering.
 */
export function sourceLabelParts(sources: readonly ThreadSource[]): SourceLabel[] {
  const urls = sources.map((source) => new URL(source.url));
  return urls.map((url, index) => {
    const host = sourceHost(url);
    const others = urls.filter((other, otherIndex) => otherIndex !== index && sourceHost(other) === host);
    if (others.length === 0) return { host, detail: "" };
    return { host, detail: distinguishingPath(url, others) ?? distinguishingTail(url, others) };
  });
}

/** Each source's label as one string, the text its chip shows. */
export function sourceLabels(sources: readonly ThreadSource[]): string[] {
  return sourceLabelParts(sources).map(({ host, detail }) => (detail ? `${host}/${detail}` : host));
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
  const labels = useMemo(() => sourceLabelParts(sources), [sources]);
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
                  className="h-6 max-w-48 gap-1.5 rounded-md px-1.5 text-caption text-muted hover:bg-hover/50 hover:text-ink"
                >
                  <SiteFavicon
                    src={source.faviconUrl}
                    fallback={<Globe className="size-3.5 text-muted" />}
                  />
                  {/* The host shrinks and fades first: the detail is what tells same-host chips apart. */}
                  <span className="flex min-w-0">
                    <span data-testid="thread-overview-source-host" className="text-fade min-w-0 shrink">
                      {labels[index].host}
                    </span>
                    {labels[index].detail ? (
                      <span
                        data-testid="thread-overview-source-detail"
                        className="text-fade min-w-0 max-w-28 shrink-0"
                      >
                        /{labels[index].detail}
                      </span>
                    ) : null}
                  </span>
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
