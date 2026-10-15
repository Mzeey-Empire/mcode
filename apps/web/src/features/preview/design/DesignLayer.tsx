/**
 * Owns annotation markers, the note bubble and autocomplete rendering. Picker state and effects are supplied explicitly from the parent hooks.
 */
import { Fragment, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, Trash2 } from "lucide-react";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import { removePreviewNote, savePreviewNote } from "../notes/previewNotes";
import type { PreviewPageScroll } from "../state/previewPageScrollStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SlashCommandTray } from "@/components/chat/SlashCommandTray";
import type { Command } from "@/components/chat/useSlashCommand";
import { FileTagPopup } from "@/components/chat/FileTagPopup";
import type { useDesignAnnotationEditor } from "./useDesignAnnotationEditor";
import type { usePreviewPage } from "../surfaces/usePreviewPage";
import type { useDesignAnnotationState } from "./useDesignAnnotationState";
import {
  boundsAtScroll,
  visibleAnnotationState,
  BUBBLE_SURFACE_INSET,
  annotationBubbleClassName,
  annotationBubbleStyle,
  BUBBLE_SURFACE,
} from "./annotationBubble";
import { RenderValue } from "../surfaces/previewRender";

interface DesignLayerProps {
  readonly openBubbleBase: ReturnType<typeof useDesignAnnotationEditor>["openBubbleBase"];
  readonly bubbleNote: ReturnType<typeof useDesignAnnotationEditor>["bubbleNote"];
  readonly setOutsideWarned: ReturnType<typeof useDesignAnnotationEditor>["setOutsideWarned"];
  readonly capture: ReturnType<typeof usePreviewPage>["capture"];
  readonly pageAnnotations: ReturnType<typeof useDesignAnnotationEditor>["pageAnnotations"];
  readonly threadId: string;
  readonly editingAnnotationId: ReturnType<typeof useDesignAnnotationState>["editingAnnotationId"];
  readonly setEditingAnnotationId: ReturnType<typeof useDesignAnnotationState>["setEditingAnnotationId"];
  readonly requestComposerSubmit: () => void;
  readonly onBubbleSlashSelect: ReturnType<typeof useDesignAnnotationState>["onBubbleSlashSelect"];
  readonly setBubbleNote: ReturnType<typeof useDesignAnnotationEditor>["setBubbleNote"];
  readonly bubbleNoteInputRef: ReturnType<typeof useDesignAnnotationState>["bubbleNoteInputRef"];
  readonly onBubbleSlashKeyDown: ReturnType<typeof useDesignAnnotationState>["onBubbleSlashKeyDown"];
  readonly bubbleSlashItems: ReturnType<typeof useDesignAnnotationState>["bubbleSlashItems"];
  readonly bubbleSlashSelectedIndex: ReturnType<typeof useDesignAnnotationState>["bubbleSlashSelectedIndex"];
  readonly bubbleFileOpen: ReturnType<typeof useDesignAnnotationState>["bubbleFileOpen"];
  readonly bubbleFilePopup: ReturnType<typeof useDesignAnnotationEditor>["bubbleFilePopup"];
  readonly bubbleSlashOpen: ReturnType<typeof useDesignAnnotationState>["bubbleSlashOpen"];
  readonly designModeActive: ReturnType<typeof useDesignAnnotationState>["designModeActive"];
  readonly bubbleRef: ReturnType<typeof useDesignAnnotationState>["bubbleRef"];
  readonly outsideWarned: ReturnType<typeof useDesignAnnotationEditor>["outsideWarned"];
  readonly bubbleInputFocused: ReturnType<typeof useDesignAnnotationState>["bubbleInputFocused"];
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  readonly pageScroll: PreviewPageScroll;
  readonly onBubbleSlashInputChange: ReturnType<typeof useDesignAnnotationState>["onBubbleSlashInputChange"];
  readonly onBubbleFileInputChange: ReturnType<typeof useDesignAnnotationState>["onBubbleFileInputChange"];
  readonly setBubbleInputFocused: ReturnType<typeof useDesignAnnotationState>["setBubbleInputFocused"];
  readonly canSaveOpenBubble: ReturnType<typeof useDesignAnnotationEditor>["canSaveOpenBubble"];
  readonly bubbleSlashState: ReturnType<typeof useDesignAnnotationState>["bubbleSlashState"];
  readonly bubbleSlashAnchorRect: ReturnType<typeof useDesignAnnotationState>["bubbleSlashAnchorRect"];
  readonly dismissBubbleSlash: ReturnType<typeof useDesignAnnotationState>["dismissBubbleSlash"];
  readonly retryBubbleSlash: ReturnType<typeof useDesignAnnotationState>["retryBubbleSlash"];
  readonly bubbleFileSuggestions: ReturnType<typeof useDesignAnnotationState>["bubbleFileSuggestions"];
  readonly handleBubbleMentionSelect: ReturnType<typeof useDesignAnnotationEditor>["handleBubbleMentionSelect"];
  readonly filePopupAnchorRect: ReturnType<typeof useDesignAnnotationState>["filePopupAnchorRect"];
}

