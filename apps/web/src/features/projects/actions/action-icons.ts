import {
  Bug,
  BookOpen,
  Container,
  Database,
  FileCodeCorner,
  FlaskConical,
  Gauge,
  GitBranch,
  Globe,
  Hammer,
  Hexagon,
  KeyRound,
  Package,
  Play,
  RefreshCw,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";

interface ToolIconEntry {
  readonly kind: "tool";
  readonly label: string;
  /** Material Icon Theme icon name, without the `.svg` extension. */
  readonly materialIcon: string;
  readonly fallback: LucideIcon;
  readonly tint: string;
}

interface GlyphIconEntry {
  readonly kind: "glyph";
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tint: string;
}

/** How one icon id is drawn: a tool mark fetched from Material Icon Theme, or a tinted Lucide glyph. */
export type ActionIconEntry = ToolIconEntry | GlyphIconEntry;

/**
 * Every icon an action can carry, keyed by the id stored in the environment document.
 * Ids are stored, never SVG, so a build that does not know an id falls back to the derived default.
 */
export const ACTION_ICONS = {
  bun: { kind: "tool", label: "Bun", materialIcon: "bun", fallback: Package, tint: "text-amber-200" },
  npm: { kind: "tool", label: "npm", materialIcon: "npm", fallback: Package, tint: "text-rose-300" },
  pnpm: { kind: "tool", label: "pnpm", materialIcon: "pnpm", fallback: Package, tint: "text-amber-300" },
  node: { kind: "tool", label: "Node.js", materialIcon: "nodejs", fallback: Hexagon, tint: "text-emerald-300" },
  docker: { kind: "tool", label: "Docker", materialIcon: "docker", fallback: Container, tint: "text-sky-400" },
  vite: { kind: "tool", label: "Vite", materialIcon: "vite", fallback: Zap, tint: "text-violet-300" },
  vitest: { kind: "tool", label: "Vitest", materialIcon: "vitest", fallback: FlaskConical, tint: "text-emerald-300" },
  jest: { kind: "tool", label: "Jest", materialIcon: "jest", fallback: FlaskConical, tint: "text-rose-300" },
  playwright: { kind: "tool", label: "Playwright", materialIcon: "playwright", fallback: FlaskConical, tint: "text-emerald-300" },
  storybook: { kind: "tool", label: "Storybook", materialIcon: "storybook", fallback: BookOpen, tint: "text-pink-300" },
  eslint: { kind: "tool", label: "ESLint", materialIcon: "eslint", fallback: ShieldCheck, tint: "text-indigo-300" },
  biome: { kind: "tool", label: "Biome", materialIcon: "biome", fallback: ShieldCheck, tint: "text-sky-400" },
  prettier: { kind: "tool", label: "Prettier", materialIcon: "prettier", fallback: Sparkles, tint: "text-sky-300" },
  typescript: { kind: "tool", label: "TypeScript", materialIcon: "typescript", fallback: FileCodeCorner, tint: "text-sky-400" },
  turbo: { kind: "tool", label: "Turborepo", materialIcon: "turborepo", fallback: Gauge, tint: "text-rose-300" },
  prisma: { kind: "tool", label: "Prisma", materialIcon: "prisma", fallback: Database, tint: "text-zinc-400" },
  pgsql: { kind: "tool", label: "PostgreSQL", materialIcon: "database", fallback: Database, tint: "text-sky-300" },
  git: { kind: "tool", label: "Git", materialIcon: "git", fallback: GitBranch, tint: "text-orange-400" },
  makefile: { kind: "tool", label: "Make", materialIcon: "makefile", fallback: Hammer, tint: "text-zinc-400" },
  shell: { kind: "tool", label: "Shell", materialIcon: "console", fallback: Terminal, tint: "text-zinc-400" },
  powershell: { kind: "tool", label: "PowerShell", materialIcon: "powershell", fallback: Terminal, tint: "text-sky-300" },
  python: { kind: "tool", label: "Python", materialIcon: "python", fallback: FileCodeCorner, tint: "text-amber-300" },
  rust: { kind: "tool", label: "Rust", materialIcon: "rust", fallback: Hexagon, tint: "text-orange-300" },
  go: { kind: "tool", label: "Go", materialIcon: "go", fallback: FileCodeCorner, tint: "text-cyan-300" },

  play: { kind: "glyph", label: "Play", icon: Play, tint: "text-zinc-400" },
  hammer: { kind: "glyph", label: "Hammer", icon: Hammer, tint: "text-orange-300" },
  flask: { kind: "glyph", label: "Flask", icon: FlaskConical, tint: "text-emerald-300" },
  sliders: { kind: "glyph", label: "Sliders", icon: SlidersHorizontal, tint: "text-amber-300" },
  rocket: { kind: "glyph", label: "Rocket", icon: Rocket, tint: "text-violet-300" },
  globe: { kind: "glyph", label: "Globe", icon: Globe, tint: "text-sky-400" },
  database: { kind: "glyph", label: "Database", icon: Database, tint: "text-sky-300" },
  bug: { kind: "glyph", label: "Bug", icon: Bug, tint: "text-rose-300" },
  refresh: { kind: "glyph", label: "Refresh", icon: RefreshCw, tint: "text-emerald-300" },
  zap: { kind: "glyph", label: "Zap", icon: Zap, tint: "text-amber-300" },
  key: { kind: "glyph", label: "Key", icon: KeyRound, tint: "text-amber-200" },
  trash: { kind: "glyph", label: "Trash", icon: Trash2, tint: "text-rose-300" },
} as const satisfies Record<string, ActionIconEntry>;

/** An icon id this build can draw. Stored ids are plain strings, so narrow with {@link isActionIconId}. */
export type ActionIconId = keyof typeof ACTION_ICONS;

/** Ids in picker order: tools first, then general glyphs. */
export const ACTION_ICON_IDS = Object.keys(ACTION_ICONS) as readonly ActionIconId[];

/** Whether this build can draw `id`. A newer build's id, or a hand-edited one, fails. */
export function isActionIconId(id: string | undefined): id is ActionIconId {
  return id !== undefined && Object.prototype.hasOwnProperty.call(ACTION_ICONS, id);
}

const COMMAND_ICON: ReadonlyMap<string, ActionIconId> = new Map(Object.entries({
  bun: "bun",
  npm: "npm",
  pnpm: "pnpm",
  node: "node",
  nodejs: "node",
  docker: "docker",
  "docker-compose": "docker",
  make: "makefile",
  python: "python",
  python3: "python",
  py: "python",
  cargo: "rust",
  go: "go",
  pwsh: "powershell",
  powershell: "powershell",
  vite: "vite",
  vitest: "vitest",
  jest: "jest",
  playwright: "playwright",
  storybook: "storybook",
  eslint: "eslint",
  biome: "biome",
  prettier: "prettier",
  tsc: "typescript",
  turbo: "turbo",
  prisma: "prisma",
  git: "git",
} satisfies Record<string, ActionIconId>));

const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);

