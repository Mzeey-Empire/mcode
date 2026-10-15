import { useCallback, useId, useMemo } from "react";
import { MousePointer2, X } from "lucide-react";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildStoredAttachmentImageSrc } from "@/lib/attachment-url";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewAnnotationStore, type PreviewPageRecord } from "../state/previewAnnotationStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "../state/previewTabsStore";
import {
  browserNotesTileLabel,
  browserPageLabel,
  groupBrowserNotes,
  type BrowserNoteGroup,
} from "./browserNoteGroups";
import { removePreviewNote } from "./previewNotes";

/** Props for the composer tile that carries a scope's Browser notes. */
export interface BrowserNotesTileProps {
  /** Scope that owns the notes: the thread, or the workspace before a thread exists. */
  readonly scopeId: string;
  /** Workspace whose right panel hosts the Browser. */
  readonly workspaceId: string;
  /** Thread that owns stored page images, when one exists. */
  readonly threadId?: string;
  /** Drops every Browser note in the scope. Review and Files comments stay. */
  readonly onRemoveAll: () => void;
}

function revealNotePage(
  workspaceId: string,
  scopeId: string,
  threadId: string | undefined,
  page: PreviewPageRecord,
): void {
  const diff = useDiffStore.getState();
  diff.showRightPanel(workspaceId, threadId);
  diff.setRightPanelTab(workspaceId, threadId, "preview");
  const tabs = usePreviewTabsStore.getState();
  const tabSet = tabs.tabSetByScope[previewTabsScopeKey(workspaceId, scopeId)];
  const existing = tabSet?.tabs.find(
    (tab) => tab.url && normalizePreviewPageIdentity(tab.url) === page.pageIdentity,
  );
  if (existing) void tabs.activatePage(workspaceId, scopeId, existing.id);
  else void tabs.openPage(workspaceId, scopeId, { activate: true, initialAddress: page.url });
}

function Thumbnail({ page, threadId }: { readonly page: PreviewPageRecord; readonly threadId?: string }) {
  const bytes = page.markedPng;
  const showBytes = useCallback((img: HTMLImageElement | null) => {
    if (!img || !bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/png" }));
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  const stored = page.marked && threadId
    ? buildStoredAttachmentImageSrc(threadId, page.marked.id, page.marked.mimeType)
    : null;
  const imageClass = "size-full object-cover object-top";
  return (
    <span className="block h-[98px] w-full shrink-0 overflow-clip bg-panel">
      {bytes
        ? <img ref={showBytes} alt="" className={imageClass} draggable={false} />
        : stored
          ? <img src={stored} alt="" className={imageClass} draggable={false} />
          : null}
    </span>
  );
}

function NoteRow({
  page,
  note,
  onOpen,
  onRemove,
}: {
  readonly page: PreviewPageRecord;
  readonly note: BrowserNoteGroup["notes"][number];
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const target = note.targetContext.label?.trim() || note.targetContext.selectorHint?.trim() || "element";
  return (
    <li className="group/row flex items-start rounded-lg focus-within:bg-hover hover:bg-hover">
      <button
        type="button"
        onClick={onOpen}
        data-testid="browser-note-row"
        className="flex min-w-0 flex-1 items-start gap-[10px] rounded-lg py-1.5 pl-[10px] pr-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-primary text-caption font-bold tabular-nums text-primary-ink">
          {note.displayNumber}
        </span>
        <span className="flex min-w-0 grow basis-0 flex-col">
          <span className="text-fade font-code text-caption text-muted">{target}</span>
          <span className="whitespace-pre-wrap break-words text-body-small text-ink">{note.note}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove note ${note.displayNumber} on ${browserPageLabel(page)}`}
        onClick={onRemove}
        className="pointer-events-none mr-1.5 mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-selected text-ink opacity-0 transition-opacity duration-150 focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 motion-reduce:transition-none"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

const CARD_CLASS = "absolute h-[132px] w-[176px] rounded-lg border bg-background";

function StackEdge() {
  return (
    <>
      <span aria-hidden className={`${CARD_CLASS} bottom-[12px] left-[12px] border-border`} />
      <span aria-hidden className={`${CARD_CLASS} bottom-[6px] left-[6px] border-control-border`} />
    </>
  );
}

/**
 * The composer tile for a scope's Browser notes. It shows the marked snapshot of the page
 * annotated last, with a stack edge when several pages carry notes. Hovering opens the notes
 * grouped by page.
 */
export function BrowserNotesTile({ scopeId, workspaceId, threadId, onRemoveAll }: BrowserNotesTileProps) {
  const cardId = useId();
  const notes = usePreviewAnnotationStore((state) => state.byThread[scopeId]);
  const pages = usePreviewAnnotationStore((state) => state.pages[scopeId]);
  const groups = useMemo(() => groupBrowserNotes(notes ?? [], pages ?? {}), [notes, pages]);
  const front = groups[0];
  if (!front) return null;

  const label = browserNotesTileLabel(groups);

  return (
    <section aria-label="Browser notes" className="px-3 pt-2" data-testid="browser-notes-tile">
      <Popover>
        <div className="group/tile relative h-[144px] w-[188px]">
          {groups.length > 1 ? <StackEdge /> : null}
          <PopoverTrigger
            openOnHover
            delay={0}
            closeDelay={100}
            aria-label={`${label}. Notes available.`}
            aria-controls={cardId}
            onClick={() => revealNotePage(workspaceId, scopeId, threadId, front.page)}
            className="absolute bottom-0 left-0 flex h-[132px] w-[176px] flex-col overflow-clip rounded-lg border border-border bg-panel text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Thumbnail page={front.page} threadId={threadId} />
            <span className="flex h-8 w-full shrink-0 items-center gap-2 bg-hover px-2">
              <MousePointer2 size={16} className="shrink-0 text-primary" aria-hidden />
              <span className="text-fade min-w-0 flex-1 text-body-small font-label text-ink">{label}</span>
            </span>
          </PopoverTrigger>
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={onRemoveAll}
            className="pointer-events-none absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-selected text-ink opacity-0 transition-opacity duration-150 focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/tile:pointer-events-auto group-focus-within/tile:opacity-100 group-hover/tile:pointer-events-auto group-hover/tile:opacity-100 motion-reduce:transition-none"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
        <PopoverContent
          id={cardId}
          aria-label={`${label} notes`}
          side="top"
          align="start"
          className="w-[340px] rounded-[14px] p-1.5"
          data-testid="browser-notes-card"
        >
          {groups.map((group, index) => (
            <div key={group.page.pageIdentity}>
              {index > 0 ? <div className="mx-1.5 my-1 h-px bg-border" /> : null}
              <div className="flex h-7 items-center gap-2 px-[10px]">
                <span className="size-3 shrink-0 rounded-[3px] bg-selected" aria-hidden />
                <span className="text-fade min-w-0 grow text-xs font-medium text-muted">
                  {browserPageLabel(group.page)}
                </span>
              </div>
              <ul>
                {group.notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    page={group.page}
                    note={note}
                    onOpen={() => revealNotePage(workspaceId, scopeId, threadId, group.page)}
                    onRemove={() => removePreviewNote(scopeId, note.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </section>
  );
}
