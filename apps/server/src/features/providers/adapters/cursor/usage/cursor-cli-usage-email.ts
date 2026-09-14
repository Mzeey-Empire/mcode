/**
 * Derives the Cursor team member email used for Admin API usage lookups from the
 * Cursor CLI (`cursor-agent about --format json`) instead of a manual setting.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { z } from "zod";
import { logger } from "@mcode/shared";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Matches the usage source cache so the CLI is not spawned on every usage poll. */
const CACHE_TTL_MS = 15 * 60 * 1000;
/** Short timeout so a hung CLI can't block usage fetch. */
const ABOUT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const CursorAboutOutputSchema = z.object({
  userEmail: z.string().nullish(),
});

/** Options for constructing a Cursor CLI usage-email resolver. */
export interface CursorCliUsageEmailResolverOptions {
  /** Cursor CLI path, or a function that resolves it at fetch time. */
  cliPath: ResolvableCliPath;
  /** Optional execFile implementation used by tests. */
  execFileImpl?: typeof execFileAsync;
  /** Optional clock used for cache expiry tests. */
  now?: () => number;
  /** Host platform; injected so host facts are not read at module scope. */
  platform: NodeJS.Platform;
}

type ResolvableCliPath = string | (() => string | Promise<string>);

interface CacheEntry {
  cliPath: string;
  expiresAt: number;
  email: string | undefined;
}

/**
 * Resolves the caller's Cursor account email by shelling out to the Cursor CLI.
 * Returns undefined on any failure (missing binary, non-zero exit, invalid JSON,
 * null/empty userEmail) and caches the result for {@link CACHE_TTL_MS}.
 */
export class CursorCliUsageEmailResolver {
  private readonly execFileImpl: typeof execFileAsync;
  private readonly now: () => number;
  private cache: CacheEntry | null = null;
  private inFlight: { cliPath: string; promise: Promise<string | undefined> } | null = null;

  constructor(private readonly options: CursorCliUsageEmailResolverOptions) {
    this.execFileImpl = options.execFileImpl ?? execFileAsync;
    this.now = options.now ?? (() => Date.now());
  }

  /** Resolves the trimmed account email, or undefined when it cannot be determined. */
  async resolve(): Promise<string | undefined> {
    const cliPath = (await resolveCliPath(this.options.cliPath)).trim();
    if (!cliPath) return undefined;

    const cached = this.cache;
    if (cached && cached.cliPath === cliPath && cached.expiresAt > this.now()) {
      return cached.email;
    }

    if (this.inFlight?.cliPath === cliPath) return this.inFlight.promise;

    const promise = this.fetchEmail(cliPath)
      .then((email) => {
        this.cache = { cliPath, email, expiresAt: this.now() + CACHE_TTL_MS };
        return email;
      })
      .finally(() => {
        if (this.inFlight?.cliPath === cliPath) this.inFlight = null;
      });
    this.inFlight = { cliPath, promise };
    return promise;
  }

  private async fetchEmail(cliPath: string): Promise<string | undefined> {
    let stdout: string;
    try {
      const result = await this.execFileImpl(cliPath, ["about", "--format", "json"], {
        shell: this.options.platform === "win32",
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: ABOUT_TIMEOUT_MS,
      });
      stdout = String(result.stdout);
    } catch (error) {
      logger.warn("Cursor usage email unavailable", {
        reason: "cli_failed",
        error: error instanceof Error ? error.name : String(error),
      });
      return undefined;
    }

    let body: unknown;
    try {
      body = JSON.parse(stdout);
    } catch {
      logger.warn("Cursor usage email unavailable", { reason: "invalid_json" });
      return undefined;
    }

    const parsed = CursorAboutOutputSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("Cursor usage email unavailable", { reason: "invalid_shape" });
      return undefined;
    }

    const email = parsed.data.userEmail?.trim();
    return email ? email : undefined;
  }
}

async function resolveCliPath(value: ResolvableCliPath): Promise<string> {
  return typeof value === "function" ? value() : value;
}
