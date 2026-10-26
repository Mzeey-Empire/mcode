import { Spinner } from "@/components/ui/spinner";
import { StickyUserMessage } from "@/components/chat/StickyUserMessage";
import type { SelectedTextComment } from "@mcode/contracts";
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import type { Message } from "@/transport/types";
import type { ViewportInsets } from "@/components/ui/virtual-viewport";
import { JumpToLatestPill } from "./JumpToLatestPill";
import { SelectedTextCommentControls } from "./selection/SelectedTextCommentControls";
import type { SelectedTextCommentEditorScope } from "./selection/SelectedTextCommentControls";
import { SelectedTextCommentMarkers } from "./selection/SelectedTextCommentMarkers";

/** Gap between the top of the composer chrome and the composer card. */
export const COMPOSER_CARD_OFFSET = 16;

/** Props for transcript controls that float above the virtual rows. */
interface MessageListOverlaysProps {
  readonly messages: Message[];
  readonly isLoadingMore: boolean;
  readonly isLoadingNewer: boolean;
  readonly onSelectedTextComment: ((comment: SelectedTextComment) => void) | undefined;
  readonly onDeleteSelectedTextComment: ((comment: SelectedTextComment) => void) | undefined;
  readonly onSelectedTextCommentEditorChange:
    | ((editor: SelectedTextCommentEditorDraft | undefined) => void)
    | undefined;
  readonly selectedTextCommentEditor: SelectedTextCommentEditorDraft | undefined;
  readonly selectedTextCommentEditorScope: SelectedTextCommentEditorScope | undefined;
  readonly onOpenSelectedTextCommentEditor: ((comment: SelectedTextComment) => void) | undefined;
  /** Scroll viewport that bounds selected-text controls. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** Thread whose transcript is currently rendered in the viewport. */
  readonly renderedThreadId: string | null | undefined;
  readonly stickyPreview: string | null;
  readonly contentPaddingRight?: string;
  readonly isStickyVisible: boolean;
  readonly onJumpToUserMessage: () => void;
  /** Header and composer chrome the overlays sit inside of. */
  readonly chromeInsets: ViewportInsets;
  readonly showJumpToLatest: boolean;
  readonly onJumpToLatest: () => void;
}

/** Renders transcript affordances that are independent of virtual row layout. */
export function MessageListOverlays({
  messages,
  isLoadingMore,
  isLoadingNewer,
  onSelectedTextComment,
  onDeleteSelectedTextComment,
  onSelectedTextCommentEditorChange,
  selectedTextCommentEditor,
  selectedTextCommentEditorScope,
  onOpenSelectedTextCommentEditor,
  viewportRef,
  renderedThreadId,
  stickyPreview,
  contentPaddingRight,
  isStickyVisible,
  onJumpToUserMessage,
  chromeInsets,
  showJumpToLatest,
  onJumpToLatest,
}: MessageListOverlaysProps) {
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages]);

  return (
    <>
      {onSelectedTextComment && (
        <SelectedTextCommentControls
          key={renderedThreadId ?? "no-rendered-thread"}
          onSelectedTextComment={onSelectedTextComment}
          onDeleteSelectedTextComment={onDeleteSelectedTextComment}
          editor={selectedTextCommentEditor}
          onSelectedTextCommentEditorChange={onSelectedTextCommentEditorChange}
          selectedTextCommentEditorScope={selectedTextCommentEditorScope}
          viewportRef={viewportRef}
          renderedThreadId={renderedThreadId}
          messageIds={messageIds}
        />
      )}
      {onOpenSelectedTextCommentEditor && (
        <SelectedTextCommentMarkers
          viewportRef={viewportRef}
          renderedThreadId={renderedThreadId}
          editor={selectedTextCommentEditor}
          onOpenComment={onOpenSelectedTextCommentEditor}
        />
      )}
      {/* Equal-layer indicators follow the markers so loading and sticky content stay above them.
          The anchors hang them from the chrome edges instead of the transcript's. */}
      <div className="absolute inset-x-0" style={{ top: chromeInsets.top }}>
        {isLoadingMore && <PaginationIndicator placement="top" delayMs={300} />}
        {stickyPreview && (
          <StickyUserMessage
            key={stickyPreview}
            preview={stickyPreview}
            contentPaddingRight={contentPaddingRight}
            visible={isStickyVisible}
            onJumpToMessage={onJumpToUserMessage}
          />
        )}
      </div>
      <div className="absolute inset-x-0" style={{ bottom: chromeInsets.bottom }}>
        {isLoadingNewer && <PaginationIndicator placement="bottom" delayMs={300} />}
      </div>
      {showJumpToLatest && (
        // The right inset keeps the pill off the docked overview's reserve so it centres on the
        // conversation column.
        <div
          className="pointer-events-none absolute left-0 h-14"
          style={{ right: contentPaddingRight ?? 0, bottom: chromeInsets.bottom - COMPOSER_CARD_OFFSET }}
        >
          {/* A hidden-overflow box with a stable gutter reserves the transcript scrollbar's width, and
              its vertical padding leaves room for the pill's shadow. */}
          <div className="absolute inset-x-0 bottom-2.5 flex justify-center overflow-y-hidden py-6 [scrollbar-gutter:stable]">
            <JumpToLatestPill onJumpToLatest={onJumpToLatest} />
          </div>
        </div>
      )}
    </>
  );
}

/** Displays progress while directional message history is loading. */
function PaginationIndicator({ placement, delayMs = 0 }: { readonly placement: "top" | "bottom"; readonly delayMs?: number }) {
  // Local history fetches usually resolve fast enough that showing the spinner
  // every time would flash; it only earns visibility on slow loads.
  const [visible, setVisible] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  const positionClass = placement === "top" ? "top-2" : "bottom-2";
  if (!visible) return null;
  return (
    <div className={`absolute ${positionClass} left-1/2 z-(--layer-sticky) -translate-x-1/2`}>
      <div className="rounded-md border border-border/40 bg-background/80 px-2 py-1 backdrop-blur-sm">
        <Spinner size={16} className="text-muted/70" />
      </div>
    </div>
  );
}
