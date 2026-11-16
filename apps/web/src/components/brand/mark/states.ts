import type { ThreadRowState } from "@/features/thread-attention/thread-row-state";
import { TRACE_GLOW_ID, type Circuit, type Trace } from "./circuit";
import { fixed2 } from "./geometry";
import { AMBER, AMBER_HIGHLIGHT, CHIP_FILL, CHIP_OUTLINE, UNLIT } from "./palette";

/** Every state the mark can show. The last five are exactly `ThreadRowState["kind"]`. */
export type McodeMarkState = "boot" | "loading" | ThreadRowState["kind"];

const rotated = (t: Trace, body: string): string => `<g transform="rotate(${t.side * 90})">${body}</g>`;

/** Paths carry `pathLength="1"` so dash keyframes are the same for every trace length. */
const paths = (list: readonly Trace[], attrs: (t: Trace) => string = () => ""): string =>
  list.map((t) => rotated(t, `<path d="${t.d}" pathLength="1"${attrs(t)}/>`)).join("");

const pads = (list: readonly Trace[], r: number, fill: string): string =>
  list
    .filter((t) => t.end < 100)
    .map((t) => rotated(t, `<circle cx="${t.end}" cy="${t.y}" r="${fixed2(r)}" fill="${fill}"/>`))
    .join("");

const stroke = (colour: string, width: number): string =>
  `fill="none" stroke="${colour}" stroke-width="${fixed2(width)}" stroke-linecap="round" stroke-linejoin="round"`;

const liveOf = ({ traces }: Circuit): Trace[] => traces.filter((t) => t.live);

function unlit(c: Circuit, pinLit: boolean): string {
  const { chip, w } = c.spec;
  const live = liveOf(c);
  return (
    `<g ${stroke(UNLIT, w * 1.25)}>${paths(live)}</g>${pads(live, w * 1.6, UNLIT)}` +
    `<rect x="${-chip}" y="${-chip}" width="${chip * 2}" height="${chip * 2}" rx="3" fill="${CHIP_FILL}" stroke="${CHIP_OUTLINE}" stroke-width="1.2"/>` +
    `<circle cx="${chip - 8}" cy="${-chip + 8}" r="2.6" fill="${pinLit ? AMBER : UNLIT}"/>`
  );
}

function lit(c: Circuit): string {
  const { w } = c.spec;
  const live = liveOf(c);
  const amber = `<g ${stroke(AMBER, w * 1.25)}>${paths(live)}</g>`;
  return `<g class="lit"><g filter="url(#${TRACE_GLOW_ID})" opacity="0.9">${amber}</g>${amber}${pads(live, w * 1.6, AMBER_HIGHLIGHT)}</g>`;
}

function chipEdge({ spec: { chip } }: Circuit, colour: string = AMBER): string {
  return (
    `<rect class="edge" x="${-chip}" y="${-chip}" width="${chip * 2}" height="${chip * 2}" rx="3" fill="none" stroke="${colour}" stroke-width="1.6"/>` +
    `<circle class="pin" cx="${chip - 8}" cy="${-chip + 8}" r="2.6" fill="${colour}"/>`
  );
}

function flow(c: Circuit, list: readonly Trace[], delay: (t: Trace) => number): string {
  const body = paths(list, (t) => ` class="flow" style="animation-delay:${fixed2(delay(t))}s"`);
  return `<g ${stroke(AMBER_HIGHLIGHT, c.spec.w * 1.1)}>${body}</g>`;
}

function fill(c: Circuit): string {
  return `<g class="fillg"><g ${stroke(AMBER_HIGHLIGHT, c.spec.w)}>${paths(c.traces, () => ` class="fill"`)}</g></g>`;
}

function stubs(c: Circuit): string {
  return `<g class="stub"><g ${stroke(AMBER, c.spec.w * 1.25)}>${paths(liveOf(c), () => ` stroke-dasharray="0.32 1"`)}</g></g>`;
}

/**
 * Each state's circuit, drawn flat on the top face. Keyed by every state, so a new
 * `ThreadRowState` kind fails the build until it has art.
 */
export const STATE_BODY: Record<McodeMarkState, (c: Circuit) => string> = {
  boot: (c) => unlit(c, false) + fill(c) + lit(c) + chipEdge(c),
  loading: (c) =>
    unlit(c, false) + flow(c, c.traces, (t) => t.side * 0.4 + t.pin * 0.02) + `<g class="breathe">${chipEdge(c)}</g>`,
  quiet: (c) => unlit(c, true),
  running: (c) =>
    unlit(c, false) + lit(c) + chipEdge(c) + flow(c, liveOf(c), (t) => (t.side * 0.7 + t.pin * 0.35) % 2.4),
  "needs-you": (c) => unlit(c, false) + lit(c) + `<g class="call">${chipEdge(c, AMBER_HIGHLIGHT)}</g>`,
  finished: (c) => unlit(c, false) + fill(c) + lit(c) + chipEdge(c),
  failed: (c) => unlit(c, false) + stubs(c) + lit(c) + `<g class="die">${chipEdge(c)}</g>`,
};
