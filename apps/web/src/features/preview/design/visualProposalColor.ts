/**
 * Owns color parsing, conversion and formatting for the visual proposal inspector so color math stays independent of its controls.
 */
import { type VisualProposalKey, COLOR_CONTROL_DEFAULTS } from "./visualProposalModel";

/** Represents color channels and alpha during inspector conversions. */
export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

/** Clamps and rounds a color channel to its byte range. */
export function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Clamps an alpha or normalized color component to the unit interval. */
export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function componentToHex(value: number): string {
  return clampColorChannel(value).toString(16).padStart(2, "0").toUpperCase();
}

/** Formats RGB channels as a hexadecimal color. */
export function colorToHex(color: RgbaColor): string {
  return `#${componentToHex(color.r)}${componentToHex(color.g)}${componentToHex(color.b)}`;
}

/** Converts RGB channels to hue, saturation and lightness. */
export function rgbToHsl(color: RgbaColor): { h: number; s: number; l: number } {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  if (max === g) h = (b - r) / delta + 2;
  if (max === b) h = (r - g) / delta + 4;
  return { h: h * 60, s, l };
}

/** Converts RGB channels to the inspector hue, saturation and value coordinates. */
export function rgbToHsv(color: RgbaColor): { h: number; s: number; v: number } {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    if (max === g) h = (b - r) / delta + 2;
    if (max === b) h = (r - g) / delta + 4;
    h *= 60;
  }
  return {
    h: h < 0 ? h + 360 : h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

/** Converts hue, saturation and value coordinates to RGB channels. */
export function hsvToRgb(h: number, s: number, v: number, a?: number): RgbaColor {
  const hue = ((h % 360) + 360) % 360;
  const sat = clampUnit(s);
  const value = clampUnit(v);
  const chroma = value * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - chroma;
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return {
    r: clampColorChannel((r + m) * 255),
    g: clampColorChannel((g + m) * 255),
    b: clampColorChannel((b + m) * 255),
    ...(a !== undefined ? { a } : {}),
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

/** Converts hue, saturation and lightness to RGB channels. */
export function hslToRgb(h: number, s: number, l: number, a?: number): RgbaColor {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clampUnit(s);
  const light = clampUnit(l);
  if (sat === 0) {
    const gray = clampColorChannel(light * 255);
    return { r: gray, g: gray, b: gray, ...(a !== undefined ? { a } : {}) };
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  return {
    r: clampColorChannel(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: clampColorChannel(hueToRgb(p, q, hue) * 255),
    b: clampColorChannel(hueToRgb(p, q, hue - 1 / 3) * 255),
    ...(a !== undefined ? { a } : {}),
  };
}

/** Parses the color formats supported by the existing proposal editor. */
export function parseColorValue(value: unknown): RgbaColor | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const hex = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1]!;
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((part) => part + part)
            .join("")
        : raw;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = text.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgb) {
    return {
      r: clampColorChannel(Number(rgb[1])),
      g: clampColorChannel(Number(rgb[2])),
      b: clampColorChannel(Number(rgb[3])),
      ...(rgb[4] !== undefined ? { a: clampUnit(Number(rgb[4])) } : {}),
    };
  }
  const hsl = text.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (hsl) {
    return hslToRgb(
      Number(hsl[1]),
      Number(hsl[2]) / 100,
      Number(hsl[3]) / 100,
      hsl[4] !== undefined ? clampUnit(Number(hsl[4])) : undefined,
    );
  }
  return undefined;
}

/** Chooses the inspector format corresponding to a color value. */
export function detectColorFormat(value: unknown): ColorFormat {
  const text = String(value ?? "").trim();
  if (/^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(text)) return "hex";
  if (/^hsla?\(/i.test(text)) return "hsl";
  return "rgb";
}

/** Serializes a color in the selected inspector format. */
export function formatColorValue(color: RgbaColor, format: ColorFormat): string {
  const alpha = color.a !== undefined && color.a < 1 ? clampUnit(color.a) : undefined;
  if (format === "hex") return colorToHex(color);
  if (format === "hsl") {
    const hsl = rgbToHsl(color);
    const base = `${Math.round(hsl.h)}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%`;
    // oxlint-disable-next-line mcode/no-raw-color -- Preserve the CSS format of a user-selected colour.
    return alpha !== undefined ? `hsla(${base}, ${alpha})` : `hsl(${base})`;
  }
  const base = `${clampColorChannel(color.r)}, ${clampColorChannel(color.g)}, ${clampColorChannel(color.b)}`;
  // oxlint-disable-next-line mcode/no-raw-color -- Preserve the CSS format of a user-selected colour.
  return alpha !== undefined ? `rgba(${base}, ${alpha})` : `rgb(${base})`;
}

/** Formats a numeric color component with the existing precision. */
export function formatColorNumber(value: number): string {
  return String(Math.round(value));
}

/** Selects the editable portion of the formatted color input. */
export function colorEditableSelectionRange(
  value: string,
): readonly [number, number] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return [1, trimmed.length];
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open >= 0 && close > open) return [open + 1, close];
  return undefined;
}

/** Resolves the color used by a proposal field swatch. */
export function colorSwatchValue(
  key: VisualProposalKey,
  value: unknown,
): string | undefined {
  if (!(key in COLOR_CONTROL_DEFAULTS)) return undefined;
  const parsed = parseColorValue(value);
  if (parsed) return formatColorValue(parsed, "rgb");
  return COLOR_CONTROL_DEFAULTS[key];
}

/** Names the color formats offered by the proposal inspector. */
export type ColorFormat = "rgb" | "hsl" | "hex";
