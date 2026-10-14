/**
 * Narrowest width the main content keeps beside a docked side pane (Review's
 * Files navigator, the Files tool tree). Below this the content is too cramped
 * to read code, so the pane becomes a view the user toggles instead.
 */
export const SIDE_PANE_CONTENT_MIN_WIDTH = 520;

/** True when a side pane of `paneWidth` fits beside the content in `bodyWidth`. */
export function sidePaneDocks(bodyWidth: number, paneWidth: number): boolean {
  return bodyWidth >= paneWidth + SIDE_PANE_CONTENT_MIN_WIDTH;
}
