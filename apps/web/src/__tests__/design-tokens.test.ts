import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { READING_RAIL_WIDTH } from "@/lib/composer-layout";
import paperExport from "../design-tokens.paper.json";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// oxlint-disable-next-line mcode/no-source-text-test -- index.css token values are the data checked against the Paper export.
const indexCss = NodeFS.readFileSync(NodePath.resolve(here, "../index.css"), "utf8");

/** html sets `font-size: 62.5%`, so 1rem is 10px. */
const PX_PER_REM = 10;

/**
 * Paper role name to the matching code variables. Dark values come from
 * `--color-<role>`, light values from `--color-light-<role>`.
 */
const ROLE_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  page: ["--page"],
  background: ["--background"],
  panel: ["--panel"],
  hover: ["--hover"],
  selected: ["--selected", "--button-secondary"],
  border: ["--border"],
  "control-border": ["--control-border"],
  ink: ["--ink"],
  muted: ["--muted"],
  primary: ["--primary"],
  "primary-hover": ["--primary-hover"],
  "primary-ink": ["--primary-ink"],
  destructive: ["--destructive"],
  "destructive-ink": ["--destructive-ink"],
  "button-secondary-hover": ["--button-secondary-hover"],
  "button-destructive-hover": ["--button-destructive-hover"],
  focus: ["--focus"],
  link: ["--link"],
  success: ["--success"],
  error: ["--error"],
  warning: ["--warning"],
  info: ["--info"],
  "pr-merged": ["--pr-merged"],
  "diff-add-bg": ["--diff-add-bg"],
  "diff-remove-bg": ["--diff-remove-bg"],
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
const paper = (name: string) => resolveVars(`var(${name})`, paperTokens);

const rootScope = blockDeclarations(":root");
const themes = {
  light: rootScope,
  dark: new Map([...rootScope, ...blockDeclarations(".dark")]),
};
const theme = blockDeclarations("@theme inline");
const code = (scope: ReadonlyMap<string, string>, name: string) => resolveVars(`var(${name})`, scope);
type Theme = keyof typeof themes;
const paperRole = (theme: Theme, role: string) => paper(theme === "light" ? `--color-light-${role}` : `--color-${role}`);

/**
 * Variables that depart from their Paper role by a recorded decision, mapped to the
 * value they resolve to instead. index.css gives each one its reason.
 */
const DEVIATIONS: Readonly<Record<Theme, Readonly<Record<string, string>>>> = {
  light: {
    // decisions.md D4: Paper's light selected equals page and hover, so a selected row
    // vanished. Only selection moves; the secondary button (--button-secondary) keeps Paper's pair.
    "--selected": paper("--color-neutral-200"),
    // Paper's neutral-400 reads 4.45:1 on the selected fill the composer uses.
    "--muted": "oklch(47% 0.010 260)",
    // Paper's amber warning shares the run lamp's hue, so warnings read as more Sends.
    "--warning": "oklch(46% 0.100 92)",
  },
  dark: {
    "--warning": "oklch(82% 0.110 92)",
  },
};

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
      for (const name of ["dark", "light"] as const) {
        expect(code(themes[name], variable), `${name} ${variable}`).toBe(
          DEVIATIONS[name][variable] ?? paperRole(name, role),
        );
      }
    }
  });

  it("keeps each decided deviation different from Paper", () => {
    for (const name of ["dark", "light"] as const) {
      for (const [variable, value] of Object.entries(DEVIATIONS[name])) {
        const role = Object.keys(ROLE_VARIABLES).find((key) => ROLE_VARIABLES[key]!.includes(variable))!;
        expect(paperRole(name, role), `Paper now matches ${name} ${variable}; drop the deviation`).not.toBe(value);
      }
    }
  });

  it("keeps the light secondary button distinct from its hover", () => {
    expect(code(themes.light, "--button-secondary")).not.toBe(code(themes.light, "--button-secondary-hover"));
  });

  it.each(TYPE_ROLES)("gives the %s type role Paper's size, line height and weight", (role) => {
    expect(toPx(theme.get(`--text-${role}`)!)).toBe(toPx(paper(`--text-${role}`)));
    expect(toPx(theme.get(`--text-${role}--line-height`)!)).toBe(toPx(paper(`--leading-${role}`)));
    expect(theme.get(`--text-${role}--font-weight`)).toBe(paper(`--weight-${role}`));
  });

  it("gives the type-link utility Paper's link size, line height and weight", () => {
    const body = /^@utility type-link \{\r?\n([\s\S]*?)^\}/m.exec(indexCss)?.[1] ?? "";
    const declarations = new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
    expect(toPx(declarations.get("font-size")!)).toBe(toPx(paper("--text-link")));
    expect(toPx(declarations.get("line-height")!)).toBe(toPx(paper("--leading-link")));
    expect(declarations.get("font-weight")).toBe(paper("--weight-link"));
  });

  it("uses Paper's body and body-small line heights for text-base and text-sm", () => {
    expect([toPx(theme.get("--text-sm")!), toPx(theme.get("--text-sm--line-height")!)]).toEqual([
      toPx(paper("--text-body-small")),
      toPx(paper("--leading-body-small")),
    ]);
    expect([toPx(theme.get("--text-base")!), toPx(theme.get("--text-base--line-height")!)]).toEqual([
      toPx(paper("--text-body")),
      toPx(paper("--leading-body")),
    ]);
  });

  it("matches Paper's radius, spacing, size and layout tokens", () => {
    for (const role of RADIUS_ROLES) {
      expect(toPx(theme.get(`--radius-${role}`)!), role).toBe(toPx(paper(`--radius-${role}`)));
    }
    for (const size of SIZE_TOKENS) {
      expect(toPx(theme.get(`--spacing-${size}`)!), size).toBe(toPx(paper(`--size-${size}`)));
    }
    for (const spacing of ["compact-row", "group", "task-stage", "workspace", "text-fade"]) {
      expect(toPx(theme.get(`--spacing-${spacing}`)!), spacing).toBe(toPx(paper(`--spacing-${spacing}`)));
    }
    for (const container of ["sidebar", "right-rail", "right-rail-expanded"]) {
      expect(toPx(theme.get(`--container-${container}`)!), container).toBe(toPx(paper(`--container-${container}`)));
    }
  });

  it("gives the docked Overview's reserve the reading rail's width", () => {
    expect(toPx(theme.get("--container-reading")!)).toBe(READING_RAIL_WIDTH);
  });

  it("leads both font stacks with Paper's families", () => {
    expect(theme.get("--font-sans")).toMatch(/^"Public Sans Variable", "Public Sans",/);
    expect(theme.get("--font-mono")).toMatch(/^"JetBrains Mono Variable", "JetBrains Mono",/);
  });
});
