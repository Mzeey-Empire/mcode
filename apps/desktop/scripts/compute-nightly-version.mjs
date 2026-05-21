/**
 * Compute the nightly desktop version string from the release-please manifest.
 *
 * Format: `${nextMinor}-nightly.${YYYYMMDD}.${runNumber}` where `nextMinor` is
 * the last stable's major.minor+1.0. The runNumber segment is clamped to 16
 * bits so Windows VERSIONINFO emission (electron-builder) never overflows.
 *
 * @param {{ manifest: Record<string, string>, runNumber: number, date: Date }} args
 * @returns {string}
 */
export function computeNightlyVersion({ manifest, runNumber, date }) {
  const base = manifest["."];
  if (typeof base !== "string") {
    throw new Error('manifest["."] is missing or not a string');
  }

  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match) {
    throw new Error(`manifest["."] is not plain semver: "${base}"`);
  }

  const [, majStr, minStr] = match;
  const major = Number(majStr);
  const minor = Number(minStr);
  const nextMinor = `${major}.${minor + 1}.0`;

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const day = `${y}${m}${d}`;

  // VERSIONINFO segments are 16-bit. Run numbers above 65535 wrap.
  const safeRun = runNumber % 65536;

  return `${nextMinor}-nightly.${day}.${safeRun}`;
}
