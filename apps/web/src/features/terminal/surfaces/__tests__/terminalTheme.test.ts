import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { TERMINAL_THEME_TOKENS, type TerminalThemeSlot } from "../terminalTheme";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// oxlint-disable-next-line mcode/no-source-text-test -- index.css holds the token values the app ships; jsdom cannot resolve them.
const indexCss = NodeFS.readFileSync(NodePath.resolve(here, "../../../../index.css"), "utf8");

/** Declarations of every top-level block whose selector is `selector`, later blocks winning. */
function declarations(selector: string): Map<string, string> {
  const result = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const block of indexCss.matchAll(new RegExp(`^${escaped} \\{([^}]*)\\}`, "gm"))) {
    for (const decl of (block[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      result.set(decl[1] ?? "", (decl[2] ?? "").trim());
    }
  }
  return result;
}

const rootTokens = declarations(":root");
const themeTokens = { light: rootTokens, dark: new Map([...rootTokens, ...declarations(".dark")]) };

function resolveToken(theme: Map<string, string>, token: string): string {
  const value = theme.get(token);
  if (!value) throw new Error(`${token} is not defined in index.css`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference?.[1] ? resolveToken(theme, reference[1]) : value;
}

/** WCAG relative luminance of an `oklch(L% C H)` value, via OKLab to sRGB. */
function luminance(oklch: string): number {
  const match = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/.exec(oklch);
  if (!match) throw new Error(`Unsupported colour ${oklch}`);
  const [lightness, chroma, hue] = [Number(match[1]) / 100, Number(match[2]), (Number(match[3]) * Math.PI) / 180];
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  // These are linear-light channels already, which is what WCAG luminance weights.
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const SURFACE_SLOTS = new Set<TerminalThemeSlot>(["background"]);

describe("terminal theme contrast", () => {
  for (const themeName of ["light", "dark"] as const) {
    const tokens = TERMINAL_THEME_TOKENS[themeName];
    const page = resolveToken(themeTokens[themeName], tokens.background);
    const foregrounds = (Object.keys(tokens) as TerminalThemeSlot[]).filter((slot) => !SURFACE_SLOTS.has(slot));

    it.each(foregrounds)(`${themeName} %s reads at 4.5:1 on the terminal background`, (slot) => {
      const color = resolveToken(themeTokens[themeName], tokens[slot]);
      expect(contrast(color, page)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
