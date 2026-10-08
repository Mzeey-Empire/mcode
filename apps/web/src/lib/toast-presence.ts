import type { Toast } from "@/stores/toastStore";

/** Space between stacked toasts, in px. */
export const TOAST_STACK_GAP_PX = 10;

/**
 * A toast the lane is drawing. An exiting toast has left the store but stays
 * on screen for its exit animation, frozen at the offset it had when it left.
 */
export interface ToastPresence {
  readonly toast: Toast;
  readonly exiting: boolean;
  readonly offset: number;
}

/**
 * Offsets from the top of the lane for each live toast, stacked in order.
 * Exiting toasts take no space, so the rest reflow while they leave.
 */
export function layoutToastStack(
  entries: readonly ToastPresence[],
  heights: ReadonlyMap<string, number>,
): Map<string, number> {
  const offsets = new Map<string, number>();
  let y = 0;
  for (const entry of entries) {
    if (entry.exiting) continue;
    offsets.set(entry.toast.id, y);
    y += (heights.get(entry.toast.id) ?? 0) + TOAST_STACK_GAP_PX;
  }
  return offsets;
}

/**
 * Reconciles what the lane draws with the store. New toasts go on top, a
 * replaced toast keeps its slot, and a toast that left the store keeps its
 * place as an exiting entry until the lane removes it.
 */
export function mergeToastPresence(
  previous: readonly ToastPresence[],
  live: readonly Toast[],
  offsets: ReadonlyMap<string, number>,
): ToastPresence[] {
  const liveById = new Map(live.map((toast) => [toast.id, toast]));
  const previousIds = new Set(previous.map((entry) => entry.toast.id));
  const added = live
    .filter((toast) => !previousIds.has(toast.id))
    .map((toast) => ({ toast, exiting: false, offset: 0 }));
  const kept = previous.map((entry): ToastPresence => {
    const toast = liveById.get(entry.toast.id);
    if (toast) return { toast, exiting: false, offset: offsets.get(toast.id) ?? entry.offset };
    if (entry.exiting) return entry;
    return { ...entry, exiting: true, offset: offsets.get(entry.toast.id) ?? entry.offset };
  });
  return [...added, ...kept];
}
