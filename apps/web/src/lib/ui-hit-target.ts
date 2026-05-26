/** Expands icon buttons to a ~44px effective hit target without changing layout. */
export const ICON_HIT_SLOP =
  "relative before:absolute before:-inset-2 before:content-['']";

/** Tighter hit slop for compact controls nested beside labels (tab close, etc.). */
export const COMPACT_ICON_HIT_SLOP =
  "relative before:absolute before:-inset-1 before:content-['']";

/** Positions a remove control with a 44px tap area and a smaller visual glyph. */
export const ATTACHMENT_REMOVE_HIT_AREA =
  "absolute right-0 top-0 z-20 flex h-11 w-11 items-start justify-end p-1";
