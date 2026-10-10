/** Rules for repository-relative paths that Mcode passes to git as literal pathspecs. */

const MAX_LITERAL_PATH_LENGTH = 4096;
const MAX_PATHS_PER_BATCH = 128;
// Leave room for quoting and separators within the Windows command-line limit.
const MAX_BATCH_CHARS = 20_000;

/**
 * True when `path` names something inside the repository. Absolute paths, parent escapes and
 * NUL bytes are refused because git would resolve them outside the checkout or split them.
 */
export function isLiteralRepoPath(path: string): boolean {
  return path.length > 0
    && path.length <= MAX_LITERAL_PATH_LENGTH
    && !path.includes("\0")
    && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
    && path !== ".."
    && !path.startsWith("../")
    && !path.startsWith("..\\");
}

/** Split paths into argument batches that fit one git command line as `:(literal)` pathspecs. */
export function batchLiteralPaths(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const path of paths) {
    const length = `:(literal)${path}`.length + 3;
    if (batch.length && (batch.length >= MAX_PATHS_PER_BATCH || chars + length > MAX_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(path);
    chars += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
