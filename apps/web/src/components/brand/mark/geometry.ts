import { MASK_CUT, MASK_KEEP, SLAB_GRADIENTS, type SlabGradient } from "./palette";

/**
 * One slab: a rhombus with true circular fillets, 52 at the top and bottom corners and 22 at the
 * sides, centred on (256, 246).
 */
export const SLAB_PATH =
  "M225.74 135.35A52 52 0 0 1 286.26 135.35L415.89 228.11A22 22 0 0 1 415.89 263.89L286.26 356.65A52 52 0 0 1 225.74 356.65L96.11 263.89A22 22 0 0 1 96.11 228.11Z";

const SLAB_TOP = 125.64;
const SLAB_BOTTOM = 366.37;

/** Rounds to two decimals and drops trailing zeros, the number format of every committed file. */
export const fixed2 = (n: number): number => +n.toFixed(2);

/** Spacing of the three-slab stack, in art units. */
export interface SlabStackOptions {
  /** Vertical distance between neighbouring slabs. */
  readonly step: number;
  /** Height of the cut swept below each upper slab. */
  readonly gap: number;
  /** Mask id applied to the top slab, if any. */
  readonly topMask?: string;
}

/** The slab stack as separate SVG parts, so callers compose them without editing strings. */
export interface SlabStack {
  /** Defs lines (gradients, the slab path, gap masks), indented for a `<defs>` element. */
  readonly defs: string;
  /** Each slab's element, lowest first in paint order. */
  readonly layers: { readonly low: string; readonly mid: string; readonly top: string };
  /** Topmost y of the art. */
  readonly top: number;
  /** Lowest y of the art. */
  readonly bottom: number;
}

function gradient(id: string, [from, to]: SlabGradient, dy: number): string {
  const top = id === "topLayer";
  return `    <linearGradient id="${id}" x1="${top ? 153 : 151}" y1="${fixed2((top ? 145 : 151) + dy)}" x2="${top ? 353 : 354}" y2="${fixed2((top ? 343 : 349) + dy)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${from}" />
      <stop offset="1" stop-color="${to}" />
    </linearGradient>`;
}

function gapMask(id: string, dy: number, gap: number): string {
  return `    <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="600">
      <rect width="512" height="600" fill="${MASK_KEEP}" />
      <g fill="${MASK_CUT}">
        <use href="#slab"${dy ? ` transform="translate(0 ${fixed2(dy)})"` : ""} />
        <use href="#slab" transform="translate(0 ${fixed2(dy + gap)})" />
        <rect x="86" y="${fixed2(246 + dy)}" width="340" height="${fixed2(gap)}" />
      </g>
    </mask>`;
}

/**
 * Builds three slabs stacked `step` apart. Each gap is the slab above swept `gap` units down, so
 * gaps keep the slab's own curves.
 */
export function slabStack({ step, gap, topMask }: SlabStackOptions): SlabStack {
  const defs = [
    gradient("topLayer", SLAB_GRADIENTS.top, 0),
    gradient("midLayer", SLAB_GRADIENTS.mid, step),
    gradient("lowLayer", SLAB_GRADIENTS.low, 2 * step),
    `    <path id="slab" d="${SLAB_PATH}" />`,
    gapMask("gapBelowTop", 0, gap),
    gapMask("gapBelowMid", step, gap),
  ].join("\n");
  const layers = {
    low: `<g mask="url(#gapBelowMid)">
    <use href="#slab" transform="translate(0 ${fixed2(2 * step)})" fill="url(#lowLayer)" />
  </g>`,
    mid: `<g mask="url(#gapBelowTop)">
    <use href="#slab" transform="translate(0 ${fixed2(step)})" fill="url(#midLayer)" />
  </g>`,
    top: `<use href="#slab" fill="url(#topLayer)"${topMask ? ` mask="url(#${topMask})"` : ""} />`,
  };
  return { defs, layers, top: SLAB_TOP, bottom: SLAB_BOTTOM + 2 * step };
}
