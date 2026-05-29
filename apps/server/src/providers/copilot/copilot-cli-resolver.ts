import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** Which discovery strategy produced a resolution (for diagnostics + banner copy). */
export type CopilotCliSource = "configured" | "npm-global" | "path-shim";

/** A successful resolution: an absolute, spawnable entry plus the detected version. */
export interface CopilotCliFound {
  source: CopilotCliSource;
  /** Absolute path passed to the SDK as `cliPath` (the CLI's index.js, or the configured path). */
  entry: string;
  /** Detected version (e.g. "1.0.24"), or null when it could not be read. */
  version: string | null;
}

/** No strategy resolved; carries a user-facing install message. */
export interface CopilotCliNotFound {
  source: "not-found";
  entry: null;
  version: null;
  message: string;
}

/** The outcome of resolving the Copilot CLI: a found entry or a not-found message. */
export type CopilotCliResolution = CopilotCliFound | CopilotCliNotFound;

/** Filesystem/process access behind one seam so the resolver is testable without spawning. */
export interface ResolverIO {
  /** True when a path exists on disk. */
  exists(p: string): boolean;
  /** UTF-8 file contents, or null when unreadable. */
  readFile(p: string): string | null;
  /** Run a command; trimmed stdout, or null on spawn error / non-zero exit. */
  exec(command: string, args: string[]): string | null;
  /** Host platform; selects the win32 vs posix PATH branch. */
  platform: NodeJS.Platform;
}

/** Inputs the resolver needs from the caller. */
export interface ResolveContext {
  /** The user-configured CLI path (`settings.provider.cli.copilot`), if any. */
  configuredPath?: string;
}

interface Strategy {
  source: CopilotCliSource;
  resolve(ctx: ResolveContext, io: ResolverIO): { entry: string; version: string | null } | null;
}

/** Semver triplet matcher (matches "1.0.24" in "GitHub Copilot CLI 1.0.24."). */
const VERSION_RE = /\b(\d+\.\d+\.\d+)(?!\.\d)/;

/** Extracts a semver triplet from `<entry> --version` output, or null. */
function parseVersion(out: string): string | null {
  const m = out.match(VERSION_RE);
  return m ? m[1]! : null;
}

/**
 * 1. User-configured path. Highest priority, never overridden, trusted verbatim
 *    (the SDK's own existsSync gate validates it). The --version probe only
 *    supplies the version for display.
 */
const configuredStrategy: Strategy = {
  source: "configured",
  resolve(ctx, io) {
    const p = ctx.configuredPath?.trim();
    if (!p) return null;
    const out = io.exec(p, ["--version"]);
    return { entry: p, version: out ? parseVersion(out) : null };
  },
};

/** Strategy table, tried in priority order. Append a row to add a future route. */
const STRATEGIES: Strategy[] = [configuredStrategy];

/** Builds the not-found resolution, disambiguating `@github/copilot` from `gh copilot`. */
function notFound(io: ResolverIO): CopilotCliNotFound {
  const ghExts = io.exec("gh", ["extension", "list"]);
  const hasGhCopilot = ghExts != null && /copilot/i.test(ghExts);
  const base =
    "GitHub Copilot CLI not found. Install it with: npm install -g @github/copilot\n\n" +
    "Or set a custom path in Settings > Provider > Copilot CLI path.";
  const disambig = hasGhCopilot
    ? "\n\nNote: the `gh copilot` GitHub CLI extension is installed, which is different " +
      "from the `@github/copilot` npm package Mcode needs."
    : "";
  return { source: "not-found", entry: null, version: null, message: base + disambig };
}

/**
 * Resolves the Copilot CLI by trying each strategy in priority order and using
 * the first that yields an existing entry. Returns a not-found resolution with
 * an install message when none succeed. Reports a raw version only; min-version
 * policy is intentionally not handled here (see ADR-0001).
 */
export function resolveCopilotCli(ctx: ResolveContext, io: ResolverIO): CopilotCliResolution {
  for (const strategy of STRATEGIES) {
    const r = strategy.resolve(ctx, io);
    if (r) return { source: strategy.source, entry: r.entry, version: r.version };
  }
  return notFound(io);
}

/** Real adapter: Node fs + spawnSync. `shell:true` on win32 resolves `.cmd`/`.ps1` shims for probes. */
export function createNodeResolverIO(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ResolverIO {
  return {
    platform,
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exec: (command, args) => {
      const r = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: platform === "win32",
        env,
      });
      if (r.error || r.status !== 0) return null;
      const out = (r.stdout ?? "").trim();
      return out.length > 0 ? out : null;
    },
  };
}
