/**
 * Owns annotation dismissal, visual-control callbacks and picker effects. The parent invokes it after live-chrome publication to preserve effect order.
 */
import { useCallback, useEffect, useEffectEvent } from "react";
import type { PreviewAnnotationVisualProposal } from "@mcode/contracts";
import { usePreviewDesignModeStore } from "../state/previewDesignModeStore";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import type { useDesignAnnotationEditor } from "./useDesignAnnotationEditor";
import type { useDesignAnnotationState } from "./useDesignAnnotationState";
import type { usePreviewPage } from "../surfaces/usePreviewPage";
import {
  type VisualProposalKey,
  VISUAL_LINK_PAIRS,
  encodeVisualControlValue,
  type VisualLinkPairId,
  type ColorVisualProposalKey,
} from "./visualProposalModel";
import { type ColorFormat, parseColorValue, formatColorValue } from "./visualProposalColor";
import { isAnnotationBubbleInteractionTarget } from "./annotationBubble";

interface DesignPickerOptions {
  readonly openBubbleFocusKey: ReturnType<typeof useDesignAnnotationEditor>["openBubbleFocusKey"];
  readonly bubbleNoteInputRef: ReturnType<typeof useDesignAnnotationState>["bubbleNoteInputRef"];
  readonly designModeActive: ReturnType<typeof useDesignAnnotationState>["designModeActive"];
  readonly hasOpenBubble: ReturnType<typeof useDesignAnnotationEditor>["hasOpenBubble"];
  readonly threadId: string;
  readonly setEditingAnnotationId: ReturnType<typeof useDesignAnnotationState>["setEditingAnnotationId"];
  readonly setBubbleAdvancedOpen: ReturnType<typeof useDesignAnnotationEditor>["setBubbleAdvancedOpen"];
  readonly setOutsideWarned: ReturnType<typeof useDesignAnnotationEditor>["setOutsideWarned"];
  readonly dismissBubbleSlash: ReturnType<typeof useDesignAnnotationState>["dismissBubbleSlash"];
  readonly dismissBubbleFile: ReturnType<typeof useDesignAnnotationState>["dismissBubbleFile"];
  readonly openBubbleBase: ReturnType<typeof useDesignAnnotationEditor>["openBubbleBase"];
  readonly canSaveOpenBubble: ReturnType<typeof useDesignAnnotationEditor>["canSaveOpenBubble"];
  readonly outsideWarned: ReturnType<typeof useDesignAnnotationEditor>["outsideWarned"];
  readonly linkedVisualPairs: ReturnType<typeof useDesignAnnotationState>["linkedVisualPairs"];
  readonly setBubbleVisuals: ReturnType<typeof useDesignAnnotationEditor>["setBubbleVisuals"];
  readonly setLinkedVisualPairs: ReturnType<typeof useDesignAnnotationState>["setLinkedVisualPairs"];
  readonly setColorFormats: ReturnType<typeof useDesignAnnotationState>["setColorFormats"];
  readonly bubbleVisuals: ReturnType<typeof useDesignAnnotationEditor>["bubbleVisuals"];
  readonly bubbleRef: ReturnType<typeof useDesignAnnotationState>["bubbleRef"];
  readonly bubbleSlashOpen: ReturnType<typeof useDesignAnnotationState>["bubbleSlashOpen"];
  readonly bubbleFileOpen: ReturnType<typeof useDesignAnnotationState>["bubbleFileOpen"];
  readonly designModeSetActive: ReturnType<typeof useDesignAnnotationState>["designModeSetActive"];
  readonly designModeToggle: ReturnType<typeof useDesignAnnotationState>["designModeToggle"];
  readonly capture: ReturnType<typeof usePreviewPage>["capture"];
}

