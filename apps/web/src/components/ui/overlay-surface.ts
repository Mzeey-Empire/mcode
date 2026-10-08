/**
 * Paper's transient surface recipes. Every overlay paints its fill, border, radius and shadow
 * from here so the two themes stay in step: the shadow tokens switch to the light overlay
 * recipe in the light theme.
 */

/** Menus, popovers, pickers and hover cards. */
export const POPOVER_SURFACE_CLASS = "rounded-composer border border-border bg-panel text-ink shadow-popover";

/** Dialogs and sheets. */
export const DIALOG_SURFACE_CLASS = "rounded-dialog border border-border bg-panel text-ink shadow-dialog";

/** Control groups that float over content, such as a zoom bar. */
export const FLOATING_SURFACE_CLASS = "rounded-full border border-border bg-panel text-ink shadow-floating";

/** Standard-duration opacity fade for menus and popovers. Paper never scales or slides them. */
export const POPOVER_FADE_CLASS =
  "duration-(--duration-standard) ease-(--ease-standard) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none";

/** Overlay-duration opacity fade for dialogs and their backdrops. */
export const DIALOG_FADE_CLASS =
  "duration-(--duration-overlay) ease-(--ease-standard) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none";
