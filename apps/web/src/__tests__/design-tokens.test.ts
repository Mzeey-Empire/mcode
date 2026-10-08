import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import paperExport from "../design-tokens.paper.json";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const indexCss = NodeFS.readFileSync(NodePath.resolve(here, "../index.css"), "utf8");

/** html sets `font-size: 62.5%`, so 1rem is 10px. */
const PX_PER_REM = 10;

/**
 * Paper role name to the code variables that carry it until F-01b renames them
 * to Paper's names. Dark values come from `--color-<role>`, light values from
 * `--color-light-<role>`.
 */
const ROLE_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  page: ["--page"],
  background: ["--background"],
  panel: ["--card", "--popover"],
  hover: ["--muted"],
  selected: ["--secondary", "--accent"],
  border: ["--border"],
  "control-border": ["--control-border"],
  ink: ["--foreground", "--card-foreground", "--popover-foreground", "--secondary-foreground", "--accent-foreground"],
  muted: ["--muted-foreground"],
  primary: ["--primary"],
  "primary-hover": ["--primary-hover"],
  "primary-ink": ["--primary-foreground"],
  destructive: ["--destructive"],
  "destructive-ink": ["--destructive-ink"],
  "button-secondary-hover": ["--button-secondary-hover"],
  "button-destructive-hover": ["--button-destructive-hover"],
  focus: ["--ring"],
  link: ["--link"],
  success: ["--success"],
  error: ["--error"],
  warning: ["--warning"],
  info: ["--info"],
  "pr-merged": ["--pr-merged"],
  "diff-add-bg": ["--diff-add-bg"],
  "diff-remove-bg": ["--diff-remove-bg"],
};

/** Departures from the Paper export that the user's decisions record, keyed by Paper token. */
const DECIDED_DEVIATIONS: Readonly<Record<string, string>> = {
  // decisions.md D4: Paper's light selected equals page and hover, so selection vanished.
  "--color-light-selected": "var(--color-neutral-200)",
};

const TYPE_ROLES = ["body", "prose", "body-small", "caption", "label", "button", "code"] as const;
const RADIUS_ROLES = ["badge", "menu", "control", "composer", "dialog"] as const;
const SIZE_TOKENS = [
  "control-compact",
  "control-default",
  "control-comfortable",
  "row-compact",
  "row-default",
  "row-comfortable",
  "target-touch",
  "icon-metadata",
  "icon-compact",
  "icon-standard",
  "icon-large",
  "icon-display",
] as const;
const RAMPS = ["neutral", "amber", "blue", "sage", "clay", "violet"] as const;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Merges the custom properties of every top-level block whose selector is exactly `selector`. */
function blockDeclarations(selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`^${escaped} \\{\\r?\\n([\\s\\S]*?)^\\}`, "gm");
  for (const block of stripComments(indexCss).matchAll(blockPattern)) {
    for (const [, name, value] of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(name!, value!.trim());
    }
  }
  return declarations;
}

function resolveVars(value: string, scope: ReadonlyMap<string, string>, seen: readonly string[] = []): string {
  return value
    .replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const next = scope.get(name);
      if (next === undefined) throw new Error(`${name} is not defined`);
      if (seen.includes(name)) throw new Error(`${name} refers to itself`);
      return resolveVars(next, scope, [...seen, name]);
    })
    .replace(/\s+/g, " ");
}

function toPx(length: string): number {
  return Number.parseFloat(length) * (length.endsWith("rem") ? PX_PER_REM : 1);
}

const paperTokens = new Map(Object.entries(paperExport.tokens));
const decidedPaper = new Map([...paperTokens, ...Object.entries(DECIDED_DEVIATIONS)]);
const paper = (name: string) => resolveVars(`var(${name})`, decidedPaper);

const rootScope = blockDeclarations(":root");
const themes = {
  light: rootScope,
  dark: new Map([...rootScope, ...blockDeclarations(".dark")]),
};
const theme = blockDeclarations("@theme inline");
const code = (scope: ReadonlyMap<string, string>, name: string) => resolveVars(`var(${name})`, scope);

describe("design tokens match the Paper export", () => {
  it("maps every Paper colour role", () => {
    const paperRoles = [...paperTokens.keys()]
      .map((name) => /^--color-light-(.+)$/.exec(name)?.[1])
      .filter((role): role is string => role !== undefined);
    expect(paperRoles.sort()).toEqual(Object.keys(ROLE_VARIABLES).sort());
  });

  it("copies every ramp step", () => {
    for (const ramp of RAMPS) {
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(code(rootScope, `--${ramp}-${step}`), `${ramp}-${step}`).toBe(paper(`--color-${ramp}-${step}`));
      }
    }
  });

  it.each(Object.entries(ROLE_VARIABLES))("resolves %s to Paper's value in both themes", (role, variables) => {
    for (const variable of variables) {
      expect(code(themes.dark, variable), `dark ${variable}`).toBe(paper(`--color-${role}`));
      expect(code(themes.light, variable), `light ${variable}`).toBe(paper(`--color-light-${role}`));
    }
  });

  it("keeps each decided deviation different from Paper", () => {
    for (const [name, value] of Object.entries(DECIDED_DEVIATIONS)) {
      expect(paperTokens.get(name), `${name} now matches the decision; drop the deviation`).not.toBe(value);
    }
  });

  it("pairs the primary label and focus ring as the style guide requires", () => {
    expect(code(themes.dark, "--primary")).toBe("oklch(72% 0.170 75)");
    expect(code(themes.dark, "--primary-foreground")).toBe("oklch(16% 0.005 260)");
    expect(code(themes.light, "--ring")).toBe("oklch(52% 0.170 264)");
  });

  it.each(TYPE_ROLES)("gives the %s type role Paper's size, line height and weight", (role) => {
    expect(toPx(theme.get(`--text-${role}`)!)).toBe(toPx(paper(`--text-${role}`)));
    expect(toPx(theme.get(`--text-${role}--line-height`)!)).toBe(toPx(paper(`--leading-${role}`)));
    expect(theme.get(`--text-${role}--font-weight`)).toBe(paper(`--weight-${role}`));
  });

  it("uses Paper's body and body-small line heights for text-base and text-sm", () => {
    expect([toPx(theme.get("--text-sm")!), toPx(theme.get("--text-sm--line-height")!)]).toEqual([14, 20]);
    expect([toPx(theme.get("--text-base")!), toPx(theme.get("--text-base--line-height")!)]).toEqual([16, 24]);
  });

  it("matches Paper's radius, spacing, size and layout tokens", () => {
    for (const role of RADIUS_ROLES) {
      expect(toPx(theme.get(`--radius-${role}`)!), role).toBe(toPx(paper(`--radius-${role}`)));
    }
    for (const size of SIZE_TOKENS) {
      expect(toPx(theme.get(`--spacing-${size}`)!), size).toBe(toPx(paper(`--size-${size}`)));
    }
    expect(toPx(theme.get("--spacing-text-fade")!)).toBe(toPx(paper("--spacing-text-fade")));
    for (const container of ["sidebar", "right-rail", "right-rail-expanded"]) {
      expect(toPx(theme.get(`--container-${container}`)!), container).toBe(toPx(paper(`--container-${container}`)));
    }
  });

  it("leads both font stacks with Paper's families", () => {
    expect(theme.get("--font-sans")).toMatch(/^"Public Sans Variable", "Public Sans",/);
    expect(theme.get("--font-mono")).toMatch(/^"JetBrains Mono Variable", "JetBrains Mono",/);
  });
});
