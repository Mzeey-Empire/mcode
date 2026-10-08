/**
 * Paper's focus ring: 2px, drawn 2px outside the control. It is an outline, so it follows the
 * border radius and takes no layout space. A control that sits inside a container drawing its
 * own focus drops it with `focus-visible:outline-0`, which tailwind-merge resolves against
 * `outline-2`.
 */
export const FOCUS_RING_CLASS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
