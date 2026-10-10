import { Popover, PopoverContent, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { OVERVIEW_CARD_INSET, OVERVIEW_CARD_TOP } from "@/lib/composer-layout";
import { useOverviewStore, type OverviewSubjectKey } from "@/stores/overviewStore";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverviewCard } from "./overview-card";
import { OverviewEntryStateProviders } from "./overview-entry-state";
import { useOverviewLayer } from "./overview-layer";
import type { OverviewPresentationState } from "./overview-presentation";
import { getOverviewEntries, getOverviewHeaderActions } from "./overview-registry";
import type { OverviewSubject } from "./overview-subject";
import type { ThreadOverviewCiDot } from "./overview-state";
import { OverviewToggleButton } from "./overview-toggle-button";

/** Keeps the overlay pinned to the docked card's corner instead of flipping or sliding into chat. */
const PINNED_COLLISION_AVOIDANCE = { side: "none", align: "none", fallbackAxisSide: "none" } as const;

/** Props for {@link OverviewMount}. */
export interface OverviewMountProps {
  subject: OverviewSubject;
  subjectKey: OverviewSubjectKey;
  presentation: OverviewPresentationState;
  ciDot?: ThreadOverviewCiDot;
  /** Surfaces that outlive the card, such as dialogs opened from its rows. */
  children?: ReactNode;
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

/** Clears this subject's overlay and open request as the canvas changes. */
function useOverviewLifecycle(key: OverviewSubjectKey, dockable: boolean) {
  const requested = useOverviewStore((s) => s.requestedSubject === key);
  useEffect(() => {
    if (requested) useOverviewStore.getState().consumeOpenRequest(key, dockable);
  }, [dockable, key, requested]);
  useEffect(() => {
    if (dockable) useOverviewStore.getState().dismissOverlay(key);
  }, [dockable, key]);
  // An overlay left open on a canvas the user navigated away from would reappear on return.
  useEffect(() => () => useOverviewStore.getState().dismissOverlay(key), [key]);
}

/**
 * An Overview subject's header button plus the card it controls. The card docks in the chat
 * canvas corner when the canvas has room, and otherwise floats there as an overlay the button opens.
 */
export function OverviewMount({ subject, subjectKey, presentation: { dockable, presentation }, ciDot = null, children }: OverviewMountProps) {
  const layer = useOverviewLayer();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useOverviewLifecycle(subjectKey, dockable);
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
    useOverviewStore.getState().dismissOverlay(subjectKey);
  }, [subjectKey]);
  const anchor = useMemo(() => (layer ? dockedCornerAnchor(layer) : toggleRef), [layer]);

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
  return (
    <OverviewEntryStateProviders entries={[...entries, ...headerActions]} subject={subject}>
      <OverviewToggleButton
        ref={toggleRef}
        ciDot={ciDot}
        on={presentation !== "hidden"}
        onToggle={() => useOverviewStore.getState().toggle(subjectKey, dockable)}
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
      {children}
    </OverviewEntryStateProviders>
  );
}
