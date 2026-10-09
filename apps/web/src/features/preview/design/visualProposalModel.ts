/**
 * Owns pure visual-proposal fields, geometry and control-value transformations, separate from inspector rendering and color conversion.
 */
import type { CSSProperties } from "react";
import type { PreviewAnnotationVisualProposal } from "@mcode/contracts";
import type { PreviewDraftAnnotation } from "../state/previewAnnotationStore";

/** Names a field in an annotation visual proposal. */
export type VisualProposalKey = keyof PreviewAnnotationVisualProposal;

/** Limits color controls to the proposal fields that accept colors. */
export type ColorVisualProposalKey = Extract<
  VisualProposalKey,
  "textColor" | "background" | "borderColor"
>;

/** Identifies the visual-control pairs that can change together. */
export type VisualLinkPairId =
  | "size"
  | "padding:block"
  | "padding:inline"
  | "margin:block"
  | "margin:inline"
  | "border:block"
  | "border:inline"
  | "radius:top"
  | "radius:bottom";

/** Orders the standalone fields in the existing visual inspector. */
export const VISUAL_CONTROL_FIELDS = [
  ["textColor", "Text color"],
  ["background", "Background"],
  ["opacity", "Opacity"],
  ["font", "Font"],
  ["fontSize", "Font size"],
  ["fontWeight", "Font weight"],
  ["borderColor", "Border color"],
] as const satisfies readonly (readonly [VisualProposalKey, string])[];

const BOX_SIDE_ORDER = [
  ["top", "T"],
  ["bottom", "B"],
  ["left", "L"],
  ["right", "R"],
] as const;

type BoxSide = (typeof BOX_SIDE_ORDER)[number][0];

const RADIUS_CORNER_ORDER = [
  ["topLeft", "TL", "Top left"],
  ["topRight", "TR", "Top right"],
  ["bottomLeft", "BL", "Bottom left"],
  ["bottomRight", "BR", "Bottom right"],
] as const;

type RadiusCorner = (typeof RADIUS_CORNER_ORDER)[number][0];

/** Maps box-model groups to their shorthand and individual side fields. */
export const BOX_CONTROL_GROUPS = [
  {
    id: "padding",
    label: "Padding",
    shorthand: "padding",
    keys: {
      top: "paddingTop",
      bottom: "paddingBottom",
      left: "paddingLeft",
      right: "paddingRight",
    },
  },
  {
    id: "margin",
    label: "Margin",
    shorthand: "margin",
    keys: {
      top: "marginTop",
      bottom: "marginBottom",
      left: "marginLeft",
      right: "marginRight",
    },
  },
  {
    id: "border",
    label: "Border",
    shorthand: "borderWidth",
    keys: {
      top: "borderTopWidth",
      bottom: "borderBottomWidth",
      left: "borderLeftWidth",
      right: "borderRightWidth",
    },
  },
] as const satisfies readonly {
  readonly id: "padding" | "margin" | "border";
  readonly label: string;
  readonly shorthand: VisualProposalKey;
  readonly keys: Record<BoxSide, VisualProposalKey>;
}[];

type BoxControlGroup = (typeof BOX_CONTROL_GROUPS)[number];

/** Maps border-radius controls to their individual corner fields. */
export const RADIUS_CONTROL_GROUP = {
  id: "radius",
  label: "Radius",
  shorthand: "borderRadius",
  keys: {
    topLeft: "borderTopLeftRadius",
    topRight: "borderTopRightRadius",
    bottomLeft: "borderBottomLeftRadius",
    bottomRight: "borderBottomRightRadius",
  },
} as const satisfies {
  readonly id: "radius";
  readonly label: string;
  readonly shorthand: VisualProposalKey;
  readonly keys: Record<RadiusCorner, VisualProposalKey>;
};

type RadiusControlGroup = typeof RADIUS_CONTROL_GROUP;

/** Identifies the expandable box-model and radius control groups. */
export type ExpandableVisualGroupId = BoxControlGroup["id"] | RadiusControlGroup["id"];

