import { useMemo, useState } from "react";
import { FileX, OctagonAlert, ShieldAlert, WifiOff, type LucideIcon } from "lucide-react";
import type { BrowserCertificateFailure } from "@mcode/contracts/models/browser-certificate";
import type { PreviewPageError } from "@mcode/contracts/models/preview-page-status";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { loopbackPort } from "../navigation/nav-errors";
import { projectServerTiles, type ServerTile, serverForPort } from "./browserNewPageModel";
import type { BrowserCertificate } from "./useBrowserCertificate";
import { useStartServer, useThreadActionRuns } from "./useProjectServers";

// A refused port is the everyday "server isn't up yet" case, so its page is text and buttons only.
const ERROR_ICON: Record<Exclude<PreviewPageError["kind"], "connection-refused">, LucideIcon> = {
  network: WifiOff,
  certificate: ShieldAlert,
  crash: OctagonAlert,
  "file-not-found": FileX,
  blocked: ShieldAlert,
};

const SHOWS_ADDRESS: ReadonlySet<PreviewPageError["kind"]> = new Set(["file-not-found", "blocked"]);

/** Props for {@link BrowserErrorPage}. */
export interface BrowserErrorPageProps {
  /** Classified failure that put the page into its error phase. */
  readonly error: PreviewPageError;
  /** Address that failed to load. */
  readonly url: string | null;
  /** The thread whose project servers may explain a refused local port. */
  readonly threadId: string;
  /** Reloads the failed page. */
  readonly onRetry: () => void;
  /** Opens a project server's page once it is reachable. */
  readonly onOpen: (url: string) => void;
  /** Goes back in the tab's history, or to a new page when there is none. */
  readonly onBackToSafety: () => void;
  /** Certificate trust for this tab. */
  readonly certificate: BrowserCertificate;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function certificateRows(failure: BrowserCertificateFailure): readonly (readonly [string, string])[] {
  return [
    ["Error", failure.error],
    ["Subject", failure.subjectName],
    ["Issuer", failure.issuerName],
    ["Valid from", formatDate(failure.validStart)],
    ["Valid to", formatDate(failure.validExpiry)],
    ["Fingerprint", failure.fingerprint],
  ];
}

function CertificateDetails({ failure, fallbackCode, onProceed }: {
  readonly failure: BrowserCertificateFailure | null;
  readonly fallbackCode: string | undefined;
  readonly onProceed: (fingerprint: string) => void;
}) {
  const rows = failure ? certificateRows(failure) : [["Error", fallbackCode ?? ""] as const];
  const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  return (
    <div data-testid="browser-certificate-details" className="flex w-full flex-col gap-2 text-left">
      <dl className="flex flex-col gap-1 font-mono text-caption text-muted">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="w-20 shrink-0">{label}</dt>
            <dd className="min-w-0 flex-1 break-all text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between">
        {failure ? (
          <Button type="button" variant="destructive" shape="round" className="min-w-0 text-fade" onClick={() => onProceed(failure.fingerprint)}>
            Proceed to {failure.host} (unsafe)
          </Button>
        ) : <span />}
        <CopyButton text={text} label="Copy certificate details" />
      </div>
    </div>
  );
}

function CertificateActions({ error, certificate, onBackToSafety }: {
  readonly error: PreviewPageError;
  readonly certificate: BrowserCertificate;
  readonly onBackToSafety: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="flex items-center justify-center gap-2">
        <Button type="button" variant="ink" shape="round" onClick={onBackToSafety}>Back to safety</Button>
        <Button type="button" variant="subtle" shape="round" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          Details
        </Button>
      </div>
      {expanded ? (
        <CertificateDetails
          failure={certificate.state?.failure ?? null}
          fallbackCode={error.code}
          onProceed={(fingerprint) => void certificate.proceed(fingerprint)}
        />
      ) : null}
    </>
  );
}

function useProjectName(workspaceId: string): string | null {
  return useWorkspaceStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null);
}

