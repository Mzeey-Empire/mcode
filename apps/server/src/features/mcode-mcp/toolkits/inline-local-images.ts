import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HTML_VISUAL_MAX_HTML_BYTES } from "@mcode/contracts";

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".svg", "image/svg+xml"], [".avif", "image/avif"], [".bmp", "image/bmp"], [".ico", "image/x-icon"],
]);
const MAX_INLINE_IMAGES = 64;

/** Filesystem boundary used to resolve and read local image references. */
export interface ImageFileReader {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Uint8Array>;
}

/** A page whose local image references have been replaced by data URIs. */
export interface InlinedHtml {
  readonly html: string;
  readonly count: number;
}

/** A local reference that could not be safely encoded. */
export interface ImageInlineFailure {
  readonly path: string;
  readonly reason: string;
}

/** Rejects the entire page while retaining all failing paths for the caller. */
export class ImageInlineError extends Error {
  constructor(readonly failures: readonly ImageInlineFailure[]) {
    super(failures.map((failure) => `Cannot inline ${failure.path}: ${failure.reason}`).join("\n"));
    this.name = "ImageInlineError";
  }
}

const REFERENCE_PATTERN = /(?:\b(?:src|href|xlink:href|poster)\s*=\s*(["'])(.*?)\1)|(?:\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\))/gi;

function referenceValue(groups: readonly (string | undefined)[]): string | undefined {
  return groups[1] ?? groups[2] ?? groups[3] ?? groups[4];
}

function localImageReferences(html: string): string[] {
  const references = new Set<string>();
  for (const match of html.matchAll(REFERENCE_PATTERN)) {
    const value = referenceValue(match.slice(1));
    if (value && isLocalImageReference(value)) references.add(value);
  }
  return [...references];
}

// Pages often carry absolute links and stylesheet paths that never load in the frame, so only image files are read.
function isLocalImageReference(value: string): boolean {
  const local = (value.startsWith("/") && !value.startsWith("//"))
    || value.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(value) || /^file:/i.test(value);
  return local && IMAGE_MIME_BY_EXTENSION.has(NodePath.extname(value).toLowerCase());
}

function replaceReferences(html: string, replacements: ReadonlyMap<string, string>): string {
  return html.replace(REFERENCE_PATTERN, (match: string, ...groups: (string | undefined)[]) => {
    const value = referenceValue(groups);
    const uri = value === undefined ? undefined : replacements.get(value);
    if (value === undefined || uri === undefined) return match;
    const at = match.lastIndexOf(value);
    return match.slice(0, at) + uri + match.slice(at + value.length);
  });
}

function localPath(reference: string): string {
  if (reference.startsWith("\\\\")) throw new Error("UNC paths are not supported");
  if (!/^file:/i.test(reference)) return reference;
  const url = new URL(reference);
  if (url.hostname || /^\/{2}|^\\\\/.test(decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:)/i, ""))) {
    throw new Error("UNC paths are not supported");
  }
  return NodeURL.fileURLToPath(url);
}

function matchesImage(extension: string, bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  const hex = buffer.subarray(0, 4).toString("hex");
  switch (extension) {
    case ".png": return hex === "89504e47";
    case ".jpg":
    case ".jpeg": return hex.startsWith("ffd8ff");
    case ".gif": return buffer.subarray(0, 4).toString("ascii") === "GIF8";
    case ".webp": return matchesWebp(buffer);
    case ".avif": return matchesAvif(buffer);
    case ".bmp": return buffer.subarray(0, 2).toString("ascii") === "BM";
    case ".ico": return hex === "00000100";
    case ".svg": return buffer.toString("utf8").includes("<svg");
    default: return false;
  }
}

function matchesWebp(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function matchesAvif(buffer: Buffer): boolean {
  return buffer.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(buffer.subarray(8, 32).toString("ascii"));
}

async function readImage(path: string, files: ImageFileReader, remaining: number, signal: AbortSignal): Promise<string> {
  const stat = await files.stat(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  const extension = NodePath.extname(path).toLowerCase();
  const mime = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (!mime) throw new Error("not a supported image type");
  if (stat.size > Math.floor(remaining * 3 / 4)) throw new Error("image is too large once encoded");
  signal.throwIfAborted();
  const bytes = await files.readFile(path);
  signal.throwIfAborted();
  if (!matchesImage(extension, bytes)) throw new Error(`content is not a ${extension} image`);
  const uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  if (uri.length > remaining) throw new Error("image is too large once encoded");
  return uri;
}

/** Inline bounded local images atomically, reporting every failing reference. */
export async function inlineLocalImages(html: string, files: ImageFileReader = NodeFSPromises, signal: AbortSignal): Promise<InlinedHtml> {
  const references = localImageReferences(html);
  if (references.length > MAX_INLINE_IMAGES) {
    throw new ImageInlineError(references.map((path) => ({ path, reason: `at most ${MAX_INLINE_IMAGES} distinct paths are allowed` })));
  }
  const failures: ImageInlineFailure[] = [];
  const images = new Map<string, string>();
  const replacements = new Map<string, string>();
  let remaining = HTML_VISUAL_MAX_HTML_BYTES;
  for (const reference of references) {
    signal.throwIfAborted();
    try {
      const real = await files.realpath(localPath(reference));
      let uri = images.get(real);
      if (!uri) {
        uri = await readImage(real, files, remaining, signal);
        images.set(real, uri);
        remaining -= uri.length;
      }
      replacements.set(reference, uri);
    } catch (error) {
      signal.throwIfAborted();
      failures.push({ path: reference, reason: error instanceof Error ? error.message : "image read failed" });
    }
  }
  if (failures.length) throw new ImageInlineError(failures);
  return { html: replaceReferences(html, replacements), count: images.size };
}