const ENV_ASSIGNMENTS =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|\\.|[^\s"'\\])*\s+)*/;

const WORD = /"[^"]*"|'[^']*'|\S+/g;

function firstCommandLine(command: string): string {
  for (const line of command.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}

function programName(word: string): string {
  const unquoted = word.replace(/^(["'])(.*)\1$/, "$2");
  const base = unquoted.slice(Math.max(unquoted.lastIndexOf("/"), unquoted.lastIndexOf("\\")) + 1);
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * The icon an action shows when its document names none: its command's first word, ignoring
 * leading `FOO=1` assignments and `npx`/`bunx` prefixes. Unknown commands, including scripts such
 * as `./run.sh`, get the play glyph.
 */
export function defaultActionIconId(command: string): ActionIconId {
  const words = firstCommandLine(command).replace(ENV_ASSIGNMENTS, "").match(WORD) ?? [];
  const runner = programName(words[0] ?? "");
  const word = PACKAGE_RUNNERS.has(runner) ? programName(words[1] ?? "") : runner;
  return COMMAND_ICON.get(word) ?? "play";
}

/** The id to draw: the stored one when this build knows it, otherwise the command's default. */
export function resolveActionIconId(storedId: string | undefined, command: string): ActionIconId {
  return isActionIconId(storedId) ? storedId : defaultActionIconId(command);
}

const SHELL_ICON: ReadonlyMap<string, ActionIconId> = new Map(Object.entries({
  pwsh: "powershell",
  powershell: "powershell",
  bash: "shell",
  zsh: "shell",
  sh: "shell",
  fish: "shell",
  cmd: "shell",
  wsl: "shell",
} satisfies Record<string, ActionIconId>));

/** The icon for a shell terminal, from its program name or path. Unknown shells get the generic shell mark. */
export function shellActionIconId(shell: string): ActionIconId {
  return SHELL_ICON.get(programName(shell)) ?? "shell";
}