function useServerTiles(threadId: string, url: string | null): { readonly tiles: readonly ServerTile[]; readonly tile: ServerTile | null } {
  const port = url === null ? null : loopbackPort(url);
  const runs = useThreadActionRuns(threadId, port !== null);
  const tiles = useMemo(() => projectServerTiles(runs, []), [runs]);
  return { tiles, tile: serverForPort(port, tiles) };
}

function ConnectionRefused({ error, url, threadId, onRetry, onOpen }: Pick<BrowserErrorPageProps, "error" | "url" | "threadId" | "onRetry" | "onOpen">) {
  const { tiles, tile } = useServerTiles(threadId, url);
  // Watching every tile, not just the one on this port, lets a restart that lands on another port still open its page.
  const { start, isRequesting } = useStartServer(tiles, onOpen);
  const project = useProjectName(tile?.run.workspaceId ?? "");
  const detail = tile
    ? `${error.detail} ${tile.name}${project ? ` in ${project}` : ""} usually runs here.`
    : error.detail;
  const starting = tile !== null && (isRequesting(tile.actionId) || tile.state === "starting");
  return (
    <>
      <PageText message={error.message} detail={detail} />
      <div className="flex items-center justify-center gap-2">
        {tile ? (
          <Button type="button" variant="ink" shape="round" className="text-code-small leading-[1.8rem] font-semibold px-3.5" disabled={starting} onClick={() => void start(tile)}>
            {starting ? "Starting" : `Start ${tile.name}`}
          </Button>
        ) : null}
        <Button type="button" variant={tile ? "subtle" : "ink"} shape="round" className="text-code-small leading-[1.8rem] font-medium px-3.5" data-testid="preview-error-retry" onClick={onRetry}>Retry</Button>
      </div>
    </>
  );
}

function PageText({ message, detail }: { readonly message: string; readonly detail: string | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p data-testid="preview-error-headline" className="text-body leading-[2.2rem] font-semibold text-ink">{message}</p>
      {detail ? <p data-testid="preview-error-detail" className="text-balance text-code-small text-muted">{detail}</p> : null}
    </div>
  );
}

function RetryButton({ onRetry, label = "Retry" }: { readonly onRetry: () => void; readonly label?: string }) {
  return (
    <div className="flex items-center justify-center">
      <Button type="button" variant="ink" shape="round" data-testid="preview-error-retry" onClick={onRetry}>{label}</Button>
    </div>
  );
}

/**
 * Page shown when a Browser page fails to load. Each failure kind names the problem in plain
 * words and offers the one next step that fits: Start for a stopped project server, Back to
 * safety for an untrusted certificate, Retry otherwise.
 */
export function BrowserErrorPage(props: BrowserErrorPageProps) {
  const { error, url, onRetry, onBackToSafety, certificate } = props;
  const Icon = error.kind === "connection-refused" ? null : ERROR_ICON[error.kind];
  // A blocked file stays blocked; retrying would only refuse again.
  const canRetry = error.kind !== "blocked";

  return (
    <div
      data-testid="preview-error-panel"
      data-kind={error.kind}
      role="alert"
      // `m-auto` centers the child while it fits and still scrolls when expanded details outgrow the panel.
      className="absolute inset-0 flex overflow-y-auto p-6 text-center motion-safe:animate-in motion-safe:fade-in"
    >
      <div className="m-auto flex w-80 max-w-full flex-col items-center gap-4">
        {Icon ? <Icon size={32} className="text-muted" aria-hidden /> : null}
        {error.kind === "connection-refused" ? (
          <ConnectionRefused {...props} />
        ) : (
          <>
            <PageText message={error.message} detail={error.detail} />
            {SHOWS_ADDRESS.has(error.kind) && url ? (
              <p className="max-w-full text-fade font-mono text-caption text-muted">{url}</p>
            ) : null}
            {error.kind === "certificate" ? (
              <CertificateActions error={error} certificate={certificate} onBackToSafety={onBackToSafety} />
            ) : canRetry ? (
              <RetryButton onRetry={onRetry} label={error.kind === "crash" ? "Reload" : "Retry"} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
