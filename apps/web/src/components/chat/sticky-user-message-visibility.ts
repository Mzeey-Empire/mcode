/** Minimal virtualizer surface used to decide sticky visibility. */
export interface StickyVisibilityVirtualizer {
  getVirtualItems: () => ReadonlyArray<{ index: number; start: number; size: number }>;
}

/**
 * Returns true when the last user message has scrolled fully above the list viewport
 * and the sticky preview should pin at the top.
 */
export function shouldShowStickyUserMessage(
  container: HTMLElement,
  messageId: string,
  itemIndex: number,
  virtualizer: StickyVisibilityVirtualizer,
): boolean {
  const viewportHeight = container.clientHeight;
  const scrollTop = container.scrollTop;
  const domEl = container.querySelector(`[data-message-id="${messageId}"]`);

  if (domEl) {
    const containerRect = container.getBoundingClientRect();
    const msgRect = domEl.getBoundingClientRect();
    const relativeTop = msgRect.top - containerRect.top;
    const relativeBottom = msgRect.bottom - containerRect.top;
    if (relativeBottom > 0 && relativeTop < viewportHeight) {
      return false;
    }
    return relativeBottom <= 0;
  }

  const visible = virtualizer.getVirtualItems();
  if (visible.length === 0) return false;

  const firstVisible = visible[0]!;
  if (itemIndex < firstVisible.index) {
    return true;
  }

  const match = visible.find((item) => item.index === itemIndex);
  if (!match) return false;

  const messageBottom = match.start + match.size - scrollTop;
  return messageBottom <= 0;
}
