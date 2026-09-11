import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { VirtualRows } from "@/components/ui/VirtualRows";
import { cn } from "@/lib/utils";
import { recordThreadPositioned } from "@/lib/thread-switch-telemetry";
import { rememberScrollTop, recallScrollPosition } from "@/components/chat/scrollPositionMemory";
import { STICKY_USER_MESSAGE_ESTIMATED_HEIGHT } from "@/components/chat/StickyUserMessage";
import { registerCommand } from "@/lib/command-registry";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import type { SelectedTextComment } from "@mcode/contracts";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import type { HistoryPageLoadResult } from "@/stores/threadStore";
import type { SubagentRosterTarget } from "../narrative";
import { TranscriptNarrativeRow } from "./TranscriptNarrativeRow";
import { narrativeRowMargin } from "../narrative/NarrativeRows";
import { findSelectedTextCommentContent, reconstructCanonicalMessageRange } from "./selected-text-projection";
import { isMessageListPerformanceBuild, measureMessageListPerformance } from "@/performance/message-list-performance";
import { TranscriptItemRenderer } from "./timeline/TranscriptItemRenderer";
import { MessageListOverlays } from "./MessageListOverlays";
import type { SelectedTextCommentEditorScope } from "./selection/SelectedTextCommentControls";
import { findViewportMessageAnchor } from "./message-list-scroll";
import { useMessageListData, type MessageListData } from "./useMessageListData";
import { useMessageListItems } from "./useMessageListItems";
import { useTranscriptGroupExpansion } from "./useTranscriptGroupExpansion";
import { resolveUserMessagePreview } from "@/components/chat/user-message-preview";
import { estimateMessageListItemHeight, type MessageListItem } from "./message-list-virtualization";
import { TranscriptViewport, type TranscriptHost, type TranscriptPosition } from "./transcript-viewport";

const SOURCE_NAVIGATION_MAX_FRAMES = 20;

/** A card source request that MessageList resolves through its resident transcript. */
export interface SelectedTextCommentSourceNavigationRequest {
  readonly id: number;
  readonly comment: SelectedTextComment;
  readonly intent?: "edit";
}

interface SourceNavigationTarget {
  readonly key: string;
  readonly source: SelectedTextComment["source"];
  readonly request?: SelectedTextCommentSourceNavigationRequest;
  readonly restoredEditor?: SelectedTextCommentEditorDraft;
}

interface SourceNavigationCallbacks {
  readonly onOpened?: (target: SourceNavigationTarget) => void;
  readonly onUnavailable?: (target: SourceNavigationTarget) => void;
}

function sourceNavigationTarget(
  explicitRequest: SelectedTextCommentSourceNavigationRequest | undefined,
  selectedTextCommentEditor: SelectedTextCommentEditorDraft | undefined,
  renderedThreadId: string | null | undefined,
): SourceNavigationTarget | null {
  if (explicitRequest) {
    const source = explicitRequest.comment.source;
    return source.threadId === renderedThreadId
      ? { key: `request:${explicitRequest.id}`, source, request: explicitRequest }
      : null;
  }
  return restoredSourceNavigationTarget(selectedTextCommentEditor, renderedThreadId);
}

function restoredSourceNavigationTarget(
  editor: SelectedTextCommentEditorDraft | undefined,
  renderedThreadId: string | null | undefined,
): SourceNavigationTarget | null {
  if (!editor || editor.anchor !== "source" || editor.source.threadId !== renderedThreadId) return null;
  const source = editor.source;
  return {
    key: `editor:${source.threadId}:${source.messageId}:${source.start}:${source.end}:${editor.commentId ?? "new"}`,
    source,
    restoredEditor: editor,
  };
}

function markSourceUnavailable(
  target: SourceNavigationTarget,
  callbacks: SourceNavigationCallbacks,
): void {
  callbacks.onUnavailable?.(target);
}