const SAVED_OUTLINE_SHADOW = "0 0 0 2px color-mix(in srgb, var(--color-primary) 55%, transparent)";

const MARKER_RADIUS_PX = 10;

/** Renders the saved-note outlines and numbered markers, the open note bubble and its editor without adding a DOM wrapper. */
export function DesignLayer({
  openBubbleBase,
  bubbleNote,
  setOutsideWarned,
  capture,
  pageAnnotations,
  threadId,
  editingAnnotationId,
  setEditingAnnotationId,
  requestComposerSubmit,
  onBubbleSlashSelect,
  setBubbleNote,
  bubbleNoteInputRef,
  onBubbleSlashKeyDown,
  bubbleSlashItems,
  bubbleSlashSelectedIndex,
  bubbleFileOpen,
  bubbleFilePopup,
  bubbleSlashOpen,
  designModeActive,
  bubbleRef,
  outsideWarned,
  bubbleInputFocused,
  surfaceWidth,
  surfaceHeight,
  pageScroll,
  onBubbleSlashInputChange,
  onBubbleFileInputChange,
  setBubbleInputFocused,
  canSaveOpenBubble,
  bubbleSlashState,
  bubbleSlashAnchorRect,
  dismissBubbleSlash,
  retryBubbleSlash,
  bubbleFileSuggestions,
  handleBubbleMentionSelect,
  filePopupAnchorRect,
}: DesignLayerProps) {
  const saveOpenBubble = async (
    options: { readonly sendAfterSave?: boolean } = {},
  ): Promise<void> => {
    if (!openBubbleBase) return;
    if (bubbleNote.trim().length === 0) {
      setOutsideWarned(true);
      return;
    }
    const clean = await capture.captureCleanPage();
    if (!clean) return;
    await savePreviewNote(
      threadId,
      { ...openBubbleBase, note: bubbleNote },
      clean,
      editingAnnotationId ?? undefined,
    );
    setEditingAnnotationId(null);
    setOutsideWarned(false);
    if (options.sendAfterSave) requestComposerSubmit();
  };

  const applyBubbleSlashCommand = (command: Command): void => {
    onBubbleSlashSelect(command, (next) => {
      if (next.length > 4000) return;
      setBubbleNote(next);
      setOutsideWarned(false);
      const input = bubbleNoteInputRef.current;
      if (!input) return;
      window.requestAnimationFrame(() => {
        input.setSelectionRange(next.length, next.length);
      });
    });
  };

  const handleBubbleSlashKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    onBubbleSlashKeyDown(event);
    if (event.isDefaultPrevented()) return;
    if (event.key !== "Enter" && event.key !== "Tab") return;
    const command = bubbleSlashItems[bubbleSlashSelectedIndex];
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    applyBubbleSlashCommand(command);
  };

  const onBubbleNoteKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (bubbleFileOpen && bubbleFilePopup.handleKeyDown(event)) return;
    if (bubbleSlashOpen) {
      handleBubbleSlashKeyDown(event);
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void saveOpenBubble({ sendAfterSave: event.ctrlKey || event.metaKey });
  };

  const deleteOpenBubble = (): void => {
    if (editingAnnotationId) {
      removePreviewNote(threadId, editingAnnotationId);
    } else {
      usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    }
    setEditingAnnotationId(null);
    setOutsideWarned(false);
  };

  const {
    openBubbleBase: visibleOpenBubbleBase,
    pageAnnotations: visiblePageAnnotations,
  } = visibleAnnotationState(
    designModeActive,
    openBubbleBase,
    pageAnnotations,
  );
  const openBubble = visibleOpenBubbleBase && {
    ...visibleOpenBubbleBase,
    bounds: boundsAtScroll(
      visibleOpenBubbleBase.bounds,
      visibleOpenBubbleBase.pageContext.viewportScroll,
      pageScroll,
    ),
  };

  return (
    <>
        {visiblePageAnnotations.map((annotation) => {
          const bounds = boundsAtScroll(annotation.targetContext.bounds, undefined, pageScroll);
          const targetLabel =
            annotation.targetContext.label?.trim() ||
            annotation.targetContext.selectorHint?.trim() ||
            "Element";
          const { note } = annotation;
          return (
            <Fragment key={annotation.id}>
              <div
                aria-hidden
                data-testid="preview-annotation-outline"
                className="pointer-events-none absolute z-(--layer-sticky) rounded-sm"
                style={{
                  left: bounds.x,
                  top: bounds.y,
                  width: bounds.width,
                  height: bounds.height,
                  boxShadow: SAVED_OUTLINE_SHADOW,
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-testid="preview-annotation-marker"
                      className="pointer-events-auto absolute z-(--layer-dropdown) flex size-5 items-center justify-center rounded-full bg-primary text-caption font-bold tabular-nums text-primary-ink shadow-floating"
                      style={{ left: bounds.x - MARKER_RADIUS_PX, top: bounds.y - MARKER_RADIUS_PX }}
                      onClick={() => {
                        setEditingAnnotationId(annotation.id);
                      }}
                      aria-label={`Edit annotation ${annotation.displayNumber}`}
                    >
                      {annotation.displayNumber}
                    </button>
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={8}
                  className="max-w-72 flex-col items-start gap-1.5 rounded-lg border border-border px-3 py-2 text-ink shadow-floating"
                  style={
                    {
                      backgroundColor: BUBBLE_SURFACE_INSET,
                      "--tooltip-arrow-bg": BUBBLE_SURFACE_INSET,
                    } as React.CSSProperties
                  }
                  arrowClassName="fill-panel stroke-border"
                >
                  <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-xs text-muted">
                    {targetLabel}
                  </span>
                  <span className="whitespace-pre-wrap text-xs leading-snug">
                    {note}
                  </span>
                </TooltipContent>
              </Tooltip>
            </Fragment>
          );
        })}
        <RenderValue value={openBubble}>
          {(annotation) => (
            <div
              data-testid="preview-annotation-active-target-highlight"
              className="pointer-events-none absolute z-(--layer-sticky) rounded-sm border-2 border-primary/80 bg-primary/10"
              style={{
                left: annotation.bounds.x,
                top: annotation.bounds.y,
                width: annotation.bounds.width,
                height: annotation.bounds.height,
              }}
            />
          )}
        </RenderValue>
        <RenderValue value={openBubble}>
          {() => (
            <div
              aria-hidden
              data-testid="preview-annotation-discard-overlay"
              className="pointer-events-auto absolute inset-0 z-(--layer-dropdown) bg-transparent"
            />
          )}
        </RenderValue>
        <RenderValue value={openBubble}>
          {(openBubble) => (
          <div
            ref={bubbleRef}
            data-testid="preview-annotation-bubble"
            className={annotationBubbleClassName(
              outsideWarned,
              bubbleInputFocused,
            )}
            style={{
              ...annotationBubbleStyle(
                openBubble.bounds,
                surfaceWidth,
                surfaceHeight,
              ),
              backgroundColor: BUBBLE_SURFACE,
              color: "var(--ink)",
            }}
          >
            <div className="flex flex-col gap-2 p-2.5">
              {/* No relative wrapper needed because FileTagPopup now uses fixed
                  positioning via anchorRect, escaping the overflow-hidden bubble. */}
              <Input
                ref={bubbleNoteInputRef}
                value={bubbleNote}
                onChange={(event) => {
                  const { value, selectionStart } = event.target;
                  setBubbleNote(value);
                  setOutsideWarned(false);
                  const cursor = selectionStart ?? value.length;
                  // Notify slash-command hook first; if it opens, dismiss the
                  // file autocomplete so both popups never show simultaneously.
                  onBubbleSlashInputChange(value, cursor);
                  onBubbleFileInputChange(value, cursor);
                }}
                onKeyDown={onBubbleNoteKeyDown}
                onFocus={() => setBubbleInputFocused(true)}
                onBlur={() => setBubbleInputFocused(false)}
                className="h-5 min-w-0 border-0 bg-transparent p-0 text-body-small text-ink shadow-none outline-none placeholder:text-muted focus-visible:outline-0 focus-visible:ring-0"
                maxLength={4000}
                placeholder="Comment · / for skills · @ to mention"
                aria-label="Annotation note"
              />
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 text-xs leading-4 text-muted">Enter to save</span>
                {canSaveOpenBubble ? (
                  <Button
                    type="button"
                    data-testid="preview-annotation-save"
                    size="icon-compact"
                    className="size-7 shrink-0 rounded-full bg-ink text-background hover:bg-ink/90"
                    aria-label="Save annotation"
                    onClick={() => void saveOpenBubble()}
                  >
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
            {editingAnnotationId ? (
              <div
                className="flex items-center justify-between border-t border-border px-3 py-2"
                style={{ backgroundColor: BUBBLE_SURFACE_INSET }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-compact"
                  className="rounded-full text-muted hover:bg-error/[0.18] hover:text-error"
                  aria-label="Delete annotation"
                  onClick={deleteOpenBubble}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    className="h-7 rounded-full px-3 text-ink hover:bg-hover"
                    onClick={() => {
                      usePreviewAnnotationStore
                        .getState()
                        .setDraft(threadId, undefined);
                      setEditingAnnotationId(null);
                      setOutsideWarned(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    className="h-7 rounded-full bg-ink px-3 text-background hover:bg-ink/90 disabled:bg-selected disabled:text-muted"
                    disabled={!canSaveOpenBubble}
                    onClick={() => void saveOpenBubble()}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          )}
        </RenderValue>
        {/* Both autocomplete popups render outside the bubble div (fixed
            position) so they can escape its overflow-hidden container. */}
        <SlashCommandTray
          state={bubbleSlashState}
          selectedIndex={bubbleSlashSelectedIndex}
          anchorRect={bubbleSlashAnchorRect}
          onSelect={(cmd: Command) => {
            onBubbleSlashSelect(cmd, (next) => {
              if (next.length <= 4000) {
                setBubbleNote(next);
                setOutsideWarned(false);
                const input = bubbleNoteInputRef.current;
                if (input) {
                  window.requestAnimationFrame(() => {
                    input.setSelectionRange(next.length, next.length);
                  });
                }
              }
            });
          }}
          onDismiss={dismissBubbleSlash}
          onRetry={retryBubbleSlash}
          tone="dark"
        />
        <FileTagPopup
          items={bubbleFileSuggestions}
          isOpen={bubbleFileOpen}
          onSelect={handleBubbleMentionSelect}
          listRef={bubbleFilePopup.listRef}
          selectedIndex={bubbleFilePopup.selectedIndex}
          anchorRect={filePopupAnchorRect}
          tone="dark"
        />
    </>
  );
}
