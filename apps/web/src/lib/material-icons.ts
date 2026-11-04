/**
 * File-type icons from Material Icon Theme, with a Lucide fallback.
 *
 * Only the theme's name lookup is bundled. SVGs load from jsDelivr on demand, so the
 * bundle never carries the theme's 1,200 icons.
 */
import type { LucideIcon } from "lucide-react";
import { fileExtensions, fileNames, light } from "material-icon-theme/dist/material-icons.json";
import { version } from "material-icon-theme/package.json";
import type { Appearance } from "@/hooks/useTheme";
import { getFileIcon } from "./file-icons";

// Pinned to the installed package so the name tables and the fetched SVGs never drift apart.
const CDN_BASE = `https://cdn.jsdelivr.net/npm/material-icon-theme@${version}/icons`;

type IconTable = Readonly<Record<string, string>>;

interface IconTables {
  readonly fileNames: IconTable;
  readonly fileExtensions: IconTable;
}

const DARK_TABLES: IconTables = { fileNames, fileExtensions };
const LIGHT_TABLES: IconTables = { fileNames: light.fileNames, fileExtensions: light.fileExtensions };

/** Icons that ship a `_light` twin because the default reads as white on a light surface. */
const LIGHT_ICON_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(LIGHT_TABLES.fileNames),
  ...Object.values(LIGHT_TABLES.fileExtensions),
]);

function lookup(table: keyof IconTables, key: string, appearance: Appearance): string | undefined {
  return (appearance === "light" ? LIGHT_TABLES[table][key] : undefined) ?? DARK_TABLES[table][key];
}

/**
 * Material icon name for a file, in VS Code's order: the exact file name, then the
 * longest dotted extension (`index.test.ts` tries `test.ts` before `ts`).
 * Returns null when the theme would draw its generic file icon.
 */
export function getIconName(fileName: string, appearance: Appearance): string | null {
  const name = fileName.toLowerCase();
  const byName = lookup("fileNames", name, appearance);
  if (byName) return byName;
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const byExtension = lookup("fileExtensions", name.slice(dot + 1), appearance);
    if (byExtension) return byExtension;
  }
  return null;
}

/** Get the jsDelivr CDN URL for a file's Material icon, or null when the theme has none. */
export function getIconUrl(fileName: string, appearance: Appearance): string | null {
  const iconName = getIconName(fileName, appearance);
  return iconName ? iconUrl(iconName) : null;
}

function iconUrl(iconName: string): string {
  return `${CDN_BASE}/${iconName}.svg`;
}

/** Icon resolved to either a fetched SVG blob URL or a Lucide fallback component. */
export type ResolvedIcon =
  | { readonly type: "image"; readonly url: string }
  | { readonly type: "lucide"; readonly icon: LucideIcon };

/** Blob URLs keyed by icon name, so every file that shares an icon shares one fetch. */
const blobCache = new Map<string, string>();

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

/** Resolve the icon for a file name: its Material icon when the CDN answers, otherwise a Lucide glyph. */
export async function resolveIcon(fileName: string, appearance: Appearance): Promise<ResolvedIcon> {
  const fallback = getFileIcon(fileName);
  const iconName = getIconName(fileName, appearance);
  if (!iconName) return { type: "lucide", icon: fallback };
  return resolveFromCdn(iconName, fallback);
}

/**
 * Resolve a Material icon by name, such as `bun`, using its `_light` twin on a light surface
 * when the theme has one. Returns `fallback` when the SVG cannot be loaded.
 */
export async function resolveIconByName(
  iconName: string,
  fallback: LucideIcon,
  appearance: Appearance,
): Promise<ResolvedIcon> {
  const lightName = `${iconName}_light`;
  const themedName = appearance === "light" && LIGHT_ICON_NAMES.has(lightName) ? lightName : iconName;
  return resolveFromCdn(themedName, fallback);
}

async function resolveFromCdn(iconName: string, fallback: LucideIcon): Promise<ResolvedIcon> {
  const cached = blobCache.get(iconName);
  if (cached) return { type: "image", url: cached };
  if (failedCache.has(iconName)) return { type: "lucide", icon: fallback };

  const inflight = inflightFetches.get(iconName);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<ResolvedIcon> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(iconUrl(iconName), { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`Unexpected MIME type: ${blob.type}`);
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(iconName, blobUrl);
      return { type: "image", url: blobUrl };
    } catch {
      failedCache.add(iconName);
      return { type: "lucide", icon: fallback };
    } finally {
      clearTimeout(timeout);
      inflightFetches.delete(iconName);
    }
  })();

  inflightFetches.set(iconName, fetchPromise);
  return fetchPromise;
}
