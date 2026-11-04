import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { nextTaskTrayPhase, type TaskTrayPhase } from "./task-tray-model";

const TRAY_CLIP = "inset(0px 0px 0px 0px round 14px 14px 0px 0px)";
const MORPH_EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** The tray's clip shrunk to the tab's box, so the tray grows out of the tab. */
function tabClip(tab: HTMLElement, tray: HTMLElement): string {
  const t = tab.getBoundingClientRect();
  const r = tray.getBoundingClientRect();
  return `inset(${t.top - r.top}px ${r.right - t.right}px ${r.bottom - t.bottom}px ${t.left - r.left}px round 10px 10px 0px 0px)`;
}

/** Elements and handlers the task tab and tray wire up. */
export interface TaskTray {
  readonly phase: TaskTrayPhase;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly tabRef: RefObject<HTMLButtonElement | null>;
  readonly trayRef: RefObject<HTMLDivElement | null>;
  readonly headerRef: RefObject<HTMLButtonElement | null>;
  readonly bodyRef: RefObject<HTMLDivElement | null>;
  readonly toggle: () => void;
  /** Close from the header, returning focus to the tab. */
  readonly close: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Owns the tray's phase and its morph out of and back into the tab, outside
 * pointerdown and Escape dismissal, focus moves, and closing when covered.
 */
export function useTaskTray(covered: boolean): TaskTray {
  const [phase, dispatch] = useReducer(nextTaskTrayPhase, "closed");
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  // The tab is invisible until the tray unmounts, and an invisible element cannot take focus.
  const focusTabWhenClosedRef = useRef(false);

  const cancelAnimation = () => {
    animationRef.current?.cancel();
    animationRef.current = null;
  };

  useEffect(() => {
    if (!covered) return;
    cancelAnimation();
    focusTabWhenClosedRef.current = false;
    dispatch({ type: "cover" });
  }, [covered]);

  useEffect(() => cancelAnimation, []);

  useLayoutEffect(() => {
    if (phase === "closed" && focusTabWhenClosedRef.current) {
      focusTabWhenClosedRef.current = false;
      tabRef.current?.focus();
    }
    if (phase !== "open") return;
    const tab = tabRef.current;
    const tray = trayRef.current;
    if (tab && tray && !prefersReducedMotion()) {
      animationRef.current = tray.animate([{ clipPath: tabClip(tab, tray) }, { clipPath: TRAY_CLIP }], {
        duration: 280,
        easing: MORPH_EASE,
      });
      bodyRef.current?.animate(
        [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
        { duration: 200, delay: 90, easing: MORPH_EASE, fill: "backwards" },
      );
    }
    headerRef.current?.focus();
  }, [phase]);

  const dismiss = useCallback((restoreFocus: boolean) => {
    focusTabWhenClosedRef.current = restoreFocus;
    cancelAnimation();
    const tab = tabRef.current;
    const tray = trayRef.current;
    if (!tab || !tray || prefersReducedMotion()) {
      dispatch({ type: "dismiss", animate: false });
      return;
    }
    dispatch({ type: "dismiss", animate: true });
    // Held at the tab's box until React unmounts the tray, or the full tray paints for a frame.
    const fold = tray.animate([{ clipPath: TRAY_CLIP }, { clipPath: tabClip(tab, tray) }], {
      duration: 200,
      easing: MORPH_EASE,
      fill: "forwards",
    });
    animationRef.current = fold;
    fold.onfinish = () => {
      animationRef.current = null;
      dispatch({ type: "folded" });
    };
  }, []);

  useEffect(() => {
    if (phase !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      dismiss(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [phase, dismiss]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || phase !== "open") return;
    event.stopPropagation();
    dismiss(true);
  };

  return {
    phase,
    rootRef,
    tabRef,
    trayRef,
    headerRef,
    bodyRef,
    toggle: () => dispatch({ type: "toggle" }),
    close: () => dismiss(true),
    onKeyDown,
  };
}
