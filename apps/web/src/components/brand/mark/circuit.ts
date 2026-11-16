import { fixed2 } from "./geometry";
import { AMBER, AMBER_HIGHLIGHT, CHIP_FILL, MASK_CUT } from "./palette";

/** A chip side, counted clockwise from +x in the flat square; side k is side 0 rotated k * 90 degrees. */
export type CircuitSide = 0 | 1 | 2 | 3;

/** Shape of a chip-centred circuit, drawn flat in a 200 x 200 square centred on the origin. */
export interface CircuitSpec {
  /** Pins on each side of the chip. */
  readonly pinCount: number;
  /** Distance between neighbouring pins. */
  readonly pitch: number;
  /** Half the chip's width. */
  readonly chip: number;
  /** Grey trace width; live traces and pads scale from it. */
  readonly w: number;
  /** How far each trace fans out from its pin after the bend. */
  readonly fan: number;
  /** Each side's trace end x, cycled over its pins; 100 runs off the square with no pad. */
  readonly endsBySide: readonly [readonly number[], readonly number[], readonly number[], readonly number[]];
  /** Pin indexes whose traces are live (amber), per side. */
  readonly liveSides: Partial<Record<CircuitSide, readonly number[]>>;
}

/** One trace, in its side's frame (side 0 drawn along +x). */
export interface Trace {
  readonly side: CircuitSide;
  /** Pin index on its side. */
  readonly pin: number;
  readonly live: boolean;
  /** Path from the pin mark, through the bend, to the end. */
  readonly d: string;
  /** End x; a pad sits there when it is inside the square. */
  readonly end: number;
  /** The pad's y, the trace's flat run after the bend. */
  readonly y: number;
}

/** A circuit spec and the traces it produces. */
export interface Circuit {
  readonly spec: CircuitSpec;
  readonly traces: readonly Trace[];
}

/** The seven-pin circuit on the full-size mark. */
export const DENSE: CircuitSpec = {
  pinCount: 7,
  pitch: 6,
  chip: 24,
  w: 2.4,
  fan: 2.9,
  endsBySide: [
    [60, 100, 78, 100, 68, 100, 54],
    [100, 70, 100, 58, 100, 82, 100],
    [64, 100, 52, 100, 76, 100, 62],
    [100, 56, 100, 72, 100, 60, 100],
  ],
  liveSides: { 0: [2, 4], 2: [3], 3: [1] },
};

const FACE_A = 184.9;
const FACE_B = 132.3;

/**
 * Projects the flat square onto the top face: flat (100, -100) lands on the top corner and
 * (100, 100) on the right corner.
 */
export const FACE_MATRIX = `matrix(${FACE_A / 200} ${(-FACE_B / 200).toFixed(4)} ${FACE_A / 200} ${(FACE_B / 200).toFixed(4)} 256 246)`;

/** The glow filter's id, referenced by the lit group. */
export const TRACE_GLOW_ID = "traceGlow";

const SIDES: readonly CircuitSide[] = [0, 1, 2, 3];

const pinOffsets = (spec: CircuitSpec): number[] =>
  Array.from({ length: spec.pinCount }, (_, i) => (i - (spec.pinCount - 1) / 2) * spec.pitch);

function sideTraces(spec: CircuitSpec, side: CircuitSide): Trace[] {
  const start = spec.chip + 6;
  const bendAt = spec.chip + 12;
  const ends = spec.endsBySide[side];
  const live = spec.liveSides[side] ?? [];
  return pinOffsets(spec).map((p, pin) => {
    // A trace must clear its bend before its pad, or it would double back on itself.
    const y1 = p * spec.fan;
    const x2 = bendAt + Math.abs(y1 - p);
    const end = Math.max(ends[pin % ends.length] ?? 100, x2 + 8);
    return {
      side,
      pin,
      live: live.includes(pin),
      d: `M${start} ${p}H${bendAt}L${fixed2(x2)} ${fixed2(y1)}H${end}`,
      end,
      y: fixed2(y1),
    };
  });
}

/** Lays out every trace of a circuit spec. */
export function circuit(spec: CircuitSpec): Circuit {
  return { spec, traces: SIDES.flatMap((side) => sideTraces(spec, side)) };
}

function bySide(traces: readonly Trace[], render: (trace: Trace) => string): string {
  return SIDES.map((side) => {
    const body = traces
      .filter((t) => t.side === side)
      .map(render)
      .join("");
    return body ? `<g transform="rotate(${side * 90})">${body}</g>` : "";
  }).join("");
}

const tracePath = (t: Trace): string => `<path d="${t.d}"/>`;
const hasPad = (t: Trace): boolean => t.end < 100;

/** The blur filter behind the live traces. */
export const GLOW_FILTER = `<filter id="${TRACE_GLOW_ID}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`;

/** Grey traces, their pads, and every pin mark, all in the mask's cut colour. */
export function greyCuts({ spec, traces }: Circuit): string {
  const grey = traces.filter((t) => !t.live);
  const pinMarks = SIDES.map(
    (side) =>
      `<g transform="rotate(${side * 90})">${pinOffsets(spec)
        .map((p) => `<path d="M${spec.chip} ${p}H${spec.chip + 6}"/>`)
        .join("")}</g>`,
  ).join("");
  return (
    `<g fill="none" stroke="${MASK_CUT}" stroke-width="${spec.w}" stroke-linecap="round" stroke-linejoin="round">${bySide(grey, tracePath)}</g>` +
    bySide(grey.filter(hasPad), (t) => `<circle cx="${t.end}" cy="${t.y}" r="${spec.w * 1.25}" fill="${MASK_CUT}"/>`) +
    `<g stroke="${MASK_CUT}" stroke-width="${spec.w * 0.9}" stroke-linecap="butt">${pinMarks}</g>`
  );
}

/** Live traces, their pads, and the chip: the painted part of the circuit. */
export function litGroup({ spec, traces }: Circuit): string {
  const live = traces.filter((t) => t.live);
  const paths = bySide(live, tracePath);
  const amber = paths
    ? `<g fill="none" stroke="${AMBER}" stroke-width="${spec.w * 1.25}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`
    : "";
  const glow = amber ? `<g filter="url(#${TRACE_GLOW_ID})" opacity="0.9">${amber}</g>` : "";
  const pads = bySide(live.filter(hasPad), (t) => `<circle cx="${t.end}" cy="${t.y}" r="${spec.w * 1.6}" fill="${AMBER_HIGHLIGHT}"/>`);
  const { chip } = spec;
  return (
    glow +
    amber +
    pads +
    `<rect x="${-chip}" y="${-chip}" width="${chip * 2}" height="${chip * 2}" rx="3" fill="${CHIP_FILL}" stroke="${AMBER}" stroke-width="1.6"/>` +
    `<circle cx="${chip - 8}" cy="${-chip + 8}" r="2.6" fill="${AMBER}"/>`
  );
}
