import { Popover, PopoverContent, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { OverviewCard } from "@/features/thread-overview/overview-card";
import { OverviewEntryStateProviders } from "@/features/thread-overview/overview-entry-state";
import { useOverviewLayer } from "@/features/thread-overview/overview-layer";
import { useOverviewPresentation } from "@/features/thread-overview/overview-presentation";
import { getOverviewEntries, getOverviewHeaderActions } from "@/features/thread-overview/overview-registry";
import {
  OverviewContext,
  OverviewDialogs,
  useOverviewState,
} from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { OverviewToggleButton } from "@/features/thread-overview/overview-toggle-button";
import { OVERVIEW_CARD_INSET, OVERVIEW_CARD_TOP } from "@/lib/composer-layout";
import { threadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

/** Keeps the overlay pinned to the docked card's corner instead of flipping or sliding into chat. */
const PINNED_COLLISION_AVOIDANCE = { side: "none", align: "none", fallbackAxisSide: "none" } as const;

/** Props for {@link ThreadOverview}. */
interface ThreadOverviewProps {
  thread: Thread;
  /** Width of the chat canvas that contains this thread's timeline and composer. */
  threadPaneWidth: number;
}

/** A zero-size anchor at the docked card's top-right corner, so the overlay lands where the card docks. */
function dockedCornerAnchor(layer: HTMLElement) {
  return {
    contextElement: layer,
    getBoundingClientRect: () => {
      const rect = layer.getBoundingClientRect();
      return new DOMRect(rect.right - OVERVIEW_CARD_INSET, rect.top + OVERVIEW_CARD_TOP, 0, 0);
    },
  };
}

/** Clears this thread's overlay and open request as the canvas changes. */
function useOverviewLifecycle(threadId: string, dockable: boolean) {
  const key = threadOverviewKey(threadId);
  const requested = useOverviewStore((s) => s.requestedSubject === key);
  useEffect(() => {
    if (requested) useOverviewStore.getState().consumeOpenRequest(key, dockable);
  }, [dockable, key, requested]);
  useEffect(() => {
    if (dockable) useOverviewStore.getState().dismissOverlay(key);
  }, [dockable, key]);
  // An overlay left open on a thread the user navigated away from would reappear on return.
  useEffect(() => () => useOverviewStore.getState().dismissOverlay(key), [key]);
}

/**
 * The thread's Overview: the header button plus the card it controls. The card docks in the chat
 * canvas corner when the canvas has room, and otherwise floats there as an overlay the button opens.
 */
export function ThreadOverview({ thread, threadPaneWidth }: ThreadOverviewProps) {
  const key = threadOverviewKey(thread.id);
  const { dockable, presentation } = useOverviewPresentation(thread, threadPaneWidth);
  const layer = useOverviewLayer();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useOverviewLifecycle(thread.id, dockable);
  const closeOverlay = useCallback(() => useOverviewStore.getState().dismissOverlay(key), [key]);
  const handleOverlayOpenChange = useCallback((next: boolean, details: PopoverRootChangeEventDetails) => {
    const target = details.event?.target;
    // Side menus and dialogs opened from the card take focus without closing it, and the button's
    // own click toggles the overlay, so neither is a close. Cancelling rather than ignoring matters:
    // an uncancelled close resets Base UI's press tracking and a later outside click is dropped.
    const kept = next
      || details.reason === "focus-out"
      || (details.reason === "outside-press" && target instanceof Node && toggleRef.current?.contains(target));
    if (kept) {
      details.cancel();
      return;
    }
    closeOverlay();
  }, [closeOverlay]);
  const anchor = useMemo(() => (layer ? dockedCornerAnchor(layer) : toggleRef), [layer]);

  const state = useOverviewState(thread, presentation !== "hidden", closeOverlay);
  const subject: OverviewSubject = { kind: "thread", thread };
  const entries = getOverviewEntries(subject);
  const headerActions = getOverviewHeaderActions(subject);
  const dockedCard = presentation === "docked" ? (
    <OverviewCard
      subject={subject}
      entries={entries}
      headerActions={headerActions}
      presentation="docked"
      className="pointer-events-auto absolute top-14 right-4 max-h-[calc(100%_-_7.2rem)]"
    />
  ) : null;
  return (<OverviewContext.Provider value={state}>
    <OverviewEntryStateProviders entries={[...entries, ...headerActions]} subject={subject}>
      <OverviewToggleButton
        ref={toggleRef}
        ciDot={state.ciDot}
        on={presentation !== "hidden"}
        onToggle={() => useOverviewStore.getState().toggle(key, dockable)}
      />
      {dockedCard && layer ? createPortal(dockedCard, layer) : dockedCard}
      {presentation === "overlay" ? <Popover open onOpenChange={handleOverlayOpenChange}>
        <PopoverContent
          anchor={anchor}
          side="bottom"
          align="end"
          sideOffset={0}
          collisionPadding={OVERVIEW_CARD_INSET}
          collisionAvoidance={PINNED_COLLISION_AVOIDANCE}
          className="w-auto border-0 bg-transparent p-0"
        >
          <OverviewCard
            subject={subject}
            entries={entries}
            headerActions={headerActions}
            presentation="overlay"
            className="max-h-(--available-height)"
          />
        </PopoverContent>
      </Popover> : null}
      <OverviewDialogs thread={thread} />
    </OverviewEntryStateProviders>
  </OverviewContext.Provider>);
}
