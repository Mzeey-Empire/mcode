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
  /** Set only when another label reads the same; numbers them in source order. */
  readonly ordinal?: number;
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

function samePath(left: URL, right: URL): boolean {
  return pathSegments(left).join("/") === pathSegments(right).join("/");
}

/**
 * The shortest path suffix no source on a different path shares. Sources on the same path are left
 * to {@link distinguishingTail}, so a query twin never forces the path back to its last segment.
 */
function distinguishingPath(url: URL, others: readonly URL[]): string {
  const segments = pathSegments(url);
  const otherPaths = others.filter((other) => !samePath(other, url));
  for (let count = 1; count < segments.length; count += 1) {
    const suffix = pathSuffix(segments, count);
    if (otherPaths.every((other) => pathSuffix(pathSegments(other), count) !== suffix)) return suffix;
  }
  return pathSuffix(segments, segments.length);
}

/** For sources on the same path, the query, the fragment, or both: whichever first tells them apart. */
function distinguishingTail(url: URL, others: readonly URL[]): string {
  const twins = others.filter((other) => samePath(other, url));
  if (twins.length === 0) return "";
  for (const tail of [url.search, url.hash, `${url.search}${url.hash}`]) {
    if (twins.every((other) => tail !== other.search && tail !== other.hash && tail !== `${other.search}${other.hash}`)) {
      return tail;
    }
  }
  return `${url.search}${url.hash}`;
}

/** Longest detail a chip shows whole, about what fits beside a faded host at the card's width. */
const MAX_DETAIL_LENGTH = 28;
const DETAIL_HEAD_LENGTH = 10;

/**
 * Shortens a long detail in the middle. The head keeps the segment that tells paths apart and the
 * end keeps the query and the end of a slug, which a right-edge fade would hide.
 */
function shortenDetail(detail: string): string {
  if (detail.length <= MAX_DETAIL_LENGTH) return detail;
  const tailLength = MAX_DETAIL_LENGTH - DETAIL_HEAD_LENGTH - 1;
  return `${detail.slice(0, DETAIL_HEAD_LENGTH)}…${detail.slice(-tailLength)}`;
}

function sharedPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

/**
 * For details that read alike once shortened: they share the head and the end, so they first
 * differ in the middle, where the full text could fade before the difference shows. The shared
 * start gives way instead, keeping a little of it as context. It gives way up to the closest
 * peer's difference, not the first one's: with three labels, two can share a start the third
 * does not, and only the later cut tells those two apart. A peer with the same detail, such as
 * the www twin of a link, cannot be told apart by any cut, so it does not count.
 */
function elideSharedStart(detail: string, peers: readonly string[]): string {
  const differing = peers.filter((peer) => peer !== detail);
  if (differing.length === 0) return detail;
  const sharedLength = Math.max(...differing.map((peer) => sharedPrefixLength(detail, peer)));
  if (sharedLength <= DETAIL_HEAD_LENGTH) return detail;
  return `…${detail.slice(sharedLength - DETAIL_HEAD_LENGTH)}`;
}

/**
 * Names each source by its host. When another source shares the host, it adds the shortest path
 * suffix that tells them apart, then the query or fragment for sources on the same path, so two
 * links on one site stay distinguishable without hovering. A long detail is shortened in the middle,
 * or, when that would make two same-host labels read alike, loses the start they share. Labels that
 * still read alike are numbered.
 */
export function sourceLabelParts(sources: readonly ThreadSource[]): SourceLabel[] {
  const urls = sources.map((source) => new URL(source.url));
  const full = urls.map((url, index) => {
    const host = sourceHost(url);
    const others = urls.filter((other, otherIndex) => otherIndex !== index && sourceHost(other) === host);
    if (others.length === 0) return { host, detail: "" };
    return { host, detail: `${distinguishingPath(url, others)}${distinguishingTail(url, others)}` };
  });
  const short = full.map(({ host, detail }) => ({ host, detail: shortenDetail(detail) }));
  const elided = short.map((label, index) => {
    const peers = full.filter((_, otherIndex) =>
      otherIndex !== index && short[otherIndex].host === label.host && short[otherIndex].detail === label.detail);
    if (peers.length === 0) return label;
    return { host: label.host, detail: elideSharedStart(full[index].detail, peers.map((peer) => peer.detail)) };
  });
  return numberAlikeLabels(elided);
}

/**
 * Labels that still read the same where a chip can show them, such as a link and its www twin, or
 * repetitive paths that differ only past the fade, get " (n)" in source order, as terminal tabs
 * that share a name do. They are compared on the detail's first {@link MAX_DETAIL_LENGTH}
 * characters, what a chip shows before it fades, and the number sits outside the fade.
 */
function numberAlikeLabels(labels: readonly SourceLabel[]): SourceLabel[] {
  const text = ({ host, detail }: SourceLabel) => `${host}/${detail.slice(0, MAX_DETAIL_LENGTH)}`;
  const totals = new Map<string, number>();
  for (const label of labels) totals.set(text(label), (totals.get(text(label)) ?? 0) + 1);
  const numbered = new Map<string, number>();
  return labels.map((label) => {
    if ((totals.get(text(label)) ?? 0) < 2) return label;
    const ordinal = (numbered.get(text(label)) ?? 0) + 1;
    numbered.set(text(label), ordinal);
    return { ...label, ordinal };
  });
}

/** Each source's label as one string, the text its chip shows. */
export function sourceLabels(sources: readonly ThreadSource[]): string[] {
  return sourceLabelParts(sources).map(({ host, detail, ordinal }) =>
    `${detail ? `${host}/${detail}` : host}${ordinal ? ` (${ordinal})` : ""}`);
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
                  className="h-6 max-w-full gap-1.5 rounded-md px-1.5 text-caption text-muted hover:bg-hover/50 hover:text-ink"
                >
                  <SiteFavicon
                    src={source.faviconUrl}
                    fallback={<Globe className="size-3.5 text-muted" />}
                  />
                  {/* The detail tells same-host chips apart and is shortened to fit, so the host's far larger
                      shrink factor makes it give up its width first; the detail fades only when it kept its full text. */}
                  <span className="flex min-w-0">
                    <span data-testid="thread-overview-source-host" className="text-fade min-w-0 shrink-[999]">
                      {labels[index].host}
                    </span>
                    {labels[index].detail ? (
                      <span
                        data-testid="thread-overview-source-detail"
                        className="text-fade min-w-0"
                      >
                        /{labels[index].detail}
                      </span>
                    ) : null}
                    {labels[index].ordinal ? (
                      <span data-testid="thread-overview-source-ordinal" className="shrink-0 whitespace-pre">
                        {` (${labels[index].ordinal})`}
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
