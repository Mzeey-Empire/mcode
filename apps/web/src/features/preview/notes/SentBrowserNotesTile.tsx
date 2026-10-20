import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { MousePointer2 } from "lucide-react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { ImageAttachmentLightbox } from "@/components/chat/ImageAttachmentLightbox";
import { useRetriableAttachmentImage } from "@/components/chat/useRetriableAttachmentImage";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildStoredAttachmentImageSrc,
  getAttachmentTransportUrlSnapshot,
  subscribeToAttachmentTransportUrl,
} from "@/lib/attachment-url";
import { AnnotationMarker } from "@/components/ui/annotation-marker";
import { cn } from "@/lib/utils";
import { readSentNotes, type SentNotesModel, type SentNotesPage } from "./sentBrowserNotes";

/** Props for the read-only tile that carries a sent or queued message's notes. */
export interface SentBrowserNotesTileProps {
  /** The message's feedback bundle, v1 or v2. */
  readonly bundle: PreviewAnnotationBundle;
  /** Thread that stores the page snapshots. Absent for a queued message, whose images are not stored yet. */
  readonly threadId?: string;
  /** `row` is the one-line form for queued follow-ups; `bubble` rides above a sent message. */
  readonly variant?: "bubble" | "row";
}

const EDGE_CLASS = "absolute inset-0 rounded-md border bg-background";

function Thumbnail({ src, stacked }: { readonly src: string | null; readonly stacked: boolean }) {
  const image = useRetriableAttachmentImage(src ?? "");
  return (
    <span className="relative block h-[44px] w-16 shrink-0">
      {stacked ? (
        <>
          <span aria-hidden className={`${EDGE_CLASS} translate-x-2 -translate-y-2 border-border`} />
          <span aria-hidden className={`${EDGE_CLASS} translate-x-1 -translate-y-1 border-control-border`} />
        </>
      ) : null}
      <span className="absolute inset-0 overflow-clip rounded-md border border-border bg-background">
        {src && !image.failed ? (
          <img src={image.src} alt="" draggable={false} onError={image.onError} onLoad={image.onLoad} className="size-full object-cover object-top" />
        ) : null}
      </span>
    </span>
  );
}

function NoteRowBody({ number, target, text }: { readonly number: number; readonly target: string; readonly text: string }) {
  return (
    <>
      <AnnotationMarker displayNumber={number} className="-my-0.5 size-5 text-primary" numberClassName="text-caption text-primary-ink" />
      <span className="flex min-w-0 grow basis-0 flex-col">
        <span className="text-fade font-code text-caption text-muted">{target}</span>
        <span className="whitespace-pre-wrap break-words text-body-small text-ink">{text}</span>
      </span>
    </>
  );
}

const ROW_CLASS = "flex w-full items-start gap-[10px] rounded-lg py-1.5 pl-[10px] pr-1.5 text-left";