/** Defines which proposal fields share a value while linked. */
export const VISUAL_LINK_PAIRS = [
  { id: "size", keys: ["width", "height"] },
  { id: "padding:block", keys: ["paddingTop", "paddingBottom"] },
  { id: "padding:inline", keys: ["paddingLeft", "paddingRight"] },
  { id: "margin:block", keys: ["marginTop", "marginBottom"] },
  { id: "margin:inline", keys: ["marginLeft", "marginRight"] },
  { id: "border:block", keys: ["borderTopWidth", "borderBottomWidth"] },
  { id: "border:inline", keys: ["borderLeftWidth", "borderRightWidth"] },
  { id: "radius:top", keys: ["borderTopLeftRadius", "borderTopRightRadius"] },
  {
    id: "radius:bottom",
    keys: ["borderBottomLeftRadius", "borderBottomRightRadius"],
  },
] as const satisfies readonly {
  readonly id: VisualLinkPairId;
  readonly keys: readonly [VisualProposalKey, VisualProposalKey];
}[];

const VISUAL_PROPOSAL_KEYS = [
  "textColor",
  "background",
  "opacity",
  "font",
  "fontSize",
  "fontWeight",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "borderColor",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const satisfies readonly VisualProposalKey[];

/** Supplies editable color defaults for user page content. */
export const COLOR_CONTROL_DEFAULTS: Partial<Record<VisualProposalKey, string>> = {
  // oxlint-disable-next-line mcode/no-raw-color -- Defaults edit user page colours, not the app's UI paint.
  textColor: "rgb(10, 52, 92)",
  // oxlint-disable-next-line mcode/no-raw-color -- A transparent user page background must retain its alpha.
  background: "rgba(0, 0, 0, 0)",
  // oxlint-disable-next-line mcode/no-raw-color -- This is the proposed border colour for user page content.
  borderColor: "rgb(10, 52, 92)",
};

const PIXEL_CONTROL_FIELDS = new Set<VisualProposalKey>([
  "fontSize",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
]);

/** Reports whether a proposal contains any nonempty field. */
export function hasVisualProposal(
  value: PreviewAnnotationVisualProposal | undefined,
): boolean {
  if (!value) return false;
  return Object.values(value).some((entry) =>
    typeof entry === "number"
      ? Number.isFinite(entry)
      : Boolean(String(entry ?? "").trim()),
  );
}

/** Removes empty fields and values equal to the captured element style. */
export function cleanVisualProposal(
  value: PreviewAnnotationVisualProposal,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): PreviewAnnotationVisualProposal | undefined {
  const next: Record<string, string | number> = {};
  for (const key of VISUAL_PROPOSAL_KEYS) {
    const normalized = normalizeVisualControlValue(key, value[key]);
    if (normalized === undefined) continue;
    const baselineValue = normalizeVisualControlValue(
      key,
      baselineVisualControlValue(key, baseline),
    );
    if (normalized === baselineValue) continue;
    next[key] = normalized;
  }
  return Object.keys(next).length > 0
    ? (next as PreviewAnnotationVisualProposal)
    : undefined;
}

function normalizeVisualControlValue(
  key: VisualProposalKey,
  value: unknown,
): string | number | undefined {
  if (key === "opacity") {
    if (String(value ?? "").trim() === "") return undefined;
    const numeric =
      typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : undefined;
  }
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function parseCssBoxValue(value: unknown): Record<BoxSide, string> | undefined {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const top = parts[0];
  const right = parts[1] ?? top;
  const bottom = parts[2] ?? top;
  const left = parts[3] ?? right;
  return { left, top, right, bottom };
}

function parseCssRadiusValue(
  value: unknown,
): Record<RadiusCorner, string> | undefined {
  const radiusText = String(value ?? "").split("/")[0]?.trim() ?? "";
  const parts = radiusText.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const topLeft = parts[0];
  const topRight = parts[1] ?? topLeft;
  const bottomRight = parts[2] ?? topLeft;
  const bottomLeft = parts[3] ?? topRight;
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function boxGroupForKey(
  key: VisualProposalKey,
): (typeof BOX_CONTROL_GROUPS)[number] | undefined {
  return BOX_CONTROL_GROUPS.find((group) =>
    BOX_SIDE_ORDER.some(([side]) => group.keys[side] === key),
  );
}

function radiusCornerForKey(key: VisualProposalKey): RadiusCorner | undefined {
  for (const [corner] of RADIUS_CORNER_ORDER) {
    if (RADIUS_CONTROL_GROUP.keys[corner] === key) return corner;
  }
  return undefined;
}

function boxSideForKey(key: VisualProposalKey): BoxSide | undefined {
  for (const [side] of BOX_SIDE_ORDER) {
    if (BOX_CONTROL_GROUPS.some((group) => group.keys[side] === key)) {
      return side;
    }
  }
  return undefined;
}

function baselineVisualControlValue(
  key: VisualProposalKey,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): unknown {
  if (!baseline) return undefined;
  const direct = baseline[key];
  if (direct !== undefined) return direct;
  const group = boxGroupForKey(key);
  const side = boxSideForKey(key);
  if (group && side) return parseCssBoxValue(baseline[group.shorthand])?.[side];
  const corner = radiusCornerForKey(key);
  if (!corner) return undefined;
  return parseCssRadiusValue(baseline[RADIUS_CONTROL_GROUP.shorthand])?.[corner];
}

function expandVisualShorthands(
  value: PreviewAnnotationVisualProposal | PreviewDraftAnnotation["elementStyle"] | undefined,
): PreviewAnnotationVisualProposal {
  const next: PreviewAnnotationVisualProposal = {};
  if (!value) return next;
  for (const group of BOX_CONTROL_GROUPS) {
    const parsed = parseCssBoxValue(value[group.shorthand]);
    if (!parsed) continue;
    for (const [side] of BOX_SIDE_ORDER) {
      const key = group.keys[side];
      if (value[key] === undefined) next[key] = parsed[side];
    }
  }
  const parsedRadius = parseCssRadiusValue(value[RADIUS_CONTROL_GROUP.shorthand]);
  if (parsedRadius) {
    for (const [corner] of RADIUS_CORNER_ORDER) {
      const key = RADIUS_CONTROL_GROUP.keys[corner];
      if (value[key] === undefined) next[key] = parsedRadius[corner];
    }
  }
  return next;
}

/** Combines captured element styles with an existing proposal for editing. */
export function initialVisualControls(
  elementStyle: PreviewDraftAnnotation["elementStyle"],
  proposedChanges: PreviewAnnotationVisualProposal | undefined,
): PreviewAnnotationVisualProposal {
  return {
    ...elementStyle,
    ...expandVisualShorthands(elementStyle),
    ...proposedChanges,
    ...expandVisualShorthands(proposedChanges),
  };
}

function parseCssPx(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const match = text.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Formats a proposal field for its inspector input. */
export function displayVisualControlValue(
  key: VisualProposalKey,
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (!PIXEL_CONTROL_FIELDS.has(key)) return text;
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  return match?.[1] ?? text;
}

/** Converts inspector input text to the existing proposal representation. */
export function encodeVisualControlValue(
  key: VisualProposalKey,
  rawValue: string,
): string | number {
  const trimmed = rawValue.trim();
  if (key === "opacity") return trimmed;
  if (!PIXEL_CONTROL_FIELDS.has(key) || !trimmed) return rawValue;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  return rawValue;
}

function proposalSideDeltaPx(
  value: PreviewAnnotationVisualProposal | undefined,
  baseline: PreviewDraftAnnotation["elementStyle"] | undefined,
  group: (typeof BOX_CONTROL_GROUPS)[number],
  side: BoxSide,
): number {
  if (!value) return 0;
  const key = group.keys[side];
  const direct = parseCssPx(value[key]);
  const shorthand = parseCssBoxValue(value[group.shorthand])?.[side];
  const next = direct ?? parseCssPx(shorthand);
  if (next === undefined) return 0;
  const baselineValue = parseCssPx(baselineVisualControlValue(key, baseline)) ?? 0;
  return next - baselineValue;
}

/** Applies proposed size and box-model changes to the captured bounds. */
export function visualProposalBounds(
  bounds: PreviewDraftAnnotation["bounds"],
  value: PreviewAnnotationVisualProposal | undefined,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): PreviewDraftAnnotation["bounds"] {
  if (!value) return bounds;
  const padding = BOX_CONTROL_GROUPS[0];
  const margin = BOX_CONTROL_GROUPS[1];
  const border = BOX_CONTROL_GROUPS[2];
  const leftGrow =
    proposalSideDeltaPx(value, baseline, margin, "left") +
    proposalSideDeltaPx(value, baseline, padding, "left") +
    proposalSideDeltaPx(value, baseline, border, "left");
  const topGrow =
    proposalSideDeltaPx(value, baseline, margin, "top") +
    proposalSideDeltaPx(value, baseline, padding, "top") +
    proposalSideDeltaPx(value, baseline, border, "top");
  const rightGrow =
    proposalSideDeltaPx(value, baseline, margin, "right") +
    proposalSideDeltaPx(value, baseline, padding, "right") +
    proposalSideDeltaPx(value, baseline, border, "right");
  const bottomGrow =
    proposalSideDeltaPx(value, baseline, margin, "bottom") +
    proposalSideDeltaPx(value, baseline, padding, "bottom") +
    proposalSideDeltaPx(value, baseline, border, "bottom");
  return {
    x: bounds.x - leftGrow,
    y: bounds.y - topGrow,
    width:
      Math.max(1, parseCssPx(value.width) ?? bounds.width) +
      leftGrow +
      rightGrow,
    height:
      Math.max(1, parseCssPx(value.height) ?? bounds.height) +
      topGrow +
      bottomGrow,
  };
}

/** Positions the proposal overlay using its adjusted element bounds. */
export function visualProposalGeometryStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  value: PreviewAnnotationVisualProposal | undefined,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): CSSProperties {
  const proposedBounds = visualProposalBounds(bounds, value, baseline);
  return {
    left: proposedBounds.x,
    top: proposedBounds.y,
    width: proposedBounds.width,
    height: proposedBounds.height,
  };
}

/** Translates proposed visual fields into overlay CSS properties. */
export function visualOverlayStyle(
  value: PreviewAnnotationVisualProposal | undefined,
): CSSProperties {
  if (!value) return {};
  const hasBorderWidth = BOX_SIDE_ORDER.some(([side]) =>
    Boolean(value[BOX_CONTROL_GROUPS[2].keys[side]]),
  );
  const normalizedOpacity = normalizeVisualControlValue("opacity", value.opacity);
  return {
    color: value.textColor,
    background: value.background,
    opacity:
      typeof normalizedOpacity === "number" ? normalizedOpacity : undefined,
    fontFamily: value.font,
    fontSize: value.fontSize,
    fontWeight: value.fontWeight,
    borderRadius: value.borderRadius,
    borderTopLeftRadius: value.borderTopLeftRadius,
    borderTopRightRadius: value.borderTopRightRadius,
    borderBottomRightRadius: value.borderBottomRightRadius,
    borderBottomLeftRadius: value.borderBottomLeftRadius,
    borderColor: value.borderColor,
    borderWidth: value.borderWidth,
    borderTopWidth: value.borderTopWidth,
    borderRightWidth: value.borderRightWidth,
    borderBottomWidth: value.borderBottomWidth,
    borderLeftWidth: value.borderLeftWidth,
    borderStyle: value.borderColor || value.borderWidth || hasBorderWidth
      ? "solid"
      : undefined,
    boxSizing: "border-box",
  };
}

/** Chooses the unit or format hint shown beside an inspector value. */
export function visualControlAffordance(
  key: VisualProposalKey,
): "swatch" | "px" | "0-1" | undefined {
  if (key in COLOR_CONTROL_DEFAULTS) return "swatch";
  if (key === "opacity") return "0-1";
  if (PIXEL_CONTROL_FIELDS.has(key)) return "px";
  return undefined;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Produces side controls in the existing box-model display order. */
export function boxGroupEntries(group: BoxControlGroup) {
  return BOX_SIDE_ORDER.map(([side, shortLabel]) => ({
    key: group.keys[side],
    ariaLabel: `${group.label} ${side}`,
    label: titleCase(side),
    shortLabel,
  }));
}

/** Produces corner controls in the existing radius display order. */
export function radiusGroupEntries(group: RadiusControlGroup) {
  return RADIUS_CORNER_ORDER.map(([corner, shortLabel, label]) => ({
    key: group.keys[corner],
    ariaLabel: `${group.label} ${label.toLowerCase()}`,
    label,
    shortLabel,
  }));
}

/** Selects the linked field pairs belonging to an inspector group. */
export function groupLinkPairs(
  groupId: ExpandableVisualGroupId,
): readonly { readonly id: VisualLinkPairId; readonly label: string }[] {
  if (groupId === "radius") {
    return [
      { id: "radius:top", label: "Link top radius corners" },
      { id: "radius:bottom", label: "Link bottom radius corners" },
    ];
  }
  return [
    { id: `${groupId}:block` as VisualLinkPairId, label: `Link ${groupId} top and bottom` },
    { id: `${groupId}:inline` as VisualLinkPairId, label: `Link ${groupId} left and right` },
  ];
}
