/**
 * VSCode icon resolver with Lucide fallback.
 *
 * Resolves file-type icons from the VSCode icons CDN (jsDelivr).
 * Falls back to Lucide icons for offline/unknown cases.
 */
import { getIconForFile } from "vscode-icons-js";
import { getFileIcon } from "./file-icons";
import type { LucideIcon } from "lucide-react";

const CDN_BASE = "https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons/icons";

/** Icon name returned by vscode-icons-js for unrecognized files. */
const DEFAULT_ICON = "default_file.svg";

/** Get the jsDelivr CDN URL for a file's VSCode icon, or null if unknown. */
export function getIconUrl(fileName: string): string | null {
  const iconName = getIconForFile(fileName);
  if (!iconName || iconName === DEFAULT_ICON) return null;
  return `${CDN_BASE}/${iconName}`;
}

/** Icon resolved to either a VSCode CDN blob URL or a Lucide fallback component. */
export type ResolvedIcon =
  | { readonly type: "vscode"; readonly url: string }
  | { readonly type: "lucide"; readonly icon: LucideIcon };

/** Cache for resolved icon blob URLs. */
const blobCache = new Map<string, string>();

/** Cache for failed lookups to avoid retrying. */
const failedCache = new Set<string>();

/** In-flight fetch deduplication: prevents N identical mentions from triggering N fetches. */
const inflightFetches = new Map<string, Promise<ResolvedIcon>>();

/** Clear all caches, revoking blob URLs to free memory. */
export function clearIconCache(): void {
  for (const url of blobCache.values()) {
    URL.revokeObjectURL(url);
  }
  blobCache.clear();
  failedCache.clear();
  inflightFetches.clear();
}

/**
 * Resolve the best icon for a filename.
 * Tries VSCode icon from CDN first, falls back to Lucide.
 */
export async function resolveIcon(fileName: string): Promise<ResolvedIcon> {
  return resolveFromCdn(fileName, getIconUrl(fileName), getFileIcon(fileName));
}

/**
 * Resolve a vscode-icons file by its exact name, such as `file_type_bun.svg`.
 * Shares the blob cache with {@link resolveIcon}; `fallback` renders when the CDN is unreachable.
 */
export async function resolveIconByName(iconName: string, fallback: LucideIcon): Promise<ResolvedIcon> {
  return resolveFromCdn(`icon:${iconName}`, `${CDN_BASE}/${iconName}`, fallback);
}

async function resolveFromCdn(cacheKey: string, cdnUrl: string | null, fallback: LucideIcon): Promise<ResolvedIcon> {
  const cached = blobCache.get(cacheKey);
  if (cached) return { type: "vscode", url: cached };

  if (failedCache.has(cacheKey) || !cdnUrl) {
    failedCache.add(cacheKey);
    return { type: "lucide", icon: fallback };
  }

  const inflight = inflightFetches.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<ResolvedIcon> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(cdnUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`Unexpected MIME type: ${blob.type}`);
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(cacheKey, blobUrl);
      return { type: "vscode", url: blobUrl };
    } catch {
      failedCache.add(cacheKey);
      return { type: "lucide", icon: fallback };
    } finally {
      clearTimeout(timeout);
      inflightFetches.delete(cacheKey);
    }
  })();

  inflightFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}