function NotesCard({ id, model, label, canOpen, onOpen }: {
  readonly id: string;
  readonly model: SentNotesModel;
  readonly label: string;
  readonly canOpen: (page: SentNotesPage) => boolean;
  readonly onOpen: (page: SentNotesPage) => void;
}) {
  return (
    <PopoverContent
      id={id}
      aria-label={`${label} details`}
      side="top"
      align="end"
      initialFocus={false}
      className="max-h-(--available-height) w-[340px] overflow-y-auto rounded-[14px] p-1.5"
      data-testid="sent-browser-notes-card"
    >
      {model.pages.map((page, index) => (
        <div key={page.pageIdentity}>
          {index > 0 ? <div className="mx-1.5 my-1 h-px bg-border" /> : null}
          <div className="flex h-7 items-center gap-2 px-[10px]">
            <span className="size-3 shrink-0 rounded-[3px] bg-selected" aria-hidden />
            <span className="text-fade min-w-0 grow text-xs font-medium text-muted">{page.label}</span>
          </div>
          <ul>
            {page.notes.map((note) => (
              <li key={note.id} className="rounded-lg hover:bg-hover focus-within:bg-hover">
                <button
                  type="button"
                  disabled={!canOpen(page)}
                  onClick={() => onOpen(page)}
                  data-testid="sent-browser-note-row"
                  className={cn(ROW_CLASS, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus")}
                >
                  <NoteRowBody number={note.displayNumber} target={note.target} text={note.text} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {model.codeComments.length > 0 ? (
        <div>
          {model.pages.length > 0 ? <div className="mx-1.5 my-1 h-px bg-border" /> : null}
          <div className="flex h-7 items-center px-[10px] text-xs font-medium text-muted">Comments</div>
          <ul>
            {model.codeComments.map((comment) => (
              <li key={comment.id} className={ROW_CLASS} data-testid="sent-code-comment-row">
                <NoteRowBody number={comment.displayNumber} target={comment.location} text={comment.text} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PopoverContent>
  );
}

/**
 * A sent or queued message's notes as one compact tile. It shows the page annotated last with a
 * stack edge when several pages carry notes. Hovering lists the notes grouped by page, and clicking
 * a note opens that page's marked snapshot in the image viewer.
 */
export function SentBrowserNotesTile({ bundle, threadId, variant = "bubble" }: SentBrowserNotesTileProps) {
  const cardId = useId();
  const [viewer, setViewer] = useState<number | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const model = useMemo(() => readSentNotes(bundle), [bundle]);
  const attachmentTransportUrl = useSyncExternalStore(
    subscribeToAttachmentTransportUrl,
    getAttachmentTransportUrlSnapshot,
    getAttachmentTransportUrlSnapshot,
  );
  const slides = useMemo(() => {
    void attachmentTransportUrl;
    if (!model || !threadId) return [];
    return model.pages.flatMap((page) => page.snapshot
      ? [{ pageIdentity: page.pageIdentity, src: buildStoredAttachmentImageSrc(threadId, page.snapshot.id, page.snapshot.mimeType), title: page.snapshot.name }]
      : []);
  }, [attachmentTransportUrl, model, threadId]);
  if (!model) return null;

  const open = (page: SentNotesPage | undefined) => {
    const index = slides.findIndex((slide) => slide.pageIdentity === page?.pageIdentity);
    if (index >= 0) setViewer(index);
  };
  const canOpen = (page: SentNotesPage) => slides.some((slide) => slide.pageIdentity === page.pageIdentity);
  const frontSlide = slides.find((slide) => slide.pageIdentity === model.front?.pageIdentity);
  const compact = variant === "row";

  return (
    <>
      <Popover open={cardOpen} onOpenChange={setCardOpen}>
        <PopoverTrigger
          openOnHover
          delay={0}
          closeDelay={100}
          onFocus={(event) => {
            // Keyboard-only: a mouse click focuses the tile too, and would reopen the card after the viewer closes.
            if (event.currentTarget.matches(":focus-visible")) setCardOpen(true);
          }}
          aria-label={`${model.label}. Details available.`}
          aria-controls={cardId}
          data-testid="sent-browser-notes-tile"
          onClick={() => open(model.front)}
          className={cn(
            "flex min-w-0 items-center border border-border bg-panel text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            compact ? "h-7 shrink-0 gap-1.5 rounded-md px-2" : "gap-3 rounded-[10px] py-[10px] pl-[10px] pr-[14px]",
          )}
        >
          {compact ? null : <Thumbnail src={frontSlide?.src ?? null} stacked={model.pages.length > 1} />}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <MousePointer2 size={12} className="shrink-0 text-primary" aria-hidden />
              <span className="whitespace-nowrap text-sm text-ink">{model.label}</span>
            </span>
            {compact ? null : <span className="text-fade text-xs text-muted">{model.detail}</span>}
          </span>
        </PopoverTrigger>
        <NotesCard id={cardId} model={model} label={model.label} canOpen={canOpen} onOpen={open} />
      </Popover>
      <ImageAttachmentLightbox
        open={viewer !== null}
        onOpenChange={(next) => {
          if (!next) setViewer(null);
        }}
        items={slides}
        initialIndex={viewer ?? 0}
      />
    </>
  );
}