function sourceNavigationCallbacks(
  onOpened: ((request: SelectedTextCommentSourceNavigationRequest) => void) | undefined,
  onUnavailable: ((request: SelectedTextCommentSourceNavigationRequest) => void) | undefined,
  onRestoredEditorUnavailable: ((editor: SelectedTextCommentEditorDraft) => void) | undefined,
): SourceNavigationCallbacks {
  return {
    onOpened: (target) => {
      if (target.request) onOpened?.(target.request);
    },
    onUnavailable: (target) => {
      if (target.request) onUnavailable?.(target.request);
      else if (target.restoredEditor) onRestoredEditorUnavailable?.(target.restoredEditor);
    },
  };
}

function useSourceNavigationCallbacks(
  target: SourceNavigationTarget | null,
  renderedThreadId: string | null | undefined,
  completedNavigationKeyRef: MutableRefObject<string | null>,
  onOpened: ((request: SelectedTextCommentSourceNavigationRequest) => void) | undefined,
  onUnavailable: ((request: SelectedTextCommentSourceNavigationRequest) => void) | undefined,
  onRestoredEditorUnavailable: ((editor: SelectedTextCommentEditorDraft) => void) | undefined,
): SourceNavigationCallbacks {
  const activeNavigationRef = useRef<{
    key: string | null;
    threadId: string | null | undefined;
  }>({ key: null, threadId: null });
  activeNavigationRef.current = { key: target?.key ?? null, threadId: renderedThreadId };
  const callbacks = useMemo(() => sourceNavigationCallbacks(
    onOpened,
    onUnavailable,
    onRestoredEditorUnavailable,
  ), [onOpened, onRestoredEditorUnavailable, onUnavailable]);
  const complete = useCallback((
    completedTarget: SourceNavigationTarget,
    callback: ((navigationTarget: SourceNavigationTarget) => void) | undefined,
  ) => {
    const active = activeNavigationRef.current;
    if (active.key !== completedTarget.key || active.threadId !== completedTarget.source.threadId) return;
    completedNavigationKeyRef.current = completedTarget.key;
    callback?.(completedTarget);
  }, [completedNavigationKeyRef]);
  return useMemo<SourceNavigationCallbacks>(() => ({
    onOpened: (completedTarget) => complete(completedTarget, callbacks.onOpened),
    onUnavailable: (completedTarget) => complete(completedTarget, callbacks.onUnavailable),
  }), [callbacks, complete]);
}

function requestMissingSourceHistory({
  itemIndex,
  target,
  hasMore,
  hasNewer,
  isLoadingMore,
  isLoadingNewer,
  loadOlderMessages,
  loadNewerMessages,
  callbacks,
}: {
  readonly itemIndex: number;
  readonly target: SourceNavigationTarget;
  readonly hasMore: boolean;
  readonly hasNewer: boolean;
  readonly isLoadingMore: boolean;
  readonly isLoadingNewer: boolean;
  readonly loadOlderMessages: (threadId: string) => Promise<HistoryPageLoadResult>;
  readonly loadNewerMessages: (threadId: string) => Promise<HistoryPageLoadResult>;
  readonly callbacks: SourceNavigationCallbacks;
}): boolean {
  if (itemIndex !== -1) return false;
  if (isLoadingMore || isLoadingNewer) return true;
  if (hasMore) {
    void loadOlderMessages(target.source.threadId)
      .then((result) => {
        if (result === "failed") markSourceUnavailable(target, callbacks);
      })
      .catch(() => markSourceUnavailable(target, callbacks));
    return true;
  }
  if (hasNewer) {
    void loadNewerMessages(target.source.threadId)
      .then((result) => {
        if (result === "failed") markSourceUnavailable(target, callbacks);
      })
      .catch(() => markSourceUnavailable(target, callbacks));
    return true;
  }
  markSourceUnavailable(target, callbacks);
  return true;
}

function inspectScrolledSource({
  containerRef,
  target,
  renderedThreadId,
  callbacks,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly target: SourceNavigationTarget;
  readonly renderedThreadId: string | null | undefined;
  readonly callbacks: SourceNavigationCallbacks;
}): () => void {
  let frame = 0;
  let animationFrame = 0;
  const inspectSource = () => {
    const viewport = containerRef.current;
    const content = viewport
      ? findSelectedTextCommentContent(target.source, viewport, renderedThreadId)
      : null;
    if (!content) {
      if (frame++ < SOURCE_NAVIGATION_MAX_FRAMES) {
        animationFrame = requestAnimationFrame(inspectSource);
        return;
      }
      markSourceUnavailable(target, callbacks);
      return;
    }
    if (reconstructCanonicalMessageRange(content, target.source.start, target.source.end, target.source.quote)) {
      callbacks.onOpened?.(target);
      return;
    }
    markSourceUnavailable(target, callbacks);
  };
  animationFrame = requestAnimationFrame(inspectSource);
  return () => cancelAnimationFrame(animationFrame);
}

