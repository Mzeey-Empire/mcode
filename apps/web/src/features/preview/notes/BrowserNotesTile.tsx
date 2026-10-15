import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MousePointer2, X } from "lucide-react";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import { Popover, PopoverContent, PopoverTrigger, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
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
import { readStagedDraftImage } from "./stagedDraftImages";

/** Props for the composer tile that carries a scope's Browser notes. */
export interface BrowserNotesTileProps {
  /** Scope that owns the notes: the thread, or the workspace before a thread exists. */
  readonly scopeId: string;
  /** Workspace whose right panel hosts the Browser. */
  readonly workspaceId: string;
  /** Thread the right panel is bound to, when one exists. */
  readonly threadId?: string;
  /** Drops every Browser note in the scope. Review and Files comments stay. */
  readonly onRemoveAll: () => void;
}

type BrowserNote = BrowserNoteGroup["notes"][number];

async function revealNotePage(
  workspaceId: string,
  scopeId: string,
  threadId: string | undefined,
  page: PreviewPageRecord,
  note: BrowserNote | undefined,
): Promise<void> {
  const diff = useDiffStore.getState();
  diff.showRightPanel(workspaceId, threadId);
  diff.setRightPanelTab(workspaceId, threadId, "preview");
  const tabs = usePreviewTabsStore.getState();
  const tabSet = tabs.tabSetByScope[previewTabsScopeKey(workspaceId, scopeId)];
  const existing = tabSet?.tabs.find(
    (tab) => tab.url && normalizePreviewPageIdentity(tab.url) === page.pageIdentity,
  );
  if (existing) await tabs.activatePage(workspaceId, scopeId, existing.id);
  else if (!(await tabs.openPage(workspaceId, scopeId, { activate: true, initialAddress: page.url }))) return;
  if (!note) return;
  const { bounds, selectorHint } = note.targetContext;
  await window.desktopBridge?.preview?.design?.revealNote({ selector: selectorHint?.trim() || null, bounds });
}

type ThumbnailState = { readonly url: string } | "missing" | "loading";

/** Loads the page's image from draft storage, falling back to the clean screenshot while a redraw is pending. */
function useThumbnail(page: PreviewPageRecord, scopeId: string): ThumbnailState {
  const image = page.snapshot ?? page.clean?.image ?? null;
  const [state, setState] = useState<ThumbnailState>("loading");
  useEffect(() => {
    if (!image) return;
    let url: string | null = null;
    let cancelled = false;
    void readStagedDraftImage(scopeId, image).then((bytes) => {
      if (cancelled) return;
      if (!bytes) {
        setState("missing");
        return;
      }
      url = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/png" }));
      setState({ url });
    }, () => {
      if (!cancelled) setState("missing");
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [image, scopeId]);
  return image ? state : "missing";
}

function Thumbnail({ page, scopeId }: { readonly page: PreviewPageRecord; readonly scopeId: string }) {
  const thumbnail = useThumbnail(page, scopeId);
  return (
    <span className="block h-[98px] w-full shrink-0 overflow-clip bg-panel">
      {typeof thumbnail === "object"
        ? <img src={thumbnail.url} alt="" className="size-full object-cover object-top" draggable={false} />
        : thumbnail === "missing"
          ? <span className="flex size-full items-center justify-center text-body-small text-muted">Retake</span>
          : null}
    </span>
  );
}

/** Flags a page in the card whose image is gone, so a missing snapshot is visible on every page and not only the front one. */
function RetakeFlag({ page, scopeId }: { readonly page: PreviewPageRecord; readonly scopeId: string }) {
  return useThumbnail(page, scopeId) === "missing"
    ? <span className="shrink-0 text-caption text-muted">Retake</span>
    : null;
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
  const [open, setOpen] = useState(false);
  // Escape from inside the card hands focus back to the trigger; that focus must not reopen it.
  const escaped = useRef(false);
  const onOpenChange = (next: boolean, details: PopoverRootChangeEventDetails) => {
    escaped.current = details.reason === "escape-key";
    setOpen(next);
  };
  const notes = usePreviewAnnotationStore((state) => state.byThread[scopeId]);
  const pages = usePreviewAnnotationStore((state) => state.pages[scopeId]);
  const groups = useMemo(() => groupBrowserNotes(notes ?? [], pages ?? {}), [notes, pages]);
  const front = groups[0];
  if (!front) return null;

  const label = browserNotesTileLabel(groups);

  return (
    <section aria-label="Browser notes" className="px-3 pt-2" data-testid="browser-notes-tile">
      <Popover open={open} onOpenChange={onOpenChange}>
        <div className="group/tile relative h-[144px] w-[188px]">
          {groups.length > 1 ? <StackEdge /> : null}
          <PopoverTrigger
            openOnHover
            delay={0}
            closeDelay={100}
            aria-label={`${label}. Notes available.`}
            aria-controls={cardId}
            onFocus={(event) => {
              if (!escaped.current && event.currentTarget.matches(":focus-visible")) setOpen(true);
              escaped.current = false;
            }}
            onBlur={() => {
              escaped.current = false;
            }}
            onClick={() => void revealNotePage(workspaceId, scopeId, threadId, front.page, front.notes[0])}
            className="absolute bottom-0 left-0 flex h-[132px] w-[176px] flex-col overflow-clip rounded-lg border border-border bg-panel text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Thumbnail page={front.page} scopeId={scopeId} />
            <span className="flex h-8 w-full shrink-0 items-center gap-2 bg-hover px-2">
              <MousePointer2 size={16} className="shrink-0 text-primary" aria-hidden />
              <span className="text-fade min-w-0 flex-1 text-body-small font-label text-ink">{label}</span>
            </span>
          </PopoverTrigger>
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={onRemoveAll}
            className="pointer-events-none absolute right-1 top-1 flex size-8 items-center justify-center rounded-full bg-selected text-ink opacity-0 transition-opacity duration-150 focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/tile:pointer-events-auto group-focus-within/tile:opacity-100 group-hover/tile:pointer-events-auto group-hover/tile:opacity-100 motion-reduce:transition-none"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <PopoverContent
          id={cardId}
          aria-label={`${label} notes`}
          side="top"
          align="start"
          className="max-h-(--available-height) w-[340px] overflow-y-auto rounded-[14px] p-1.5"
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
                <RetakeFlag page={group.page} scopeId={scopeId} />
              </div>
              <ul>
                {group.notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    page={group.page}
                    note={note}
                    onOpen={() => void revealNotePage(workspaceId, scopeId, threadId, group.page, note)}
                    onRemove={() => {
                      removePreviewNote(scopeId, note.id);
                      if (usePreviewAnnotationStore.getState().getThreadAnnotations(scopeId).length === 0) onRemoveAll();
                    }}
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
