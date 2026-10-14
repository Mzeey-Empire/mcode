/**
 * Owns annotation markers, the note bubble, visual inspector and autocomplete rendering. Picker state and effects are supplied explicitly from the parent hooks.
 */
import { Fragment, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, GripVertical, SlidersHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
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
import type { useDesignPicker } from "./useDesignPicker";
import {
  cleanVisualProposal,
  visualOverlayStyle,
  visualProposalGeometryStyle,
  VISUAL_CONTROL_FIELDS,
  COLOR_CONTROL_DEFAULTS,
  type ColorVisualProposalKey,
  BOX_CONTROL_GROUPS,
  RADIUS_CONTROL_GROUP,
  radiusGroupEntries,
  boxGroupEntries,
  groupLinkPairs,
} from "./visualProposalModel";
import {
  annotationSnapshotRequest,
  boundsAtScroll,
  visibleAnnotationState,
  BUBBLE_SURFACE_INSET,
  annotationBubbleClassName,
  annotationBubbleStyle,
  BUBBLE_SURFACE,
  annotationBubbleTargetLabel,
} from "./annotationBubble";
import { RenderValue } from "../surfaces/previewRender";
import {
  ColorInspectorControl,
  InspectorRow,
  InspectorValueInput,
  LinkedSizeControls,
  ExpandableQuadGroup,
} from "./visualProposalInspector";
import { detectColorFormat } from "./visualProposalColor";

interface DesignLayerProps {
  readonly openBubbleBase: ReturnType<typeof useDesignAnnotationEditor>["openBubbleBase"];
  readonly bubbleVisuals: ReturnType<typeof useDesignAnnotationEditor>["bubbleVisuals"];
  readonly bubbleNote: ReturnType<typeof useDesignAnnotationEditor>["bubbleNote"];
  readonly setOutsideWarned: ReturnType<typeof useDesignAnnotationEditor>["setOutsideWarned"];
  readonly capture: ReturnType<typeof usePreviewPage>["capture"];
  readonly pageAnnotations: ReturnType<typeof useDesignAnnotationEditor>["pageAnnotations"];
  readonly savedAnnotations: ReturnType<typeof useDesignAnnotationEditor>["savedAnnotations"];
  readonly editingSavedAnnotation: ReturnType<typeof useDesignAnnotationEditor>["editingSavedAnnotation"];
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
  readonly setBubbleAdvancedOpen: ReturnType<typeof useDesignAnnotationEditor>["setBubbleAdvancedOpen"];
  readonly designModeActive: ReturnType<typeof useDesignAnnotationState>["designModeActive"];
  readonly bubbleRef: ReturnType<typeof useDesignAnnotationState>["bubbleRef"];
  readonly outsideWarned: ReturnType<typeof useDesignAnnotationEditor>["outsideWarned"];
  readonly bubbleInputFocused: ReturnType<typeof useDesignAnnotationState>["bubbleInputFocused"];
  readonly bubbleAdvancedOpen: ReturnType<typeof useDesignAnnotationEditor>["bubbleAdvancedOpen"];
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  readonly pageScroll: PreviewPageScroll;
  readonly onBubbleSlashInputChange: ReturnType<typeof useDesignAnnotationState>["onBubbleSlashInputChange"];
  readonly onBubbleFileInputChange: ReturnType<typeof useDesignAnnotationState>["onBubbleFileInputChange"];
  readonly setBubbleInputFocused: ReturnType<typeof useDesignAnnotationState>["setBubbleInputFocused"];
  readonly canSaveOpenBubble: ReturnType<typeof useDesignAnnotationEditor>["canSaveOpenBubble"];
  readonly colorFormats: ReturnType<typeof useDesignAnnotationState>["colorFormats"];
  readonly updateBubbleVisualControl: ReturnType<typeof useDesignPicker>["updateBubbleVisualControl"];
  readonly updateColorFormat: ReturnType<typeof useDesignPicker>["updateColorFormat"];
  readonly linkedVisualPairs: ReturnType<typeof useDesignAnnotationState>["linkedVisualPairs"];
  readonly toggleVisualLinkPair: ReturnType<typeof useDesignPicker>["toggleVisualLinkPair"];
  readonly expandedVisualGroups: ReturnType<typeof useDesignAnnotationState>["expandedVisualGroups"];
  readonly setExpandedVisualGroups: ReturnType<typeof useDesignAnnotationState>["setExpandedVisualGroups"];
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
  bubbleVisuals,
  bubbleNote,
  setOutsideWarned,
  capture,
  pageAnnotations,
  savedAnnotations,
  editingSavedAnnotation,
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
  setBubbleAdvancedOpen,
  designModeActive,
  bubbleRef,
  outsideWarned,
  bubbleInputFocused,
  bubbleAdvancedOpen,
  surfaceWidth,
  surfaceHeight,
  pageScroll,
  onBubbleSlashInputChange,
  onBubbleFileInputChange,
  setBubbleInputFocused,
  canSaveOpenBubble,
  colorFormats,
  updateBubbleVisualControl,
  updateColorFormat,
  linkedVisualPairs,
  toggleVisualLinkPair,
  expandedVisualGroups,
  setExpandedVisualGroups,
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
    const proposedChanges = cleanVisualProposal(
      bubbleVisuals,
      openBubbleBase.elementStyle,
    );
    if (bubbleNote.trim().length === 0 && !proposedChanges) {
      setOutsideWarned(true);
      return;
    }
    const snapshot = await capture.captureAnnotationSnapshot(
      annotationSnapshotRequest(
        pageAnnotations,
        savedAnnotations.length,
        editingSavedAnnotation,
        openBubbleBase,
        proposedChanges,
      ),
    );
    if (!snapshot) return;
    usePreviewAnnotationStore.getState().saveAnnotation(
      threadId,
      {
        ...openBubbleBase,
        note: bubbleNote,
        proposedChanges,
        snapshot,
      },
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
      usePreviewAnnotationStore
        .getState()
        .deleteAnnotation(threadId, editingAnnotationId);
    } else {
      usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    }
    setEditingAnnotationId(null);
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  };

  const {
    openBubbleBase: visibleOpenBubbleBase,
    pageAnnotations: visiblePageAnnotations,
    visualProposal: openBubbleVisualProposal,
  } = visibleAnnotationState(
    designModeActive,
    openBubbleBase,
    pageAnnotations,
    bubbleVisuals,
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
        {visiblePageAnnotations.map((annotation, index) => {
          const bounds = boundsAtScroll(
            annotation.targetContext.bounds,
            annotation.pageContext.viewportScroll,
            pageScroll,
          );
          const targetLabel =
            annotation.targetContext.label?.trim() ||
            annotation.targetContext.selectorHint?.trim() ||
            "Element";
          const note = annotation.note?.trim() || "Visual annotation";
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
                      aria-label={`Edit annotation ${index + 1}`}
                    >
                      {index + 1}
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
          {(annotation) => (
            <RenderValue value={openBubbleVisualProposal}>
              {(proposal) => (
                <div
                  data-testid="preview-annotation-visual-proposal"
                  className="pointer-events-none absolute z-(--layer-sticky) rounded-sm border border-dashed border-primary/80"
                  style={{
                    ...visualOverlayStyle(proposal),
                    ...visualProposalGeometryStyle(
                      annotation.bounds,
                      proposal,
                      annotation.elementStyle,
                    ),
                  }}
                />
              )}
            </RenderValue>
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
              bubbleAdvancedOpen,
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-compact"
                  className={cn(
                    "shrink-0 rounded-full text-muted hover:bg-hover hover:text-ink",
                    bubbleAdvancedOpen && "bg-hover text-ink",
                  )}
                  data-testid="preview-annotation-advanced-toggle"
                  aria-label="Open annotation visual controls"
                  aria-expanded={bubbleAdvancedOpen}
                  onClick={() => setBubbleAdvancedOpen((value) => !value)}
                >
                  <SlidersHorizontal size={15} aria-hidden />
                </Button>
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
            {bubbleAdvancedOpen ? (
              <div
                data-testid="preview-annotation-advanced"
                className="border-t border-border"
                style={{ backgroundColor: BUBBLE_SURFACE_INSET }}
              >
                <div
                  className="flex items-center justify-between border-b border-border bg-hover px-4 py-1.5 text-xs text-ink"
                >
                  <span className="max-w-[15rem] text-fade font-semibold leading-5">
                    {annotationBubbleTargetLabel(openBubble)}
                  </span>
                  <GripVertical
                    size={14}
                    className="text-muted"
                    aria-hidden
                  />
                </div>
                <div className="max-h-52 overflow-y-auto px-4 py-2 [scrollbar-color:var(--muted)_transparent] [scrollbar-width:thin]">
                  <div className="space-y-2">
                    {VISUAL_CONTROL_FIELDS.map(([key, label]) => {
                      if (key in COLOR_CONTROL_DEFAULTS) {
                        const colorKey = key as ColorVisualProposalKey;
                        return (
                          <ColorInspectorControl
                            key={key}
                            controlKey={colorKey}
                            colorFormat={
                              colorFormats[colorKey] ??
                              detectColorFormat(bubbleVisuals[colorKey])
                            }
                            label={label}
                            value={bubbleVisuals[colorKey]}
                            onChange={updateBubbleVisualControl}
                            onFormatChange={updateColorFormat}
                          />
                        );
                      }
                      const value = bubbleVisuals[key];
                      return (
                        <InspectorRow
                          key={key}
                          label={label}
                        >
                          <InspectorValueInput
                            controlKey={key}
                            label={label}
                            value={value}
                            onChange={updateBubbleVisualControl}
                          />
                        </InspectorRow>
                      );
                    })}
                    <LinkedSizeControls
                      linked={Boolean(linkedVisualPairs.size)}
                      values={bubbleVisuals}
                      onChange={updateBubbleVisualControl}
                      onToggleLinked={() => toggleVisualLinkPair("size")}
                    />
                    {[...BOX_CONTROL_GROUPS, RADIUS_CONTROL_GROUP].map((group) => (
                      <ExpandableQuadGroup
                        key={group.id}
                        groupId={group.id}
                        label={group.label}
                        entries={
                          group.id === "radius"
                            ? radiusGroupEntries(group)
                            : boxGroupEntries(group)
                        }
                        expanded={Boolean(expandedVisualGroups[group.id])}
                        linkedPairs={groupLinkPairs(group.id)}
                        linkedPairState={linkedVisualPairs}
                        values={bubbleVisuals}
                        onChange={updateBubbleVisualControl}
                        onToggleExpanded={(groupId) => {
                          setExpandedVisualGroups((prev) => ({
                            ...prev,
                            [groupId]: !prev[groupId],
                          }));
                        }}
                        onToggleLinked={toggleVisualLinkPair}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {bubbleAdvancedOpen || editingAnnotationId ? (
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
                      setBubbleAdvancedOpen(false);
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
