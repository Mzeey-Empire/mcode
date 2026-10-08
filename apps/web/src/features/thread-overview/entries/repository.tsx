import { Button } from "@/components/ui/button";
import { SiteFavicon } from "@/components/ui/favicon";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { getTransport, type McodeTransport, type Thread } from "@/transport";
import { ExternalLink, GitBranch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LoadStatus, ThreadOverviewTooltipButton } from "@/features/thread-overview/overview-row";

type ThreadOverviewRepositoryTransport = Pick<McodeTransport, "getRemoteUrl">;

type LoadedRepository = {
  threadId: string;
  status: LoadStatus;
  repository: ThreadOverviewRepository;
};

/** Repository metadata rendered by the Overview Repository row. */
export interface ThreadOverviewRepository {
  /** Label shown in the row, usually "org/repo". */
  label: string;
  /** Safe HTTPS web URL opened from the row, or null for local-only repos. */
  webUrl: string | null;
  /** HTTPS favicon URL for the remote host, or null when unavailable. */
  faviconUrl: string | null;
}

const EMPTY_REPOSITORY: ThreadOverviewRepository = {
  label: "Repository",
  webUrl: null,
  faviconUrl: null,
};

/** Resolves the displayed repository state for the active thread. */
function getLoadedThreadOverviewRepository(
  loaded: LoadedRepository | null,
  threadId: string,
): { repository: ThreadOverviewRepository; status: LoadStatus } {
  if (loaded?.threadId !== threadId) return { repository: EMPTY_REPOSITORY, status: "idle" };
  return { repository: loaded.repository, status: loaded.status };
}

/**
 * Returns a repository URL only when it is safe for an external open action.
 */
export function getSafeRepositoryWebUrl(webUrl: string | null): string | null {
  if (!webUrl) return null;
  try {
    const parsed = new URL(webUrl);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Derives the favicon URL for a safe repository web URL.
 */
export function getRepositoryFaviconUrl(webUrl: string | null): string | null {
  const safeUrl = getSafeRepositoryWebUrl(webUrl);
  if (!safeUrl) return null;
  return `${new URL(safeUrl).origin}/favicon.ico`;
}

/**
 * Resolves the active thread checkout's repository label, safe URL, and favicon.
 */
export async function resolveThreadOverviewRepository({
  thread,
  transport,
}: {
  thread: Pick<Thread, "id" | "workspace_id">;
  transport: ThreadOverviewRepositoryTransport;
}): Promise<ThreadOverviewRepository> {
  const remote = await transport.getRemoteUrl(thread.workspace_id, thread.id);
  const webUrl = getSafeRepositoryWebUrl(remote.webUrl);
  return {
    label: remote.label,
    webUrl,
    faviconUrl: getRepositoryFaviconUrl(webUrl),
  };
}

interface ThreadOverviewRepositoryRowProps {
  repository: ThreadOverviewRepository;
  status: LoadStatus;
  onOpen: () => void;
}

function ThreadOverviewRepositoryRow({
  repository,
  status,
  onOpen,
}: ThreadOverviewRepositoryRowProps) {
  const canOpen = status === "ready" && !!repository.webUrl;
  const label = repository.label;

  if (!canOpen) return null;

  return (
    <div className="grid animate-thread-overview-row-reveal">
      <div className="min-h-0 overflow-hidden">
        <div
          data-testid="thread-overview-repository"
          className="flex w-full flex-col gap-1.5 px-2 py-1.5"
        >
          <span className="font-mono text-xs font-medium uppercase leading-tight tracking-[0.18em] text-muted">
            REPOSITORY
          </span>
          <ThreadOverviewTooltipButton content={repository.webUrl ?? label}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={onOpen}
              data-testid="thread-overview-repository-link"
              aria-label={`Open ${label} on remote`}
              className="-mx-1.5 h-7 min-w-0 justify-start gap-1.5 rounded-md px-1.5 text-left text-primary hover:bg-hover/50 hover:text-primary focus-visible:ring-inset"
            >
              <SiteFavicon
                src={repository.faviconUrl}
                frameTestId="thread-overview-repository-favicon-frame"
                imageTestId="thread-overview-repository-favicon"
                fallback={<GitBranch size={14} className="shrink-0 text-muted" />}
              />
              <span className="text-fade text-xs font-medium">{label}</span>
              <ExternalLink size={12} aria-hidden className="shrink-0 text-muted" />
            </Button>
          </ThreadOverviewTooltipButton>
        </div>
      </div>
    </div>
  );
}

function getThreadOverviewRepositoryDisplay(
  loaded: LoadedRepository | null,
  threadId: string,
  open: boolean,
): { repository: ThreadOverviewRepository; status: LoadStatus } {
  const result = getLoadedThreadOverviewRepository(loaded, threadId);
  return {
    repository: result.repository,
    status: open && result.status === "idle" ? "loading" : result.status,
  };
}

function useRepositoryState(thread: Thread) {
  const { open } = useOverviewContext();
  const [loadedRepository, setLoadedRepository] = useState<LoadedRepository | null>(null);
  const { repository, status: repositoryStatus } = getThreadOverviewRepositoryDisplay(
    loadedRepository,
    thread.id,
    open,
  );
  const hasCurrentRepository = loadedRepository?.threadId === thread.id && loadedRepository.status === "ready";
  useEffect(() => {
    if (!open || hasCurrentRepository) return;

    let cancelled = false;
    const loadRepository = async () => {
      try {
        const repository = await resolveThreadOverviewRepository({
          thread: { id: thread.id, workspace_id: thread.workspace_id },
          transport: getTransport(),
        });
        if (cancelled) return;
        setLoadedRepository({ threadId: thread.id, status: "ready", repository });
      } catch {
        if (!cancelled) {
          setLoadedRepository({
            threadId: thread.id,
            status: "error",
            repository: { label: "Unavailable", webUrl: null, faviconUrl: null },
          });
        }
      }
    };

    void loadRepository();

    return () => {
      cancelled = true;
    };
  }, [hasCurrentRepository, open, thread.id, thread.workspace_id]);
  return { repository, repositoryStatus };
}

/** Preserves the repository result while the overview is closed. */
export const { Provider: RepositoryEntryState, useEntryState: useRepositoryEntryState } = createOverviewEntryState(useRepositoryState);

function RepositoryEntry() {
  const { repository, repositoryStatus } = useRepositoryEntryState();
  const openRepository = useCallback(() => {
    if (!repository.webUrl) return;
    if (window.desktopBridge?.openExternalUrl) {
      void window.desktopBridge.openExternalUrl(repository.webUrl);
      return;
    }
    window.open(repository.webUrl, "_blank", "noopener,noreferrer");
  }, [repository.webUrl]);
  return (<ThreadOverviewRepositoryRow
    repository={repository}
    status={repositoryStatus}
    onOpen={openRepository}
  />);
}

/** Repository block in the thread overview, preserving its existing row position. */
export function RepositoryEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <RepositoryEntry /> : null;
}
