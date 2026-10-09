import type { Toast } from "@/stores/toastStore";

/** Space between stacked toasts, in px. */
export const TOAST_STACK_GAP_PX = 10;
/** How far each card behind the front one shows below it in a collapsed stack, in px. */
export const TOAST_PEEK_PX = 8;
/** How much each card behind the front one shrinks in a collapsed stack. */
export const TOAST_PEEK_SCALE_STEP = 0.05;

/** Where a toast sits in the lane: its offset from the lane top and its scale. */
export interface ToastPlacement {
  readonly offset: number;
  readonly scale: number;
}

/** The placement of a toast that has not been laid out yet. */
export const FRONT_PLACEMENT: ToastPlacement = { offset: 0, scale: 1 };

/**
 * A toast the lane is drawing. An exiting toast has left the store but stays
 * on screen for its exit animation, frozen at the placement it had when it left.
 */
export interface ToastPresence {
  readonly toast: Toast;
  readonly exiting: boolean;
  readonly placement: ToastPlacement;
}

/**
 * Placements for each live toast. Expanded, the toasts stack in order.
 * Collapsed, each older toast sits behind the front one, smaller, with its
 * bottom edge peeking out. Its bottom aligns to the front toast's bottom so a
 * taller front toast doesn't hide it. Exiting toasts take no space, so the
 * rest reflow while they leave.
 */
export function layoutToastStack(
  entries: readonly ToastPresence[],
  heights: ReadonlyMap<string, number>,
  expanded: boolean,
): Map<string, ToastPlacement> {
  const live = entries.filter((entry) => !entry.exiting);
  const heightOf = (entry: ToastPresence) => heights.get(entry.toast.id) ?? 0;
  const placements = new Map<string, ToastPlacement>();
  if (!expanded) {
    const frontHeight = live[0] ? heightOf(live[0]) : 0;
    live.forEach((entry, depth) => {
      const peek = depth * TOAST_PEEK_PX;
      const offset = Math.max(peek, frontHeight - heightOf(entry) + peek);
      placements.set(entry.toast.id, { offset, scale: 1 - depth * TOAST_PEEK_SCALE_STEP });
    });
    return placements;
  }
  let offset = 0;
  for (const entry of live) {
    placements.set(entry.toast.id, { offset, scale: 1 });
    offset += heightOf(entry) + TOAST_STACK_GAP_PX;
  }
  return placements;
}

/**
 * Reconciles what the lane draws with the store. New toasts go on top, a
 * replaced toast keeps its slot, and a toast that left the store keeps its
 * place as an exiting entry until the lane removes it.
 */
export function mergeToastPresence(
  previous: readonly ToastPresence[],
  live: readonly Toast[],
  placements: ReadonlyMap<string, ToastPlacement>,
): ToastPresence[] {
  const liveById = new Map(live.map((toast) => [toast.id, toast]));
  const previousIds = new Set(previous.map((entry) => entry.toast.id));
  const added = live
    .filter((toast) => !previousIds.has(toast.id))
    .map((toast): ToastPresence => ({ toast, exiting: false, placement: FRONT_PLACEMENT }));
  const kept = previous.map((entry): ToastPresence => {
    const placement = placements.get(entry.toast.id) ?? entry.placement;
    const toast = liveById.get(entry.toast.id);
    if (toast) return { toast, exiting: false, placement };
    if (entry.exiting) return entry;
    return { ...entry, exiting: true, placement };
  });
  return [...added, ...kept];
}
