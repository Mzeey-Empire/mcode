import { z } from "zod";
import { logger } from "@mcode/shared";
import { isSemver } from "@mcode/providers";

const RELEASE = z.object({ version: z.string().refine(isSemver) });
const CACHE_MS = 24 * 60 * 60 * 1000;

/** Reads npm's latest release once a day per package, including unsuccessful checks. */
export class NpmReleaseFeed {
  private readonly cache = new Map<string, { expiresAt: number; result: Promise<string | null> }>();

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registry errors are deliberately invisible to the bell. Concurrent checks share the request. */
  latest(npmPackage: string): Promise<string | null> {
    const cached = this.cache.get(npmPackage);
    if (cached && this.now() < cached.expiresAt) return cached.result;
    const result = this.read(npmPackage);
    this.cache.set(npmPackage, { expiresAt: this.now() + CACHE_MS, result });
    return result;
  }

  private async read(npmPackage: string): Promise<string | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException("Registry deadline exceeded", "TimeoutError"));
      }, 5_000);
    });
    try {
      return await Promise.race([this.fetchVersion(npmPackage, controller.signal), deadline]);
    } catch (error) {
      logger.debug("Provider CLI registry check failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchVersion(npmPackage: string, signal: AbortSignal): Promise<string> {
    const response = await this.request(
      `https://registry.npmjs.org/${encodeURIComponent(npmPackage)}/latest`,
      { signal },
    );
    if (!response.ok) throw new Error("Registry request failed");
    return RELEASE.parse(await response.json()).version;
  }
}