/** Wires design controls and picker effects after the parent publishes live page chrome. */
export function useDesignPicker({
  openBubbleFocusKey,
  bubbleNoteInputRef,
  designModeActive,
  hasOpenBubble,
  threadId,
  setEditingAnnotationId,
  setBubbleAdvancedOpen,
  setOutsideWarned,
  dismissBubbleSlash,
  dismissBubbleFile,
  openBubbleBase,
  canSaveOpenBubble,
  outsideWarned,
  linkedVisualPairs,
  setBubbleVisuals,
  setLinkedVisualPairs,
  setColorFormats,
  bubbleVisuals,
  bubbleRef,
  bubbleSlashOpen,
  bubbleFileOpen,
  designModeSetActive,
  designModeToggle,
  capture,
}: DesignPickerOptions) {
  useEffect(() => {
    if (!openBubbleFocusKey) return;
    const focusAtOpen = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement !== focusAtOpen) return;
      bubbleNoteInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bubbleNoteInputRef, openBubbleFocusKey]);

  useEffect(() => {
    if (!designModeActive || !hasOpenBubble) return;
    let cancelled = false;
    void window.desktopBridge?.preview?.design
      ?.setAnnotationGuard(true)
      .catch(() => undefined);
    return () => {
      if (cancelled) return;
      cancelled = true;
      void window.desktopBridge?.preview?.design
        ?.setAnnotationGuard(false)
        .catch(() => undefined);
    };
  }, [designModeActive, hasOpenBubble]);

  const closeOpenAnnotationBubble = useCallback((): void => {
    usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    setEditingAnnotationId(null);
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
    // Dismiss any open autocomplete popups so they don't linger after the
    // bubble closes (the hooks' own Escape handling only fires while the input
    // has focus, which it loses when the bubble unmounts).
    dismissBubbleSlash();
    dismissBubbleFile();
  }, [
    dismissBubbleFile,
    dismissBubbleSlash,
    setEditingAnnotationId,
    setBubbleAdvancedOpen,
    setOutsideWarned,
    threadId,
  ]);

  const requestOutsideBubbleDiscard = useCallback((): void => {
    if (!openBubbleBase) return;
    if (!canSaveOpenBubble) {
      closeOpenAnnotationBubble();
      return;
    }
    if (!outsideWarned) {
      setOutsideWarned(true);
      return;
    }
    closeOpenAnnotationBubble();
  }, [
    canSaveOpenBubble,
    closeOpenAnnotationBubble,
    openBubbleBase,
    outsideWarned,
    setOutsideWarned,
  ]);

  const linkedPeersForKey = useCallback(
    (key: VisualProposalKey): VisualProposalKey[] => {
      return VISUAL_LINK_PAIRS.flatMap((pair) => {
        if (!linkedVisualPairs[pair.id]) return [];
        if (!(pair.keys as readonly VisualProposalKey[]).includes(key)) return [];
        return pair.keys.filter((candidate) => candidate !== key);
      });
    },
    [linkedVisualPairs],
  );

  const updateBubbleVisualControl = useCallback(
    (key: VisualProposalKey, rawValue: string | number): void => {
      const nextValue =
        typeof rawValue === "number"
          ? rawValue
          : encodeVisualControlValue(key, rawValue);
      const linkedPeers = linkedPeersForKey(key);
      setBubbleVisuals((prev) => {
        const next: Record<string, string | number> = { ...prev, [key]: nextValue };
        for (const peer of linkedPeers) next[peer] = nextValue;
        return next as PreviewAnnotationVisualProposal;
      });
      setOutsideWarned(false);
    },
    [linkedPeersForKey, setBubbleVisuals, setOutsideWarned],
  );

  const toggleVisualLinkPair = useCallback(
    (pairId: VisualLinkPairId): void => {
      const pair = VISUAL_LINK_PAIRS.find((candidate) => candidate.id === pairId);
      if (!pair) return;
      const willEnable = !linkedVisualPairs[pairId];
      setLinkedVisualPairs((prev) => ({ ...prev, [pairId]: willEnable }));
      if (!willEnable) return;
      setBubbleVisuals((prev) => {
        const source = prev[pair.keys[0]];
        if (source === undefined || String(source).trim() === "") return prev;
        return {
          ...prev,
          [pair.keys[1]]: source,
        };
      });
      setOutsideWarned(false);
    },
    [linkedVisualPairs, setBubbleVisuals, setLinkedVisualPairs, setOutsideWarned],
  );

  const updateColorFormat = useCallback(
    (key: ColorVisualProposalKey, format: ColorFormat): void => {
      setColorFormats((prev) => ({ ...prev, [key]: format }));
      const parsed = parseColorValue(bubbleVisuals[key]);
      if (!parsed) return;
      updateBubbleVisualControl(key, formatColorValue(parsed, format));
    },
    [bubbleVisuals, setColorFormats, updateBubbleVisualControl],
  );

  useEffect(() => {
    if (!openBubbleBase) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (isAnnotationBubbleInteractionTarget(event.target, bubbleRef.current)) return;
      requestOutsideBubbleDiscard();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [bubbleRef, openBubbleBase, requestOutsideBubbleDiscard]);

  const clearTransientAnnotationState = closeOpenAnnotationBubble;

  const handleDesignEscape = useCallback((): void => {
    // When an inline autocomplete popup is open inside the bubble (slash
    // command or file mention), Escape must close only that popup, not the
    // bubble itself. The document capture listener fires before the input's
    // React synthetic handler, so we intercept here. Dismissing the popup
    // and returning prevents the capture listener from also closing the bubble.
    if (bubbleSlashOpen) {
      dismissBubbleSlash();
      return;
    }
    if (bubbleFileOpen) {
      dismissBubbleFile();
      return;
    }
    if (hasOpenBubble) {
      closeOpenAnnotationBubble();
      return;
    }
    closeOpenAnnotationBubble();
    designModeSetActive(threadId, false);
    void window.desktopBridge?.preview?.cancelCapture();
  }, [
    bubbleSlashOpen,
    bubbleFileOpen,
    closeOpenAnnotationBubble,
    designModeSetActive,
    dismissBubbleSlash,
    dismissBubbleFile,
    hasOpenBubble,
    threadId,
  ]);

  // Design mode is a single state: "next click on the page captures the
  // element under the cursor, repeat until you turn the mode off." Toggling it
  // off cancels any in-flight capture so the picker never sticks.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (!willActivate) {
      clearTransientAnnotationState();
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  // `capture` is a new object on every render, and starting a pick flips its
  // busy flag. Depending on it re-armed the pick on that render, and each new
  // request makes the desktop host abort the pending pick and reinject the
  // guest overlay, so the hover highlight never appeared.
  const requestElementPick = useEffectEvent(() => capture.onAddElementAnnotation());

  useEffect(() => {
    if (!designModeActive || hasOpenBubble) return;
    let cancelled = false;
    const pickNext = async (): Promise<void> => {
      if (!usePreviewDesignModeStore.getState().isActive(threadId)) return;
      const result = await requestElementPick();
      if (cancelled) return;
      if (!result.ok) {
        // Cancel / error / Esc-in-guest: exit the mode entirely so the
        // user has a single, consistent way to escape a sticky picker.
        clearTransientAnnotationState();
        designModeSetActive(threadId, false);
      }
    };
    void pickNext();
    return () => {
      cancelled = true;
    };
  }, [
    designModeActive,
    hasOpenBubble,
    threadId,
    clearTransientAnnotationState,
    designModeSetActive,
  ]);

  // Esc must exit design mode no matter where focus is. The global
  // escape.handle binding (default-keybindings.json) closes the current
  // thread on Esc, which would yank the user out of their workspace mid
  // pick session. We attach at capture phase with stopImmediatePropagation
  // so this listener fires before the global keybinding-manager dispatch.
  useEffect(() => {
    if (!designModeActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleDesignEscape();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [designModeActive, handleDesignEscape]);

  useEffect(() => {
    if (!designModeActive) return;
    const onDesignEscape = (event: Event): void => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId && detail.threadId !== threadId) return;
      event.preventDefault();
      handleDesignEscape();
    };
    window.addEventListener("mcode:preview-design-escape", onDesignEscape);
    return () =>
      window.removeEventListener("mcode:preview-design-escape", onDesignEscape);
  }, [designModeActive, handleDesignEscape, threadId]);

  return {
    clearTransientAnnotationState,
    onToggleDesignMode,
    updateBubbleVisualControl,
    updateColorFormat,
    toggleVisualLinkPair,
  };
}
