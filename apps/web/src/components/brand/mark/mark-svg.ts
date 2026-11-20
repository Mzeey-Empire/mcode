import { circuit, DENSE, FACE_MATRIX, GLOW_FILTER, greyCuts, litGroup, type Circuit, type CircuitSpec } from "./circuit";
import { fixed2, slabStack, type SlabStack } from "./geometry";
import { MASK_KEEP } from "./palette";
import { STATE_BODY, type McodeMarkState } from "./states";

export type { McodeMarkState } from "./states";

/** Repo-relative path of each committed static mark file. */
export type StaticMarkPath = "apps/desktop/build/icon.svg";

const HEAD = `  <title id="title">Mcode layered circuit mark</title>
  <desc id="desc">A transparent Mcode mark: three stacked worktree layers. The top layer carries a chip with amber live traces, and its other traces are cut through it.</desc>`;

/** Splits generated circuit markup onto one line per group so the file stays reviewable. */
const pretty = (s: string, pad: string): string => s.replace(/(<g |<\/g>|<rect |<defs>|<filter )/g, `\n${pad}$1`).trim();

const indent = (s: string): string =>
  s
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");

interface MarkParts {
  readonly stack: SlabStack;
  readonly defs: string;
  readonly layers: string;
  readonly face: string;
}

function markDefs(stack: SlabStack, board: Circuit): string {
  return `  <defs>
${stack.defs}
    <clipPath id="faceClip">
      <use href="#slab" />
    </clipPath>
    <mask id="traceCuts" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="600">
      <rect width="512" height="600" fill="${MASK_KEEP}" />
      <g clip-path="url(#faceClip)">
        <g transform="${FACE_MATRIX}">
          ${pretty(greyCuts(board), "          ")}
        </g>
      </g>
    </mask>
    ${GLOW_FILTER}
  </defs>`;
}

function markParts(spacing: { step: number; gap: number }, spec: CircuitSpec, pad: string): MarkParts {
  const stack = slabStack({ ...spacing, topMask: "traceCuts" });
  const board = circuit(spec);
  const defs = markDefs(stack, board);
  const { low, mid, top } = stack.layers;
  const face = `<g clip-path="url(#faceClip)">
${pad}  <g transform="${FACE_MATRIX}">
${pad}    ${pretty(litGroup(board), `${pad}    `)}
${pad}  </g>
${pad}</g>`;
  return { stack, defs, layers: `${low}\n  ${mid}\n  ${top}`, face };
}

/** One sidebar pixel at 35 px: spacing in whole pixels keeps the gaps crisp. */
const SIDEBAR_PX = 400 / 35;
const MAIN = { step: 4 * SIDEBAR_PX, gap: SIDEBAR_PX, viewY: 366.37 - 24 * SIDEBAR_PX };

function desktopFile(): string {
  const { stack, defs, layers, face } = markParts(MAIN, DENSE, "    ");
  const centre = (stack.top + stack.bottom) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
${HEAD}
  <!-- Construction: one slab, a rhombus with true circular fillets (52 top and bottom, 22 at the
       sides), stacked ${fixed2(MAIN.step)} units apart. Each gap is the slab above swept ${fixed2(MAIN.gap)} units down, so gaps
       and layers keep the slab's own curves. The circuit is drawn flat in a 200 x 200 square and the
       matrix projects it onto the top face, so traces, pads and the chip sit in the slab's perspective.
       The grey traces are a mask on the top slab, so the background shows through them in any theme.
       Generated from apps/web/src/components/brand/mark/. -->
${defs}

  <!-- Scale mark up for dock/taskbar parity; the UI draws the unscaled mark inline.
       The art spans y ${Math.round(stack.top)}-${Math.round(stack.bottom)}, so it scales about its centre (${fixed2(centre)}) and moves to the canvas centre.
       Masks and the clip use the art's coordinates because they inherit this transform. -->
  <g transform="translate(256 256) scale(1.3) translate(-256 -${fixed2(centre)})">
    ${indent(layers).trimStart()}

    ${face}
  </g>
</svg>
`;
}

/** Every committed static mark file, keyed by repo-relative path, generated from the art module. */
export function staticMarkFiles(): Readonly<Record<StaticMarkPath, string>> {
  return {
    "apps/desktop/build/icon.svg": desktopFile(),
  };
}

function prefixIds(svg: string, prefix: string): string {
  return svg
    .replace(/ id="([^"]+)"/g, ` id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
}

/** Keyed by every state, so a new state fails the build until it has a name. */
const MARK_LABEL: Record<McodeMarkState, string> = {
  boot: "Mcode",
  loading: "Mcode",
  quiet: "Mcode",
  running: "Mcode, running",
  "setting-up": "Mcode, setting up",
  "needs-you": "Mcode, needs you",
  finished: "Mcode, finished",
  failed: "Mcode, failed",
};

/**
 * The full-size mark in one state, as an inline `<svg class="mcode-mark">` whose motion lives in
 * mcode-mark.css. `idPrefix` must be unique in the document.
 */
export function markSvg(state: McodeMarkState, idPrefix: string): string {
  const stack = slabStack({ ...MAIN, topMask: "traceCuts" });
  const board = circuit(DENSE);
  const { low, mid, top } = stack.layers;
  const face = `<g clip-path="url(#faceClip)"><g transform="${FACE_MATRIX}">${STATE_BODY[state](board)}</g></g>`;
  const svg = `<svg class="mcode-mark" data-state="${state}" xmlns="http://www.w3.org/2000/svg" viewBox="56 ${fixed2(MAIN.viewY)} 400 400" role="img" aria-label="${MARK_LABEL[state]}" style="--mark-step:${fixed2(MAIN.step)}px">
${markDefs(stack, board)}
  <g class="L0">${low}</g>
  <g class="L1">${mid}</g>
  <g class="L2">${top}${face}</g>
</svg>`;
  return prefixIds(svg, `${idPrefix}-`);
}

/** The startup screen placed in `#root` before any script runs: the boot mark, then loading. */
export function preloaderHtml(): string {
  return `<div class="mcode-preloader" role="status"><div class="mcode-preloader-mark" aria-hidden="true">${markSvg("boot", "preboot")}${markSvg("loading", "preload")}</div><p>Connecting to server...</p></div>`;
}
