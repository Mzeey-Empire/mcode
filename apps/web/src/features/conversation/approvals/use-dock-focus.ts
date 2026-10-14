import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Focus handoff shared by the docks that replace the composer. When `key` changes, focus
 * moves into the dock only if the user's attention was already here (nowhere, or the
 * hidden composer), so a user typing in the terminal or browser panel is never
 * interrupted. When the dock unmounts with focus inside, the composer takes it back.
 */
export function useDockFocus(
  rootRef: RefObject<HTMLElement | null>,
  composerContainerRef: RefObject<HTMLElement | null>,
  onFocusComposer: () => void,
  focusTarget: () => HTMLElement | null | undefined,
  key: string | undefined,
): void {
  // Read through refs so the effects run on key change and unmount only, not whenever a caller passes a fresh callback.
  const focusTargetRef = useRef(focusTarget);
  focusTargetRef.current = focusTarget;
  const focusComposerRef = useRef(onFocusComposer);
  focusComposerRef.current = onFocusComposer;

  useEffect(() => {
    const focused = document.activeElement;
    const attentionHere = !focused || focused === document.body
      || rootRef.current?.contains(focused) || composerContainerRef.current?.contains(focused);
    if (attentionHere) focusTargetRef.current()?.focus();
  }, [key, rootRef, composerContainerRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      // Layout cleanup still sees the dock attached; by the microtask the composer is visible again.
      if (root?.contains(document.activeElement)) queueMicrotask(() => focusComposerRef.current());
    };
  }, [rootRef]);
}
