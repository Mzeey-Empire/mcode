import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

/**
 * Parses per-file patches into pierre FileDiffMetadata with stable object
 * identity. pierre's areDiffTargetsEqual treats two objects sharing a
 * cacheKey as one render target: handing a CodeView item a re-parsed copy of
 * the same patch under the same key lets its virtualizer commit a different
 * object than the prepared layout, which throws inside render. Reuse the
 * parsed object while the patch is unchanged, and give every fresh parse a
 * unique key so object identity and render-target identity stay equivalent.
 */
export class FileDiffCache {
  private readonly entries = new Map<string, { scope: string; patch: string; fileDiff: FileDiffMetadata }>();
  private serial = 0;

  /** Parse `patch` for `path`, reusing the previous result when nothing changed. */
  get(scope: string, path: string, patch: string): FileDiffMetadata | undefined {
    const cached = this.entries.get(path);
    if (cached && cached.scope === scope && cached.patch === patch) return cached.fileDiff;
    const fileDiff = parsePatchFiles(patch).flatMap((file) => file.files)[0];
    if (!fileDiff) return undefined;
    fileDiff.cacheKey = `${scope}:${path}:${++this.serial}`;
    this.entries.set(path, { scope, patch, fileDiff });
    return fileDiff;
  }
}
