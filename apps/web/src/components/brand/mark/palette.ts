/** Gradient stops, light then dark, for one slab of the mark. */
export type SlabGradient = readonly [string, string];

/** Gradient stops for the three stacked slabs, top to bottom. */
export const SLAB_GRADIENTS = {
  top: ["#3a414c", "#2c333e"],
  mid: ["#353e4a", "#2a323d"],
  low: ["#323a46", "#272f3a"],
} as const satisfies Record<"top" | "mid" | "low", SlabGradient>;

/** Filament Amber: live traces, the glowing chip outline, and the chip's pin-one dot. */
export const AMBER = "#e19100";

/** Highlight on a live trace's pad. */
export const AMBER_HIGHLIGHT = "#ffc04d";

/** Chip body fill. */
export const CHIP_FILL = "#0f141c";

/** Mask luminance that keeps what it covers. */
export const MASK_KEEP = "#fff";

/** Mask luminance that cuts what it covers. */
export const MASK_CUT = "#000";

/** A live trace with no current: the quiet and loading states, and a failed trace under its stubs. */
export const UNLIT = "#4a5361";

/** Chip outline while no current flows: the quiet, loading and failed states. */
export const CHIP_OUTLINE = "#2a3240";