/** Props for the virtualized conversation transcript. */
export interface MessageListProps {
  /** Thread whose resident transcript is rendered while the selected thread hydrates. */
  displayThreadId?: string;
  /** Content that must appear before all persisted transcript messages. */
  leadingContent?: ReactNode;
  /** Content inserted immediately after the first persisted user message. */
  afterFirstUserContent?: ReactNode;
  /** Called when the user clicks the branch icon on a message. */
  onBranch?: (messageId: string) => void;
  /** Adds one selected-text comment to the active Composer draft. */
  onSelectedTextComment?: (comment: SelectedTextComment) => void;
  /** Removes one saved selected-text comment from the active Composer draft. */
  onDeleteSelectedTextComment?: (comment: SelectedTextComment) => void;
  /** Persists open selected-text editor changes in the active ComposerDraft. */
  onSelectedTextCommentEditorChange?: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  /** Restored selected-text editor state for the rendered thread. */
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  /** Card source navigation awaiting transcript loading and virtualized mounting. */
  selectedTextCommentSourceNavigation?: SelectedTextCommentSourceNavigationRequest;
  /** Opens the source editor after its active request reconstructs canonically. */
  onSelectedTextCommentSourceOpened?: (request: SelectedTextCommentSourceNavigationRequest) => void;
  /** Navigates a saved source marker before opening its editor. */
  onOpenSelectedTextCommentEditor?: (comment: SelectedTextComment) => void;
  /** Opens the affected card editor after its active request cannot load or reconstruct. */
  onSelectedTextCommentSourceUnavailable?: (request: SelectedTextCommentSourceNavigationRequest) => void;
  /** Moves a restored source editor to its card after source loading fails. */
  onSelectedTextCommentEditorSourceUnavailable?: (editor: SelectedTextCommentEditorDraft) => void;
  /** Scopes selected-text comment mention and slash-skill suggestions. */
  selectedTextCommentEditorScope?: SelectedTextCommentEditorScope;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Whether child prompts display their parent-agent provenance label. */
  showParentAgentProvenance?: boolean;
  /** Reserved space that keeps transcript content clear of the open Overview. */
  contentPaddingRight?: string;
}

/** Keeps the viewport and its pending work scoped to the rendered thread. */
export function MessageList(props: MessageListProps) {
  const data = useMessageListData(props.displayThreadId);
  return <ThreadTranscript key={data.renderedThreadId ?? "empty"} data={data} {...props} />;
}

function restoreTranscriptPosition(view: TranscriptViewport, threadId: string | null | undefined, items: readonly MessageListItem[]): void {
  const saved = threadId ? recallScrollPosition(threadId) : undefined;
  if (!saved || saved.atTail) {
    view.moveTo({ kind: "end" });
    return;
  }
  if (saved.rowAnchor && items.some((item) => item.key === saved.rowAnchor?.key)) {
    view.moveTo({ kind: "reading", ...saved.rowAnchor });
    return;
  }
  const anchor = items.find((item) => item.type === "message" && item.message.id === saved.anchorMessageId);
  if (anchor) view.moveTo({ kind: "reading", key: anchor.key, offset: -(saved.anchorTop ?? 0) });
  else view.restoreOffset(saved.scrollTop);
}

function loadHistoryAtBoundary(viewport: HTMLElement, data: MessageListData, direction: "older" | "newer"): boolean {
  if (!data.renderedThreadId) return false;
  const isOlder = direction === "older";
  const remaining = isOlder ? viewport.scrollTop : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  const available = isOlder ? data.hasMore && !data.isLoadingMore : data.hasNewer && !data.isLoadingNewer;
  if (remaining > 200 || !available) return false;
  const load = isOlder ? data.loadOlderMessages : data.loadNewerMessages;
  void load(data.renderedThreadId);
  return true;
}

