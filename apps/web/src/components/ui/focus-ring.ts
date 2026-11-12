/**
 * Paper's focus ring: 2px, drawn 2px outside the control. It is an outline, so it follows the
 * border radius and takes no layout space. A control that sits inside a container drawing its
 * own focus drops it with `focus-visible:outline-0`, which tailwind-merge resolves against
 * `outline-2`.
 */
export const FOCUS_RING_CLASS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * The same ring drawn inside a row of a menu, list or pane. Those rows sit 4px from their container's edge, so a
 * ring outside the row would touch that edge or a divider beside it.
 */
export const FOCUS_RING_INSET_CLASS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