function findReadingUserRow(view: TranscriptViewport, rows: readonly MessageListItem[], boundary: number) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if ((view.rowTop(rows[index].key) ?? Infinity) <= boundary) return rows[index];
  }
  return undefined;
}

function transcriptGroupKey(item: MessageListItem): string {
  return item.type === "tool-row" ? item.groupKey : item.key;
}

function ThreadTranscript({ data, ...props }: MessageListProps & { readonly data: MessageListData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef<TranscriptViewport | null>(null);
  const turnExpandRef = useRef(new Map<string, boolean>());
  const [hosts, setHosts] = useState<readonly TranscriptHost[]>([]);
  const [atTail, setAtTail] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [stickyVisible, setStickyVisible] = useState(false);
  const [stickyKey, setStickyKey] = useState<string>();
  const [stickyHeight, setStickyHeight] = useState(0);
  const [highlightedKey, setHighlightedKey] = useState<string>();
  const { expanded: expandedGroups, present: presentGroups, entering: enteringGroups, toggle: toggleExpandedGroup } = useTranscriptGroupExpansion(() =>
    data.renderedThreadId ? recallScrollPosition(data.renderedThreadId)?.expandedGroups ?? new Set() : new Set());
  const toggleGroup = useCallback((key: string) => {
    const view = controllerRef.current;
    const top = view?.rowTop(key);
    if (top !== undefined) view?.moveTo({ kind: "reading", key, offset: -top });
    toggleExpandedGroup(key);
  }, [toggleExpandedGroup]);
  const { items } =
    useMessageListItems({ ...data, expandedGroups: presentGroups, leadingContent: props.leadingContent, afterFirstUserContent: props.afterFirstUserContent });
  const itemsByKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const userRows = useMemo(() => items.filter((item) =>
    item.type === "message" && item.message.role === "user" && !item.message.is_internal,
  ), [items]);
  const stickyItem = stickyKey ? itemsByKey.get(stickyKey) : undefined;
  const stickyMessage = stickyItem?.type === "message" ? stickyItem.message : undefined;
  const stickyPreview = useMemo(() => stickyMessage ? resolveUserMessagePreview(stickyMessage) : null, [stickyMessage]);
  const latest = useRef({ data, items, userRows, expandedGroups });
  latest.current = { data, items, userRows, expandedGroups };
  const positionRef = useRef<TranscriptPosition>({ kind: "end" });
  const paginationDirection = useRef<"older" | "newer" | null>(null);
  const restored = useRef(false);
  const previousInset = useRef(data.renderedThreadId ? recallScrollPosition(data.renderedThreadId)?.topInset ?? 16 : 16);

  const syncPosition = useCallback((position: TranscriptPosition) => {
    positionRef.current = position;
    setAtTail(position.kind === "end");
    if (position.kind === "end") setHasNewContent(false);
    const view = controllerRef.current;
    if (!view) return;
    const current = latest.current;
    // The inset must not move the selection boundary when the chip appears.
    const boundary = STICKY_USER_MESSAGE_ESTIMATED_HEIGHT - previousInset.current;
    const userRow = findReadingUserRow(view, current.userRows, boundary);
    setStickyKey(userRow?.key);
    const bottom = userRow ? view.rowBottom(userRow.key) : undefined;
    setStickyVisible((visible) => bottom !== undefined && bottom <= boundary + (visible ? 4 : -8));
    if (!current.data.renderedThreadId || !restored.current) return;
    rememberScrollTop(
      current.data.renderedThreadId,
      view.viewport.scrollTop,
      position.kind === "end",
      findViewportMessageAnchor(view.viewport),
      position.kind === "reading" ? { key: position.key, offset: position.offset } : view.getReadingAnchor(),
      previousInset.current,
      current.expandedGroups,
    );
  }, []);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    restored.current = false;
    const view = new TranscriptViewport(containerRef.current, setHosts, syncPosition);
    controllerRef.current = view;
    viewportRef.current = view.viewport;
    return () => {
      view.destroy();
      controllerRef.current = null;
      viewportRef.current = null;
    };
  }, [syncPosition]);

  useLayoutEffect(() => {
    const view = controllerRef.current;
    if (!view) return;
    measureMessageListPerformance("vlistRows", () => {
      view.setRows(items.map((item) => ({ id: item.key, height: estimateMessageListItemHeight(item) })));
    });
    if (restored.current || data.loading && items.length === 0) return;
    restored.current = true;
    restoreTranscriptPosition(view, data.renderedThreadId, items);
    if (data.renderedThreadId === data.activeThreadId && data.activeThreadId) {
      recordThreadPositioned(data.activeThreadId);
    }
  }, [items, data.loading, data.renderedThreadId, data.activeThreadId]);

  const lastItemKey = items.at(-1)?.key;
  useEffect(() => {
    if (positionRef.current.kind !== "end") setHasNewContent(true);
  }, [data.streamingText, lastItemKey]);

  const { messages, persistedNarrativeByMessage, renderedThreadId, isNarrativeLoaded, loadNarrativeForMessage } = data;
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (isMessageListPerformanceBuild() && persistedNarrativeByMessage[message.id]) continue;
      if (renderedThreadId && isNarrativeLoaded(renderedThreadId, message.id)) continue;
      void loadNarrativeForMessage(message.id, renderedThreadId ?? undefined);
    }
  }, [messages, persistedNarrativeByMessage, renderedThreadId, isNarrativeLoaded, loadNarrativeForMessage]);

  const loadRequestedHistory = useCallback(() => {
    const view = controllerRef.current;
    const current = latest.current.data;
    const direction = paginationDirection.current;
    if (!view || !current.isRenderedVisible || !direction) return;
    if (loadHistoryAtBoundary(view.viewport, current, direction)) {
      paginationDirection.current = null;
    }
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const requestHistory = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      paginationDirection.current = event.deltaY < 0 ? "older" : "newer";
      loadRequestedHistory();
    };
    viewport.addEventListener("wheel", requestHistory, { passive: true });
    viewport.addEventListener("scroll", loadRequestedHistory, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", requestHistory);
      viewport.removeEventListener("scroll", loadRequestedHistory);
    };
  }, [loadRequestedHistory]);

  const scrollToMessage = useCallback((messageId: string) => {
    const row = latest.current.items.find((item) => item.type === "message" && item.message.id === messageId);
    if (row) {
      controllerRef.current?.moveTo({ kind: "target", key: row.key, align: "center" }, true);
      setHighlightedKey(row.key);
    }
  }, []);
  const jumpToUser = useCallback(() => {
    if (stickyMessage) scrollToMessage(stickyMessage.id);
  }, [stickyMessage, scrollToMessage]);
  useEffect(() => {
    if (!stickyVisible || !stickyPreview) return;
    return registerCommand({
      id: "stickyUserMessage.jump",
      title: "Jump to Current User Message",
      category: "Navigation",
      handler: jumpToUser,
    });
  }, [stickyVisible, stickyPreview, jumpToUser]);

  const sourceTarget = useMemo(() => sourceNavigationTarget(
    props.selectedTextCommentSourceNavigation, props.selectedTextCommentEditor, data.renderedThreadId,
  ), [props.selectedTextCommentSourceNavigation, props.selectedTextCommentEditor, data.renderedThreadId]);
  const completedSource = useRef<string | null>(null);
  const sourceCallbacks = useSourceNavigationCallbacks(
    sourceTarget, data.renderedThreadId, completedSource,
    props.onSelectedTextCommentSourceOpened, props.onSelectedTextCommentSourceUnavailable,
    props.onSelectedTextCommentEditorSourceUnavailable,
  );
  useEffect(() => {
    if (!sourceTarget || completedSource.current === sourceTarget.key) return;
    const index = items.findIndex((item) => item.type === "message" && item.message.id === sourceTarget.source.messageId);
    if (requestMissingSourceHistory({
      itemIndex: index, target: sourceTarget, hasMore: data.hasMore, hasNewer: data.hasNewer,
      isLoadingMore: data.isLoadingMore, isLoadingNewer: data.isLoadingNewer,
      loadOlderMessages: data.loadOlderMessages, loadNewerMessages: data.loadNewerMessages,
      callbacks: sourceCallbacks,
    })) return;
    controllerRef.current?.moveTo({ kind: "target", key: items[index].key, align: "center" });
    return inspectScrolledSource({ containerRef: viewportRef, target: sourceTarget, renderedThreadId: data.renderedThreadId, callbacks: sourceCallbacks });
  }, [sourceTarget, sourceCallbacks, items, data.hasMore, data.hasNewer, data.isLoadingMore, data.isLoadingNewer, data.loadOlderMessages, data.loadNewerMessages, data.renderedThreadId]);

  const topInset = stickyVisible ? stickyHeight || STICKY_USER_MESSAGE_ESTIMATED_HEIGHT : 16;
  useLayoutEffect(() => {
    const delta = topInset - previousInset.current;
    previousInset.current = topInset;
    controllerRef.current?.shiftReadingPosition(delta);
  }, [topInset]);

  return (
    <div className="relative h-full" data-testid="message-list">
      <div className="h-full" style={{ paddingTop: topInset }}>
        <div
          ref={containerRef}
          className="h-full data-[sticky=true]:[mask-image:linear-gradient(to_bottom,transparent,black_16px)]"
          data-sticky={stickyVisible}
        />
      </div>
      <VirtualRows viewport={controllerRef.current} hosts={hosts} items={itemsByKey} renderItem={(item, id) => (
          <div className={cn("w-full px-4 sm:px-8", item.type === "narrative-row" ? narrativeRowMargin(item.item, item.index) : item.type === "tool-row" ? undefined : "py-2")} data-performance-virtual-item-key={isMessageListPerformanceBuild() ? item.key : undefined}>
            <div className="w-full overflow-x-clip" style={{ paddingRight: props.contentPaddingRight }}>
            <div
              className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0 overflow-x-clip", highlightedKey === id && "animate-flash-highlight")}
              onAnimationEnd={(event) => { if (event.target === event.currentTarget) setHighlightedKey(undefined); }}
            >
              {item.type === "leading-content" || item.type === "after-first-user-content" ? (
                <div data-testid="message-list-leading-content">{item.content}</div>
              ) : item.type === "narrative-row" || item.type === "tool-row" ? (
                <TranscriptNarrativeRow row={item} expanded={expandedGroups.has(transcriptGroupKey(item))} entering={enteringGroups.has(transcriptGroupKey(item))} onToggle={toggleGroup} onSubagentSelect={props.onSubagentSelect} onOpenSubagents={props.onOpenSubagents} />
              ) : (
                <TranscriptItemRenderer item={item} turnExpandRef={turnExpandRef} onBranch={props.onBranch} onSubagentSelect={props.onSubagentSelect} onOpenSubagents={props.onOpenSubagents} onScrollToMessage={scrollToMessage} currentTurnMessageIdByThread={data.currentTurnMessageIdByThread} threadId={data.renderedThreadId} showParentAgentProvenance={props.showParentAgentProvenance ?? true} />
              )}
            </div>
            </div>
          </div>
      )} />
      <MessageListOverlays
        contentPaddingRight={props.contentPaddingRight}
        handoffStatus={data.handoffStatus} messages={data.messages} isLoadingMore={data.isLoadingMore} isLoadingNewer={data.isLoadingNewer}
        onSelectedTextComment={props.onSelectedTextComment} onDeleteSelectedTextComment={props.onDeleteSelectedTextComment}
        onSelectedTextCommentEditorChange={props.onSelectedTextCommentEditorChange} onOpenSelectedTextCommentEditor={props.onOpenSelectedTextCommentEditor}
        selectedTextCommentEditor={props.selectedTextCommentEditor} selectedTextCommentEditorScope={props.selectedTextCommentEditorScope}
        viewportRef={viewportRef} renderedThreadId={data.renderedThreadId} stickyPreview={stickyPreview}
        isStickyVisible={stickyVisible} onJumpToUserMessage={jumpToUser} onStickyHeightChange={setStickyHeight}
        showScrollToBottom={!atTail} hasNewContent={hasNewContent}
        onScrollToBottom={() => controllerRef.current?.moveTo({ kind: "end" }, true)}
      />
    </div>
  );
}
